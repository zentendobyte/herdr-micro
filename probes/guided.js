"use strict";
// Voice-guided, read-only input probe. Speaks each instruction, beeps, and records phase markers
// alongside every notification. Usage: node probes/guided.js
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WLDevice } = require("../../micro-manager-win/lib/device");

const PHASES = [
  ["dial-cw",        8, "Dial. Turn clockwise, three clicks."],
  ["dial-ccw",       8, "Dial. Turn counter clockwise, three clicks."],
  ["dial-click",     8, "Dial. Press and release the dial button, twice."],
  ["top-row",        8, "Top row. Press the left key, then the right key."],
  ["joy-up",         6, "Joystick. Push up, and release."],
  ["joy-right",      6, "Joystick. Push right, and release."],
  ["joy-down",       6, "Joystick. Push down, and release."],
  ["joy-left",       6, "Joystick. Push left, and release."],
  ["joy-circle-cw", 14, "Joystick. Push up, then slowly circle clockwise, one full turn, then release."],
  ["all-keys",      30, "All keys. Press every key left to right, one second each. Top row first, then row two, row three, and the bottom row: the wide key left end, the wide key right end, then the bottom right key."],
];

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `guided-${Date.now()}.jsonl`);
const t0 = Date.now();
const record = (kind, data) => fs.appendFileSync(file, JSON.stringify({ t: Date.now() - t0, kind, data }) + "\n");

function say(text) {
  const script = `[console]::beep(880,250); Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dev = new WLDevice();
  dev.connect();
  dev.on("notify", (m, p) => record("notify", { m, p }));
  dev.on("disconnect", (e) => record("disconnect", String(e)));
  try { record("status", await dev.call("device.status", null, 4000)); } catch (e) { record("status-error", e.message); }
  console.log(`guided probe -> ${file}`);
  say("Starting in ten seconds. Get ready.");
  await sleep(12000);
  for (const [name, seconds, text] of PHASES) {
    record("phase", name);
    console.log(`phase ${name} (${seconds}s): ${text}`);
    say(text);
    await sleep(seconds * 1000);
  }
  record("phase", "end");
  say("Done. Thank you.");
  await sleep(2500);
  dev.disconnect();
  console.log("done");
  process.exit(0);
})();
