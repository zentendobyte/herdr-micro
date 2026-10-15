// Local control protocol between the daemon and its helpers (popup, ctl):
// newline JSON over a unix socket in the state dir. Commands: status, watch,
// toggle-policy, stop. The socket doubles as the single-instance lock.
import net from "node:net";
import { CONTROL_SOCKET } from "./config.js";
import { connect, readLines, requestLine } from "./socket.js";
import type { DeviceState } from "./device.js";
import type { DialMode } from "./dial.js";
import type { BottomRows, LightingProfile } from "./lights.js";
import type { XpadArt, XpadMode } from "./xpad/view.js";
import type { AgentStatus, Policy } from "./slots.js";

const WATCH_RECONNECT_MS = 1000;

/** Device ownership; 'yielded' = another app has the pad, 'paused' = pad is on another layer. */
export type ControlState = DeviceState | "yielded" | "paused";

export interface SlotStatus {
  key: number;
  paneId: string;
  agent: string;
  paneName: string | null;
  workspace: string;
  tab: string;
  cwd: string;
  status: AgentStatus;
}

export interface StatusPayload {
  policy: Policy;
  scrollSteps: number;
  dialMode: DialMode;
  dialModeOrder: DialMode[];
  state: ControlState;
  herdrConnected: boolean;
  lightingProfile: LightingProfile;
  brightness: number;
  bottomRows: BottomRows;
  bottomColor: number;
  xpadMode: XpadMode;
  xpadConnected: boolean;
  xpadArt: XpadArt;
  configError: string | null;
  slots: (SlotStatus | null)[];
}

export interface ControlHandlers {
  status(): StatusPayload;
  togglePolicy(): Policy;
  /** Throws a readable Error for anything but 1, 2 or 3. */
  setLightingProfile(profile: unknown): LightingProfile;
  /** Throws a readable Error for anything but 10 to 100. */
  setBrightness(percent: unknown): number;
  /** Sets the bottom-row mode and/or solid colour; throws a readable Error on bad input. */
  setBottom(mode: unknown, color: unknown): { bottomRows: BottomRows; bottomColor: number };
  /** Throws a readable Error for anything but off, worst, focused or per-key. */
  setXpadMode(mode: unknown): XpadMode;
  setXpadArt(art: unknown): XpadArt;
  /** Re-binds the keymap if it drifted and re-sends all lighting. */
  repush(): Promise<void>;
  popup(): void;
  stop(): void;
  /** Restores the original layer-1 keymap, then the daemon exits. */
  restoreKeymap(): Promise<void>;
  /** Fires when the first watcher arrives, so the daemon can enrich status. */
  watchersChanged(): void;
}

export class ControlServer {
  private server: net.Server | null = null;
  private watchers = new Set<net.Socket>();

  constructor(private handlers: ControlHandlers) {}

  get hasWatchers(): boolean {
    return this.watchers.size > 0;
  }

