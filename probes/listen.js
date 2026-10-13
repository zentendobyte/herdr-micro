"use strict";
// Read-only probe: opens the pad and records every message for N seconds.
// Writes nothing to the device (no lighting, no keymap). Usage: node probes/listen.js [seconds]
// Reuses the tested Micro 2 transport from ../micro-manager-win.
const fs = require("node:fs");
const path = require("node:path");
const { WLDevice } = require("../../micro-manager-win/lib/device");

const seconds = Number(process.argv[2] ?? 75);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `listen-${Date.now()}.jsonl`);
const t0 = Date.now();
const record = (kind, data) => fs.appendFileSync(file, JSON.stringify({ t: Date.now() - t0, kind, data }) + "\n");

const dev = new WLDevice();
dev.connect();
dev.on("notify", (m, p) => record("notify", { m, p }));
dev.on("log", (t) => record("log", t));
dev.on("foreign", (id) => record("foreign", id));
dev.on("disconnect", (e) => record("disconnect", String(e)));

(async () => {
  try { record("status", await dev.call("device.status", null, 4000)); } catch (e) { record("status-error", e.message); }
  console.log(`listening ${seconds}s -> ${file}`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  dev.disconnect();
  console.log("done");
  process.exit(0);
})();
