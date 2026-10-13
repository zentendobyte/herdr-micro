// Status to lighting translation for the six Agent Key LEDs and the ring.
import type { LightingSide, ThreadLighting } from "./device.js";
import type { DialMode } from "./dial.js";
import { SLOT_COUNT, type AgentStatus } from "./slots.js";

const EFFECT = { off: 0, solid: 1, rainbow: 3, breath: 4 } as const;

// Preserve the original workspace/agent indicators and add purple for scroll.
export const RING_AGENTS: LightingSide = {
  e: 1,
  b: 0.5,
  s: 0,
  m: 0,
  c: 0x2277ff,
};
export const RING_SCROLL: LightingSide = {
  e: 1,
  b: 0.5,
  s: 0,
  m: 0,
  c: 0xaa55ff,
};
export const RING_OFF: LightingSide = { e: 0, b: 0, s: 0, m: 0, c: 0 };

export const STATUS_COLORS: Record<AgentStatus, number> = {
  blocked: 0xff2d2d,
  done: 0x22cc55,
  working: 0x2277ff,
  idle: 0xffffff,
  unknown: 0xffffff,
};

const STATUS_LIGHTING: Record<AgentStatus, Omit<ThreadLighting, "id">> = {
  blocked: { c: STATUS_COLORS.blocked, b: 1, e: EFFECT.solid, s: 0 },
  done: { c: STATUS_COLORS.done, b: 1, e: EFFECT.solid, s: 0 },
  working: { c: STATUS_COLORS.working, b: 1, e: EFFECT.breath, s: 0.35 },
  idle: { c: STATUS_COLORS.idle, b: 1, e: EFFECT.solid, s: 0 },
  unknown: { c: STATUS_COLORS.unknown, b: 0.08, e: EFFECT.solid, s: 0 },
};

const OFF: Omit<ThreadLighting, "id"> = { c: 0, b: 0, e: EFFECT.off, s: 0 };

// Keys 6 to 12 (the bottom two rows) are not agent slots. They show the stock
// Work Louder rainbow, one solid colour, or nothing.
const KEY_COUNT = 13;
export type BottomRows = "rainbow" | "solid" | "off";
export const BOTTOM_ROWS_MODES: readonly BottomRows[] = ["rainbow", "solid", "off"];
export const BOTTOM_PALETTE: readonly { name: string; color: number }[] = [
  { name: "white", color: 0xffffff },
  { name: "warm white", color: 0xffb46b },
  { name: "red", color: 0xff2d2d },
  { name: "orange", color: 0xff7a00 },
  { name: "yellow", color: 0xffd400 },
  { name: "lime", color: 0x9be000 },
  { name: "green", color: 0x22cc55 },
  { name: "teal", color: 0x00c9a7 },
  { name: "cyan", color: 0x00d4ff },
  { name: "blue", color: 0x2277ff },
  { name: "indigo", color: 0x5a3cff },
  { name: "purple", color: 0xaa55ff },
  { name: "magenta", color: 0xff2bd6 },
  { name: "pink", color: 0xff7ab8 },
];
export interface BottomLighting {
  mode: BottomRows;
  color: number;
}
export const DEFAULT_BOTTOM: BottomLighting = { mode: "rainbow", color: 0xffffff };

const RAINBOW_KEY: Omit<ThreadLighting, "id"> = {
  c: 0xffffff,
  b: 1,
  e: EFFECT.rainbow,
  s: 0.2,
};

function bottomKey(bottom: BottomLighting): Omit<ThreadLighting, "id"> {
  if (bottom.mode === "rainbow") return RAINBOW_KEY;
  if (bottom.mode === "solid") {
    return { c: bottom.color, b: 1, e: EFFECT.solid, s: 0 };
  }
  return OFF;
}

export function slotLighting(
  statuses: (AgentStatus | null)[],
  brightness = 100,
  bottom: BottomLighting = { mode: "off", color: 0xffffff },
): ThreadLighting[] {
  return Array.from({ length: KEY_COUNT }, (_, id) => {
    const status = id < SLOT_COUNT ? (statuses[id] ?? null) : null;
    const lighting =
      id >= SLOT_COUNT ? bottomKey(bottom) : status ? STATUS_LIGHTING[status] : OFF;
    return { id, ...lighting, b: scaled(lighting.b, brightness) };
  });
}

// The brightness setting is a master level over every status brightness.
export function scaled(b: number, brightness: number): number {
  return (b * brightness) / 100;
}

// ---- Ring lighting profiles --------------------------------------------
// The pad has one visible lighting zone ("ambient"): the back strip and the
// border around the pad are the same zone, split by a metal strip. A profile
// decides what that zone shows. The keys zone shows nothing on this pad and
// stays off.
export type LightingProfile = 1 | 2 | 3;
export const LIGHTING_PROFILES: readonly LightingProfile[] = [1, 2, 3];
export const LIGHTING_PROFILE_NAMES: Record<LightingProfile, string> = {
  1: "Dial ring",
  2: "Agent status",
  3: "Work Louder rainbow",
};

// Work Louder's stock underglow, taken from the factory layer-1 lights config:
// effect rainbow, brightness 1, speed 0.55.
export const RING_RAINBOW: LightingSide = { e: EFFECT.rainbow, b: 1, s: 0.55, m: 1, c: 0xffffff };

// "Worst" first: blocked outranks working outranks unknown, idle, done.
const WORST_FIRST: readonly AgentStatus[] = [
  "blocked",
  "working",
  "unknown",
  "idle",
  "done",
];

export function worstStatus(statuses: readonly AgentStatus[]): AgentStatus | null {
  if (statuses.length === 0) return null;
  const present = new Set(statuses);
  return WORST_FIRST.find((status) => present.has(status)) ?? "unknown";
}

// The ring wears the same palette as the keys, so one colour means one thing.
function statusRing(status: AgentStatus): LightingSide {
  const { c, b, e, s } = STATUS_LIGHTING[status];
  return { e, b, s, m: 1, c };
}

export function ringForProfile(
  profile: LightingProfile,
  dialMode: DialMode,
  worst: AgentStatus | null,
): LightingSide {
  if (profile === 3) return RING_RAINBOW;
  if (profile === 2) return worst === null ? RING_OFF : statusRing(worst);
  if (dialMode === "agents") return RING_AGENTS;
  if (dialMode === "scroll") return RING_SCROLL;
  return RING_OFF;
}
