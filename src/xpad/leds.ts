// Renders an XpadView as the pad's 13 LEDs. Pure: the same view, time and
// brightness always give the same frame. The effects are ported from
// SpinnerMaster's xpad-mini-claude-code (MIT, see NOTICE.md).
import type { Rgb } from "./protocol.js";
import { LED_COUNT } from "./protocol.js";
import type { XpadState, XpadView } from "./view.js";
import type { AgentStatus } from "../slots.js";

// Device indexes: 0-2 are the key LEDs (left, center, right); 3-12 are the
// light bar running right to left.
const KEY_LEDS = [0, 1, 2];
/** Bar indexes ordered left to right as the user sees them. */
const BAR = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3];
/** Clockwise ring: the bar left to right, then the keys right to left. */
const RING = [...BAR, 2, 1, 0];

const BLACK: Rgb = { r: 0, g: 0, b: 0 };

// LED colors must be fully saturated: the output gamma washes out mixed
// colors, which would turn a red with some green into pink.
const BLUE: Rgb = { r: 0, g: 0x44, b: 0xff };
const RED: Rgb = { r: 0xff, g: 0, b: 0 };
const GREEN: Rgb = { r: 0, g: 0xff, b: 0 };
const WHITE: Rgb = { r: 0xff, g: 0xff, b: 0xff };

type Effect = "off" | "scan" | "flash" | "pulse";
const STATE_STYLE: Record<XpadState, { color: Rgb; effect: Effect }> = {
  idle: { color: BLACK, effect: "off" },
  working: { color: BLUE, effect: "scan" },
  attention: { color: RED, effect: "flash" },
  done: { color: GREEN, effect: "pulse" },
};

/** The LEDs are linear emitters; without gamma, dim values glow too bright. */
const GAMMA = 2.2;

// The bar sits behind a diffuser and needs ~17% duty to read as a glow; the
// bare key LEDs read the same at about 6%.
const BAR_BASE = Math.pow(0.17, 1 / GAMMA);
const KEY_BASE = Math.pow(0.06, 1 / GAMMA);

function scale(c: Rgb, f: number): Rgb {
  const k = Math.max(0, Math.min(1, f));
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

function gamma(c: Rgb): Rgb {
  const g = (v: number) => Math.round(255 * Math.pow(Math.max(0, v) / 255, GAMMA));
  return { r: g(c.r), g: g(c.g), b: g(c.b) };
}

/** A dot's brightness by distance, so the peak glides across LED boundaries. */
function dotLevel(dist: number, width = 2): number {
  const d = Math.abs(dist);
  if (d >= width) return 0;
  const f = 1 - d / width;
  return f * f;
}

function keyColor(status: AgentStatus | null, t: number): Rgb {
  switch (status) {
    case "blocked":
      return RED;
    case "done":
      return GREEN;
    case "working":
      return scale(BLUE, 0.55 + 0.45 * Math.sin(t * Math.PI * 1.2));
    case "idle":
    case "unknown":
      return WHITE;
    default:
      return BLACK;
  }
}

/**
 * @param t seconds since the view last changed; drives the animations
 * @param brightness 0 to 1, applied before gamma
 */
export function renderLeds(view: XpadView, t: number, brightness: number): Rgb[] {
  const style = STATE_STYLE[view.state];
  const out: Rgb[] = Array<Rgb>(LED_COUNT).fill(BLACK);
  const perKey = view.keys !== null;

  let level = 1;
  let keysFollowEffect = true;
  switch (style.effect) {
    case "off":
      level = 0;
      break;
    case "pulse":
      level = 0.02 + 0.98 * (0.5 + 0.5 * Math.sin(t * Math.PI));
      for (const idx of BAR) out[idx] = scale(style.color, level);
      break;
    case "flash":
      level = Math.floor(t * 4) % 2 === 0 ? 1 : 0;
      for (const idx of BAR) out[idx] = scale(style.color, level);
      break;
    case "scan": {
      // A dot circling the ring over a dim base. In per-key mode the keys
      // show their own agents, so the dot stays on the bar.
      const ring = perKey ? BAR : RING;
      const n = ring.length;
      const pos = (t * 8) % n;
      ring.forEach((idx, slot) => {
        const lin = Math.abs(pos - slot);
        const dist = Math.min(lin, n - lin);
        const isKey = idx < 3;
        const base = isKey ? KEY_BASE : BAR_BASE;
        const peak = dotLevel(dist) * (isKey ? 0.5 : 1);
        out[idx] = scale(style.color, Math.max(base, peak));
      });
      keysFollowEffect = perKey;
      break;
    }
  }

  if (perKey) {
    KEY_LEDS.forEach((idx) => {
      out[idx] = keyColor(view.keys?.[idx] ?? null, t);
    });
  } else if (keysFollowEffect) {
    for (const idx of KEY_LEDS) out[idx] = scale(style.color, level);
  }

  return out.map((c) => gamma(scale(c, brightness)));
}
