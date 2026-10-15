// The daemon's handle on the XPAD Mini worker: starts and stops it, forwards
// what the pad should show, and reports whether the pad is connected.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { WorkerIn, WorkerStatus } from "./worker.js";
import type { XpadArt, XpadView } from "./view.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const ASSET_DIRS: Record<XpadArt, string> = {
  clawd: path.join(ASSETS, "xpad-clawd"),
  pixel: path.join(ASSETS, "xpad-pixel"),
};
const RESTART_DELAY_MS = 5000;

export class XpadHost {
  private worker: Worker | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private view: XpadView = { state: "idle", keys: null };
  private brightness = 1;
  private art: XpadArt = "clawd";
  private status: WorkerStatus = { type: "status", connected: false, ready: false };

  constructor(
    private log: (message: string) => void,
    private onStatusChange: () => void = () => {},
  ) {}

  get running(): boolean {
    return this.worker !== null;
  }

  get connected(): boolean {
    return this.worker !== null && this.status.connected;
  }

  start(): void {
    if (this.worker) return;
    const worker = new Worker(
      new URL("./worker.js", import.meta.url),
      { workerData: { assetDirs: ASSET_DIRS } },
    );
    this.worker = worker;
    worker.on("message", (msg: WorkerStatus) => {
      if (msg.type !== "status") return;
      const changed = msg.connected !== this.status.connected;
      this.status = msg;
      if (changed) {
        this.log(`xpad mini ${msg.connected ? "connected" : "disconnected"}`);
        this.onStatusChange();
      }
    });
    worker.on("error", (error) => this.log(`xpad worker error: ${error.message}`));
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      // Died on its own (not through stop()): bring it back.
      this.worker = null;
      this.status = { type: "status", connected: false, ready: false };
      this.onStatusChange();
      this.log("xpad worker exited, restarting");
      this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    });
    this.send({ type: "brightness", value: this.brightness });
    this.send({ type: "art", art: this.art });
    this.send({ type: "view", view: this.view });
  }

  /** Asks the worker to darken the pad, then lets it exit. */
  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.status = { type: "status", connected: false, ready: false };
    worker.postMessage({ type: "shutdown" } satisfies WorkerIn);
    // Backstop: never let a stuck HID write keep the daemon alive.
    setTimeout(() => void worker.terminate(), 1500).unref();
  }

  setView(view: XpadView): void {
    this.view = view;
    this.send({ type: "view", view });
  }

  setArt(art: XpadArt): void {
    this.art = art;
    this.send({ type: "art", art });
  }

  setBrightness(percent: number): void {
    this.brightness = percent / 100;
    this.send({ type: "brightness", value: this.brightness });
  }

  private send(message: WorkerIn): void {
    this.worker?.postMessage(message);
  }
}
