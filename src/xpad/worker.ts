// Worker thread that owns all XPAD Mini HID traffic and animation timing. The
// LED and LCD writes block, so they run here and the daemon's Herdr and Micro 2
// handling is never stalled by them.
import { parentPort, workerData } from "node:worker_threads";
import { XpadDevice } from "./hid.js";
import { renderLeds } from "./leds.js";
import { LcdEngine } from "./lcd.js";
import { LED_COUNT, LCD_HEIGHT, LCD_WIDTH, XpadProtocol } from "./protocol.js";
import type { XpadArt, XpadView } from "./view.js";

export type WorkerIn =
  | { type: "view"; view: XpadView }
  | { type: "brightness"; value: number }
  | { type: "art"; art: XpadArt }
  | { type: "shutdown" };

export interface WorkerStatus {
  type: "status";
  connected: boolean;
  ready: boolean;
}

// 20 Hz is smooth with the interpolated dot and keeps packet pressure low;
// heavy streaming delays the firmware's own key reporting.
const FPS = 20;

const port = parentPort;
if (!port) throw new Error("xpad worker must run in a worker thread");
const { assetDirs } = workerData as { assetDirs: Record<XpadArt, string> };

const device = new XpadDevice();
const protocol = new XpadProtocol(device);
const lcd = new LcdEngine(protocol, assetDirs);

let view: XpadView = { state: "idle", keys: null };
let viewSince = Date.now();
let brightness = 1;

const ledTimer = setInterval(() => {
  const t = (Date.now() - viewSince) / 1000;
  protocol.setLeds(renderLeds(view, t, brightness));
}, 1000 / FPS);

let lastStatus = "";
function reportStatus(): void {
  const status: WorkerStatus = {
    type: "status",
    connected: device.connected,
    ready: protocol.ready,
  };
  const key = JSON.stringify(status);
  if (key === lastStatus) return;
  lastStatus = key;
  port!.postMessage(status);
}
device.on("connect", reportStatus);
device.on("disconnect", reportStatus);
// protocol.ready flips asynchronously after ScreenInfo, so poll cheaply.
const statusTimer = setInterval(reportStatus, 500);

port.on("message", (msg: WorkerIn) => {
  switch (msg.type) {
    case "view":
      if (JSON.stringify(msg.view) !== JSON.stringify(view)) {
        if (msg.view.state !== view.state) viewSince = Date.now();
        view = msg.view;
        lcd.setState(view.state);
      }
      break;
    case "art":
      lcd.setArt(msg.art);
      break;
    case "brightness":
      brightness = Math.max(0, Math.min(1, msg.value));
      break;
    case "shutdown":
      void shutdown();
  }
});

// Leaves the pad dark instead of frozen on the last frame. The firmware's own
// screen and effects stay suppressed until replug, so dark is the cleanest
// hand-off possible without flash writes.
async function shutdown(): Promise<void> {
  clearInterval(ledTimer);
  clearInterval(statusTimer);
  lcd.stop();
  try {
    protocol.setLeds(Array(LED_COUNT).fill({ r: 0, g: 0, b: 0 }));
    await protocol.drawLcdFrame(Buffer.alloc(LCD_WIDTH * LCD_HEIGHT * 2));
  } catch {
    // The pad may already be gone.
  }
  device.stop();
  process.exit(0);
}

lcd.loadAssets();
device.start();
lcd.start();
reportStatus();
