// Connection to the physical Creator Micro 2: discovery, vendor RPC with
// request/response, notifications, and reconnect. Other hosts (the Work Louder
// Input app, the Codex desktop app) may hold the pad, so open failures are
// expected and retried.
import { HIDAsync, devicesAsync, type Device } from "node-hid";
import { CHANNEL_RPC, Reassembler, encodeMessage } from "./framing.js";

export const VENDOR_ID = 0x303a;
export const PRODUCT_ID = 0x8298;
export const USAGE_PAGE = 0xff00;
export const USAGE = 1;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_JITTER_MS = 5000;
const CALL_TIMEOUT_MS = 8000;

export interface ThreadLighting {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
}

export interface LightingSide {
  e: number;
  b: number;
  s: number;
  /** The vendor schema's "magic" parameter; the firmware expects it present. */
  m: number;
  c: number;
}

export type DeviceState =
  | "connected"
  | "connecting"
  | "device_absent"
  | "permission_required"
  | "device_busy"
  | "stopped";

export interface DeviceHandlers {
  onConnect(): void;
  onDisconnect(): void;
  onStateChange(): void;
  onHid(key: string, act: number): void;
  onJoystick(angle: number, distance: number): void;
  /** A reply to a request id this process never issued: another app is on the pad. */
  onForeign?(id: number): void;
}

export function classifyOpenError(message: string): DeviceState {
  if (message.includes("device not found")) return "device_absent";
  if (/sharing violation|exclusive|in use|busy/i.test(message)) {
    return "device_busy";
  }
  return "connecting";
}

