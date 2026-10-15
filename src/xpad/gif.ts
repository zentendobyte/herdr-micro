// Turns a GIF into 240x135 RGBA frames for the pad's LCD: composites the
// frames (honouring disposal), crops to the artwork, and scales with nearest
// neighbour so pixel art stays crisp on a black background.
import { GifReader } from "omggif";
import { LCD_HEIGHT, LCD_WIDTH } from "./protocol.js";

export interface GifFrames {
  /** Each frame is LCD_WIDTH x LCD_HEIGHT RGBA. */
  frames: Buffer[];
  /** Mean frame delay of the source GIF. */
  delayMs: number;
}

const MAX_FRAMES = 48;
const MARGIN = 4;

export function gifToFrames(data: Uint8Array): GifFrames {
  const reader = new GifReader(data as Buffer);
  const { width, height } = reader;
  const canvas = new Uint8Array(width * height * 4);
  const composited: Uint8Array[] = [];
  let delaySum = 0;

  for (let i = 0; i < reader.numFrames(); i++) {
    const info = reader.frameInfo(i);
    const before = info.disposal === 3 ? canvas.slice() : null;
    reader.decodeAndBlitFrameRGBA(i, canvas as unknown as Uint8ClampedArray);
    composited.push(canvas.slice());
    delaySum += Math.max(info.delay, 1) * 10;
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y++) {
        canvas.fill(0, (y * width + info.x) * 4, (y * width + info.x + info.width) * 4);
      }
    } else if (before) {
      canvas.set(before);
    }
  }
  if (composited.length === 0) throw new Error("gif has no frames");

  // Union bounding box of everything visible across the animation.
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (const frame of composited) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (frame[(y * width + x) * 4 + 3]! === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("gif is fully transparent");
  const cropW = x1 - x0 + 1;
  const cropH = y1 - y0 + 1;
  const scale = Math.min((LCD_WIDTH - 2 * MARGIN) / cropW, (LCD_HEIGHT - 2 * MARGIN) / cropH);
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));
  const offX = Math.floor((LCD_WIDTH - outW) / 2);
  const offY = Math.floor((LCD_HEIGHT - outH) / 2);

  const step = Math.ceil(composited.length / MAX_FRAMES);
  const frames: Buffer[] = [];
  for (let n = 0; n < composited.length; n += step) {
    const src = composited[n]!;
    const out = Buffer.alloc(LCD_WIDTH * LCD_HEIGHT * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255; // opaque black
    for (let y = 0; y < outH; y++) {
      const sy = y0 + Math.min(cropH - 1, Math.floor(y / scale));
      for (let x = 0; x < outW; x++) {
        const sx = x0 + Math.min(cropW - 1, Math.floor(x / scale));
        const s = (sy * width + sx) * 4;
        const a = src[s + 3]! / 255;
        const o = ((offY + y) * LCD_WIDTH + offX + x) * 4;
        out[o] = Math.round(src[s]! * a);
        out[o + 1] = Math.round(src[s + 1]! * a);
        out[o + 2] = Math.round(src[s + 2]! * a);
      }
    }
    frames.push(out);
  }
  return { frames, delayMs: Math.round((delaySum / composited.length) * step) };
}
