// Sayo "API v2" protocol for the Pulsar XPAD Mini (SayoDevice firmware).
// Ported from SpinnerMaster's xpad-mini-claude-code (MIT, see NOTICE.md);
// only the LED and LCD commands are kept. Every write goes to device RAM:
// no Save command is ever sent, so unplugging restores the factory behavior.
//
// Packet (1024 bytes, fast channel usage page 0xFF12):
//   [0] report id 0x22   [1] echo   [2:4] checksum u16 LE
//   [4:6] length u16 LE = payload + 4   [6] command   [7] index   [8..] payload
import type { XpadDevice } from "./hid.js";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const LCD_WIDTH = 240;
export const LCD_HEIGHT = 135; // firmware-reported; marketing says 136
export const LED_COUNT = 13;

const PACKET_SIZE = 1024;
const REPORT_ID = 0x22;
const ECHO = 0x04;
const CMD_SCREEN_INFO = 0x02;
const CMD_DISPLAY = 0x25; // framebuffer write, RGB565 LE, u32 byte offset
const CMD_LED_COLORS = 0x27; // exactly 13 x [R,G,B,0]

export function buildPacket(cmd: number, payload: Buffer, index = 0): Buffer {
  const buf = Buffer.alloc(PACKET_SIZE);
  buf[0] = REPORT_ID;
  buf[1] = ECHO;
  buf.writeUInt16LE(payload.length + 4, 4);
  buf[6] = cmd;
  buf[7] = index;
  payload.copy(buf, 8);
  const used = 8 + payload.length + (payload.length % 2);
  let sum = 0;
  for (let i = 0; i < used; i += 2) sum = (sum + buf.readUInt16LE(i)) & 0xffff;
  buf.writeUInt16LE(sum, 2);
  return buf;
}

export function ledPayload(colors: Rgb[]): Buffer {
  const payload = Buffer.alloc(LED_COUNT * 4);
  for (let i = 0; i < LED_COUNT; i++) {
    const c = colors[i] ?? { r: 0, g: 0, b: 0 };
    payload[i * 4] = c.r;
    payload[i * 4 + 1] = c.g;
    payload[i * 4 + 2] = c.b;
  }
  return payload;
}

export class XpadProtocol {
  private isReady = false;
  private lastError = 0;
  private lastLedPayload: Buffer | null = null;
  private lastFrame: Buffer | null = null;
  private framesUntilFull = 0;
  private lastLcdWrite = 0;

  constructor(private device: XpadDevice) {
    device.on("connect", () => {
      this.resetCaches();
      void this.verify();
    });
    device.on("disconnect", () => {
      this.isReady = false;
      this.resetCaches();
    });
  }

  get ready(): boolean {
    return this.isReady;
  }

  private resetCaches(): void {
    this.lastFrame = null;
    this.lastLedPayload = null;
  }

  /** Confirms the pad speaks the protocol by requesting ScreenInfo. */
  private async verify(): Promise<void> {
    const dev = this.device.bulk;
    if (!dev) return;
    try {
      const onData = (data: Buffer) => {
        if (data[0] !== REPORT_ID || data[6] !== CMD_SCREEN_INFO) return;
        this.isReady = true;
        dev.removeListener("data", onData);
      };
      dev.on("data", onData);
      dev.write(buildPacket(CMD_SCREEN_INFO, Buffer.alloc(0)));
      setTimeout(() => dev.removeListener("data", onData), 2000);
    } catch {
      // The next reconnect tries again.
    }
  }

  /**
   * Sets all 13 LEDs: 0-2 are the key LEDs (left, center, right), 3-12 the
   * light bar running right to left. Unchanged frames are skipped; every
   * needless packet is firmware time not spent scanning keys.
   */
  setLeds(colors: Rgb[]): void {
    const dev = this.device.bulk;
    if (!dev) return;
    const payload = ledPayload(colors);
    if (this.lastLedPayload?.equals(payload)) return;
    this.lastLedPayload = this.tryWrite(
      dev,
      buildPacket(CMD_LED_COLORS, payload),
      "setLeds",
    )
      ? payload
      : null;
  }

  /**
   * Streams one LCD frame (240x135 RGB565-LE). Only chunks that differ from
   * the previous frame are sent, with a full refresh now and then to heal
   * dropped packets. Yields between chunks so the LED ticker keeps its cadence.
   */
  async drawLcdFrame(rgb565: Buffer): Promise<void> {
    const dev = this.device.bulk;
    if (!dev) return;
    const chunk = PACKET_SIZE - 12;
    const force = this.lastFrame === null || this.framesUntilFull <= 0;
    // Full refreshes are 65-packet bursts that delay the firmware's key
    // reporting, so they are rare; errors force one immediately anyway.
    this.framesUntilFull = force ? 300 : this.framesUntilFull - 1;

    let sent = 0;
    for (let off = 0; off < rgb565.length; off += chunk) {
      const n = Math.min(chunk, rgb565.length - off);
      if (
        !force &&
        this.lastFrame &&
        rgb565.compare(this.lastFrame, off, off + n, off, off + n) === 0
      ) {
        continue;
      }
      const payload = Buffer.alloc(4 + n);
      payload.writeUInt32LE(off, 0);
      rgb565.copy(payload, 4, off, off + n);
      if (!this.tryWrite(dev, buildPacket(CMD_DISPLAY, payload), "drawLcdFrame")) {
        this.lastFrame = null;
        return;
      }
      // Pause briefly every few packets so the firmware's key scanner is not
      // starved by a long write burst.
      if (++sent % 6 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (sent === 0 && Date.now() - this.lastLcdWrite > 250) {
      // The firmware's own UI redraws after ~0.5 s without display traffic;
      // one small chunk keeps it suppressed during long frame holds.
      const n = Math.min(chunk, rgb565.length);
      const payload = Buffer.alloc(4 + n);
      rgb565.copy(payload, 4, 0, n);
      sent = this.tryWrite(dev, buildPacket(CMD_DISPLAY, payload), "lcdKeepAlive")
        ? 1
        : 0;
    }
    if (sent > 0) this.lastLcdWrite = Date.now();
    this.lastFrame = rgb565;
  }

  private tryWrite(
    dev: NonNullable<XpadDevice["bulk"]>,
    packet: Buffer,
    what: string,
  ): boolean {
    try {
      dev.write(packet);
      return true;
    } catch (error) {
      // Throttled: a 20 Hz ticker would spam during an unplug.
      const now = Date.now();
      if (now - this.lastError > 5000) {
        this.lastError = now;
        console.error(`[xpad] ${what} write failed: ${(error as Error).message}`);
      }
      return false;
    }
  }
}
