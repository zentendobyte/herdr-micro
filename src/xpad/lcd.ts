// Plays the pad's LCD animation (Clawd the crab) for the current state.
// Ported from SpinnerMaster's xpad-mini-claude-code (MIT, see NOTICE.md); the
// key-press reactions and the imported-art directories are left out.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { LCD_HEIGHT, LCD_WIDTH, type XpadProtocol } from "./protocol.js";
import type { XpadArt, XpadState } from "./view.js";

const STATE_ANIMATION: Record<XpadState, string> = {
  idle: "sleeping",
  working: "working",
  attention: "alert",
  done: "happy",
};

const ANIMATION_FPS: Record<string, number> = {
  sleeping: 4,
  working: 8,
  alert: 6,
  happy: 6,
};

interface Animation {
  /** RGB565-LE frames, converted once at load */
  frames: Buffer[];
  delayMs: number;
}

function rgbaToRgb565(rgba: Buffer): Buffer {
  const out = Buffer.alloc(LCD_WIDTH * LCD_HEIGHT * 2);
  for (let i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) {
    const v =
      ((rgba[i * 4]! >> 3) << 11) |
      ((rgba[i * 4 + 1]! >> 2) << 5) |
      (rgba[i * 4 + 2]! >> 3);
    out.writeUInt16LE(v, i * 2);
  }
  return out;
}

export class LcdEngine {
  /** Keyed "<art>/<animation>". */
  private animations = new Map<string, Animation>();
  private art: XpadArt = "clawd";
  private state: XpadState = "idle";
  private frameIndex = 0;
  private frameShownAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Invalidates an in-flight tick when the animation changes or stops. */
  private epoch = 0;

  constructor(
    private protocol: XpadProtocol,
    private assetDirs: Record<XpadArt, string>,
  ) {}

  loadAssets(): void {
    this.animations.clear();
    for (const art of Object.keys(this.assetDirs) as XpadArt[]) {
      for (const [name, fps] of Object.entries(ANIMATION_FPS)) {
        this.loadAnimation(art, name, fps);
      }
    }
  }

  private loadAnimation(art: XpadArt, name: string, fps: number): void {
    const dir = path.join(this.assetDirs[art], name);
    {
      try {
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".png"))
          .sort((a, b) => parseInt(a) - parseInt(b));
        const frames: Buffer[] = [];
        for (const file of files) {
          const png = PNG.sync.read(fs.readFileSync(path.join(dir, file)));
          if (png.width === LCD_WIDTH && png.height === LCD_HEIGHT) {
            frames.push(rgbaToRgb565(png.data));
          }
        }
        let delayMs = 1000 / fps;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
          if (typeof meta.delayMs === "number" && meta.delayMs > 0) delayMs = meta.delayMs;
        } catch {
          // No meta.json: the default rate for this animation.
        }
        if (frames.length > 0) this.animations.set(`${art}/${name}`, { frames, delayMs });
      } catch {
        // A missing animation falls back to the other art set.
      }
    }
  }

  setArt(art: XpadArt): void {
    if (art === this.art) return;
    this.art = art;
    this.frameIndex = 0;
    this.frameShownAt = 0;
    this.reschedule();
  }

  setState(state: XpadState): void {
    if (state === this.state) return;
    this.state = state;
    this.frameIndex = 0;
    this.frameShownAt = 0;
    this.reschedule();
  }

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.epoch++;
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const myEpoch = ++this.epoch;
    const tick = async () => {
      if (myEpoch !== this.epoch) return;
      const name = STATE_ANIMATION[this.state];
      const anim =
        this.animations.get(`${this.art}/${name}`) ?? this.animations.get(`clawd/${name}`);
      if (!anim) {
        // Assets missing: retry slowly.
        this.timer = setTimeout(() => void tick(), 1000);
        return;
      }
      const idx = this.frameIndex % anim.frames.length;
      if (this.frameShownAt === 0) this.frameShownAt = Date.now();
      await this.protocol.drawLcdFrame(anim.frames[idx]!);
      if (myEpoch !== this.epoch) return;
      // Long frame holds are re-ticked in slices; each identical redraw costs
      // one keep-alive packet and keeps the firmware's own UI suppressed.
      const elapsed = Date.now() - this.frameShownAt;
      if (elapsed >= anim.delayMs - 10) {
        this.frameIndex++;
        this.frameShownAt = 0;
        this.timer = setTimeout(() => void tick(), 10);
      } else {
        this.timer = setTimeout(() => void tick(), Math.min(anim.delayMs - elapsed, 350));
      }
    };
    void tick();
  }
}
