// What the XPAD Mini shows, decided from Herdr's agents. Pure functions.
import { worstStatus } from "../lights.js";
import type { AgentStatus } from "../slots.js";

/** off = leave the pad alone; the rest choose which agent(s) it mirrors. */
export type XpadMode = "off" | "worst" | "focused" | "per-key";
export const XPAD_MODES: readonly XpadMode[] = ["off", "worst", "focused", "per-key"];

/** Which artwork the LCD plays: the built-in Clawd or the bundled pixel art. */
export type XpadArt = "clawd" | "pixel";
export const XPAD_ARTS: readonly XpadArt[] = ["clawd", "pixel"];

/** The four states the pad's animations know, as in the original app. */
export type XpadState = "idle" | "working" | "attention" | "done";

export interface XpadView {
  /** Drives the light bar and the LCD. */
  state: XpadState;
  /** Per-key mode: one agent status for each of the three keys, else null. */
  keys: (AgentStatus | null)[] | null;
}

export const XPAD_KEY_COUNT = 3;

export function xpadState(status: AgentStatus | null): XpadState {
  switch (status) {
    case "blocked":
      return "attention";
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

export interface XpadAgent {
  status: AgentStatus;
  focused: boolean;
}

/**
 * @param agents every agent Herdr knows
 * @param slots the agent keys' statuses in key order (null = no agent)
 */
export function resolveXpadView(
  mode: XpadMode,
  agents: readonly XpadAgent[],
  slots: readonly (AgentStatus | null)[],
): XpadView {
  const worst = worstStatus(agents.map((agent) => agent.status));
  if (mode === "focused") {
    const focused = agents.find((agent) => agent.focused);
    return { state: xpadState(focused?.status ?? null), keys: null };
  }
  if (mode === "per-key") {
    return {
      state: xpadState(worst),
      keys: Array.from({ length: XPAD_KEY_COUNT }, (_, i) => slots[i] ?? null),
    };
  }
  return { state: xpadState(worst), keys: null };
}
