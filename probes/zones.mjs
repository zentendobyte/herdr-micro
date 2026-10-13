// Lights each firmware lighting zone on its own, with voice cues, so a human can say which physical LEDs it is.
// Writes lighting only (no keymap). Leaves both zones off at the end. Usage: node probes/zones.mjs
import { spawn } from "node:child_process";
import { MicroDevice } from "../dist/device.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function say(text) {
  const script = `[console]::beep(880,250); Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}
const zone = (c, on) => ({ e: on ? 1 : 0, b: on ? 1 : 0, s: 0.5, m: 1, c });
const off = zone(0, false);

const device = new MicroDevice({ onConnect() {}, onDisconnect() {}, onStateChange() {}, onHid() {}, onJoystick() {} }, () => {});
device.start();
for (let i = 0; i < 80 && !device.connected; i++) await sleep(100);
if (!device.connected) throw new Error("pad not connected");

say("Zone A, red. Watch which lights come on.");
await device.call("v.oai.rgbcfg", { keys: zone(0xff0000, true), ambient: off });
await sleep(7000);
say("Zone B, blue. Watch which lights come on.");
await device.call("v.oai.rgbcfg", { keys: off, ambient: zone(0x0000ff, true) });
await sleep(7000);
say("Both zones, green.");
await device.call("v.oai.rgbcfg", { keys: zone(0x00ff00, true), ambient: zone(0x00ff00, true) });
await sleep(5000);
await device.call("v.oai.rgbcfg", { keys: off, ambient: off });
say("Done.");
await sleep(1500);
await device.stop();
console.log("done");
process.exit(0);
