// Maintainer tool: regenerates assets/xpad-pixel from KebeliSamet0/clawd's GIFs
// (the committed frames are the result; nothing runs this at install time).
//   node dist/build-pixel-art.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { gifToFrames } from "./xpad/gif.js";
import { LCD_HEIGHT, LCD_WIDTH } from "./xpad/protocol.js";

const BASE = "https://raw.githubusercontent.com/KebeliSamet0/clawd/master/assets/gif/";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "xpad-pixel");
// Animation name used by the LCD engine -> source GIF.
const SOURCES: Record<string, string> = {
  sleeping: "clawd-sleeping.gif",
  working: "clawd-typing.gif",
  alert: "clawd-notification.gif",
  happy: "clawd-happy.gif",
};

for (const [name, file] of Object.entries(SOURCES)) {
  const response = await fetch(BASE + file);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const { frames, delayMs } = gifToFrames(new Uint8Array(await response.arrayBuffer()));
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  frames.forEach((rgba, i) => {
    const png = new PNG({ width: LCD_WIDTH, height: LCD_HEIGHT });
    rgba.copy(png.data);
    fs.writeFileSync(path.join(dir, `${i}.png`), PNG.sync.write(png));
  });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ delayMs }));
  console.log(`${name}: ${frames.length} frames, ${delayMs} ms each`);
}