export async function findCandidates(): Promise<Device[]> {
  const devices = await devicesAsync();
  return devices.filter(
    (d) =>
      d.vendorId === VENDOR_ID &&
      d.productId === PRODUCT_ID &&
      d.usagePage === USAGE_PAGE &&
      d.usage === USAGE &&
      d.path,
  );
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class MicroDevice {
  private device: HIDAsync | null = null;
  private reassembler = new Reassembler();
  private generation = 0;
  private stopped = false;
  private connecting = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentState: DeviceState = "stopped";
  private lastOpenFailure = "";
  private pending = new Map<number, Pending>();
  // Random start: other hosts on the pad (and the doctor) count from 1 too.
  private nextId = Math.floor(Math.random() * 999);

  constructor(
    private handlers: DeviceHandlers,
    private log: (message: string) => void,
  ) {}

  get connected(): boolean {
    return this.device !== null;
  }

  get state(): DeviceState {
    return this.currentState;
  }

  private setState(state: DeviceState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.handlers.onStateChange();
  }

  // Idempotent: calling it while connected or already connecting is a no-op.
  start(): void {
    if (!this.stopped && (this.device || this.connecting)) return;
    this.stopped = false;
    this.clearRetry();
    this.setState("connecting");
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearRetry();
    await this.disconnect();
    this.setState("stopped");
  }

  // The firmware rejects ids >= 1000.
  private allocateId(): number {
    for (let i = 0; i < 999; i++) {
      this.nextId = (this.nextId % 999) + 1;
      if (!this.pending.has(this.nextId)) return this.nextId;
    }
    throw new Error("too many calls in flight");
  }

  // Request/response. Writes are serialized through a queue so concurrent
  // callers cannot interleave multi-report frames.
  call(
    method: string,
    params: unknown = null,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    // Bind to the handle that was live when the call was made: a frame composed
    // for the old connection must not be delivered on a new one.
    const target = this.device;
    const generation = this.generation;
    if (!target) return Promise.reject(new Error("device not connected"));
    const id = this.allocateId();
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A frame still half-open when a call times out has lost a report;
        // forget it so later replies are not glued onto it.
        this.reassembler.reset();
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    const message = JSON.stringify({ method, params, id });
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (this.device !== target || this.generation !== generation) {
          throw new Error("device not connected");
        }
        for (const report of encodeMessage(message)) await target.write(report);
      })
      .catch((error: Error) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        waiting.reject(error);
      });
    return reply;
  }

  async setThreadLighting(slots: ThreadLighting[]): Promise<void> {
    await this.call("v.oai.thstatus", slots);
  }

  // Ambient ring; the keys side stays off (thread lighting renders the keys).
  async setAmbientLighting(ambient: LightingSide): Promise<void> {
    await this.call("v.oai.rgbcfg", {
      ambient,
      keys: { e: 0, b: 0, s: 0, m: 0, c: 0 },
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.device || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const candidates = await findCandidates();
      if (candidates.length === 0) throw new Error("device not found");
      let opened: HIDAsync | null = null;
      let lastError: Error | null = null;
      for (const info of candidates) {
        try {
          opened = await HIDAsync.open(info.path!, { nonExclusive: true });
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }
      if (!opened) throw lastError ?? new Error("no candidate opened");
      if (this.stopped || this.generation !== generation) {
        await opened.close().catch(() => {});
        return;
      }
      opened.on("data", (data: Buffer) => this.onData(data));
      opened.on("error", (error: Error) => {
        this.log(`device error: ${error.message}`);
        void this.dropAndRetry();
      });
      this.device = opened;
      this.lastOpenFailure = "";
      this.setState("connected");
      this.log("device connected");
      this.handlers.onConnect();
    } catch (error) {
      // A failure from a superseded attempt must not overwrite the live state.
      if (this.stopped || this.generation !== generation) return;
      const message = (error as Error).message;
      // The absent-device retry runs forever; log each distinct failure once.
      if (message !== this.lastOpenFailure) {
        this.lastOpenFailure = message;
        this.log(`device open failed: ${message}`);
      }
      this.setState(classifyOpenError(message));
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = RECONNECT_MIN_MS + Math.random() * RECONNECT_JITTER_MS;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private async dropAndRetry(): Promise<void> {
    await this.disconnect();
    if (this.stopped) return;
    this.setState("connecting");
    this.scheduleRetry();
  }

  private rejectAll(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  // Fires onDisconnect exactly once per live handle that goes away.
  private async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.reassembler.reset();
    this.rejectAll(new Error("disconnected"));
    if (!device) return;
    device.removeAllListeners("data");
    device.removeAllListeners("error");
    await device.close().catch(() => {});
    this.handlers.onDisconnect();
  }

  private onData(data: Buffer): void {
    for (const { channel, message } of this.reassembler.push(data)) {
      if (channel !== CHANNEL_RPC) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Responses carry the request id (and echo `method`); notifications use
      // the compact {m, p} envelope with no id.
      if (typeof parsed.id === "number") {
        const waiting = this.pending.get(parsed.id);
        // Handles are shared with other hosts. A reply that carries our id but
        // echoes a different method belongs to someone else's request.
        const echoed = parsed.method;
        if (waiting && typeof echoed === "string" && echoed !== waiting.method) {
          this.handlers.onForeign?.(parsed.id);
          continue;
        }
        if (!waiting) {
          this.handlers.onForeign?.(parsed.id);
          continue;
        }
        this.pending.delete(parsed.id);
        clearTimeout(waiting.timer);
        const error = parsed.error as { message?: string } | undefined;
        if (error) waiting.reject(new Error(error.message ?? "rpc error"));
        else waiting.resolve(parsed.result);
        continue;
      }
      const method = (parsed.m ?? parsed.method) as string | undefined;
      const params = (parsed.p ?? parsed.params) as
        Record<string, unknown> | undefined;
      if (!params) continue;
      if (method === "v.oai.hid") {
        this.handlers.onHid(String(params.k ?? ""), Number(params.act ?? 0));
      } else if (method === "kb.radial" || method === "v.oai.rad") {
        // Firmware 0.6.3 sends the stick as kb.radial; older builds v.oai.rad.
        this.handlers.onJoystick(Number(params.a ?? 0), Number(params.d ?? 0));
      }
    }
  }
}
