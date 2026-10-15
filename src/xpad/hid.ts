// Finds and holds the XPAD Mini's vendor HID collections, re-opening them when
// the pad is unplugged and replugged. Ported from SpinnerMaster's
// xpad-mini-claude-code (MIT, see NOTICE.md).
import { EventEmitter } from "node:events";
import HID from "node-hid";

export const XPAD_VID = 0x3710;
export const XPAD_PID = 0x2507;

// Vendor collections on interface 1.
const USAGE_PAGE_CONFIG = 0xff00;
const USAGE_PAGE_BULK = 0xff12; // the 1024-byte fast channel everything uses

const RECONNECT_POLL_MS = 3000;

/** Emits "connect" and "disconnect". */
export class XpadDevice extends EventEmitter {
  private configChannel: HID.HID | null = null;
  private bulkChannel: HID.HID | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  get connected(): boolean {
    return this.isConnected;
  }

  get bulk(): HID.HID | null {
    return this.bulkChannel;
  }

  start(): void {
    this.tryOpen();
    this.pollTimer = setInterval(() => {
      if (!this.isConnected) this.tryOpen();
    }, RECONNECT_POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.closeAll();
  }

  private tryOpen(): void {
    let infos: HID.Device[];
    try {
      infos = HID.devices().filter(
        (d) => d.vendorId === XPAD_VID && d.productId === XPAD_PID,
      );
    } catch {
      return;
    }
    if (infos.length === 0) return;

    const open = (page: number): HID.HID | null => {
      const info = infos.find((d) => d.usagePage === page);
      if (!info?.path) return null;
      try {
        const dev = new HID.HID(info.path);
        dev.on("error", () => this.onError());
        return dev;
      } catch {
        return null;
      }
    };

    const config = open(USAGE_PAGE_CONFIG);
    const bulk = open(USAGE_PAGE_BULK);
    if (!config || !bulk) {
      // Both are needed; do not hold a half-open pad.
      for (const dev of [config, bulk]) {
        try {
          dev?.close();
        } catch {
          // already closed
        }
      }
      return;
    }
    this.configChannel = config;
    this.bulkChannel = bulk;
    this.isConnected = true;
    this.emit("connect");
  }

  private onError(): void {
    if (!this.isConnected) return;
    this.closeAll();
    this.emit("disconnect");
  }

  private closeAll(): void {
    this.isConnected = false;
    for (const dev of [this.configChannel, this.bulkChannel]) {
      try {
        dev?.close();
      } catch {
        // already closed
      }
    }
    this.configChannel = null;
    this.bulkChannel = null;
  }
}