  // The pipe name is the single-instance lock: EADDRINUSE means another
  // process owns it. Pipes vanish with their process, so there is never a
  // stale file to unlink.
  async listen(): Promise<void> {
    this.createServer();
    try {
      await this.bind();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await daemonAlive()) {
        throw new Error("another daemon instance is running");
      }
      throw new Error("the control pipe is held by an unresponsive process");
    }
  }

  private bind(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.server!;
      // Both listeners are one-shot and must be torn down together: leaving
      // the error listener attached would let it swallow the first real
      // server error after a successful bind.
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(CONTROL_SOCKET);
    });
  }

  private createServer(): void {
    this.server = net.createServer((socket) => {
      readLines(socket, (line) => this.handle(socket, line));
      socket.on("close", () => this.watchers.delete(socket));
      socket.on("error", () => this.watchers.delete(socket));
    });
  }

  broadcast(): void {
    if (this.watchers.size === 0) return;
    const line = JSON.stringify(this.handlers.status()) + "\n";
    for (const watcher of this.watchers) watcher.write(line);
  }

  close(): void {
    this.server?.close();
  }

  private handle(socket: net.Socket, line: string): void {
    let cmd: string;
    let request: { cmd?: string; profile?: unknown; percent?: unknown; mode?: unknown; color?: unknown; art?: unknown };
    try {
      request = JSON.parse(line) as {
        cmd?: string;
        profile?: unknown;
        percent?: unknown;
        mode?: unknown;
        color?: unknown;
        art?: unknown;
      };
      cmd = String(request.cmd ?? "");
    } catch {
      socket.write(JSON.stringify({ error: "invalid_request" }) + "\n");
      return;
    }
    try {
      if (cmd === "status") {
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
      } else if (cmd === "watch") {
        const first = this.watchers.size === 0;
        this.watchers.add(socket);
        socket.write(JSON.stringify(this.handlers.status()) + "\n");
        if (first) this.handlers.watchersChanged();
      } else if (cmd === "toggle-policy") {
        const policy = this.handlers.togglePolicy();
        socket.write(JSON.stringify({ policy }) + "\n");
      } else if (cmd === "popup") {
        this.handlers.popup();
        socket.write(JSON.stringify({ ok: true }) + "\n");
      } else if (cmd === "set-lighting") {
        const lightingProfile = this.handlers.setLightingProfile(request.profile);
        socket.write(JSON.stringify({ lightingProfile }) + "\n");
      } else if (cmd === "set-brightness") {
        const brightness = this.handlers.setBrightness(request.percent);
        socket.write(JSON.stringify({ brightness }) + "\n");
      } else if (cmd === "set-bottom") {
        const result = this.handlers.setBottom(request.mode, request.color);
        socket.write(JSON.stringify(result) + "\n");
      } else if (cmd === "set-xpad") {
        const xpadMode = this.handlers.setXpadMode(request.mode);
        socket.write(JSON.stringify({ xpadMode }) + "\n");
      } else if (cmd === "set-xpad-art") {
        const xpadArt = this.handlers.setXpadArt(request.art);
        socket.write(JSON.stringify({ xpadArt }) + "\n");
      } else if (cmd === "repush") {
        this.handlers.repush().then(
          () => socket.end(JSON.stringify({ ok: true }) + "\n"),
          (error: Error) =>
            socket.end(JSON.stringify({ error: error.message }) + "\n"),
        );
      } else if (cmd === "restore-keymap") {
        this.handlers.restoreKeymap().then(
          () => socket.end(JSON.stringify({ ok: true }) + "\n"),
          (error: Error) =>
            socket.end(JSON.stringify({ error: error.message }) + "\n"),
        );
      } else if (cmd === "stop") {
        // end() flushes the reply before shutdown races process exit.
        socket.end(JSON.stringify({ stopping: true }) + "\n");
        this.handlers.stop();
      } else {
        // Always answer: an unanswered command would strand the caller until
        // its request deadline.
        socket.write(
          JSON.stringify({ error: `unknown command: ${cmd}` }) + "\n",
        );
      }
    } catch (error) {
      socket.write(JSON.stringify({ error: (error as Error).message }) + "\n");
    }
  }
}

export async function sendCommand(
  cmd: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const socket = await connect(CONTROL_SOCKET);
  const line = await requestLine(socket, JSON.stringify({ cmd, ...extra }));
  return JSON.parse(line) as Record<string, unknown>;
}

// Follows daemon status, reconnecting across daemon restarts: a restart is a
// gap to render, not a reason to tear the viewer down. onDisconnect fires on
// each drop, before the next reconnect attempt.
export function watchStatus(
  onStatus: (status: StatusPayload) => void,
  onDisconnect: () => void,
): { stop: () => void } {
  let socket: net.Socket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    const next = net.createConnection(CONTROL_SOCKET);
    socket = next;
    readLines(next, (line) => {
      try {
        onStatus(JSON.parse(line) as StatusPayload);
      } catch {
        // ignore malformed lines
      }
    });
    next.on("close", () => {
      if (stopped || socket !== next) return;
      onDisconnect();
      retryTimer = setTimeout(open, WATCH_RECONNECT_MS);
    });
    next.on("error", () => {});
    next.write(JSON.stringify({ cmd: "watch" }) + "\n");
  };

  open();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.destroy();
    },
  };
}

export async function daemonAlive(): Promise<boolean> {
  try {
    await sendCommand("status");
    return true;
  } catch {
    return false;
  }
}
