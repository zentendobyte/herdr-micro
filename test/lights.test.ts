import { describe, expect, it } from "vitest";
import {
  LIGHTING_PROFILES,
  LIGHTING_PROFILE_NAMES,
  RING_AGENTS,
  RING_OFF,
  RING_RAINBOW,
  RING_SCROLL,
  STATUS_COLORS,
  ringForProfile,
  slotLighting,
  worstStatus,
} from "../src/lights.js";

describe("worstStatus", () => {
  it("is null with no agents", () => {
    expect(worstStatus([])).toBeNull();
  });

  it("ranks blocked, working, unknown, idle, done", () => {
    expect(worstStatus(["idle", "working", "done"])).toBe("working");
    expect(worstStatus(["done", "idle", "blocked", "working"])).toBe("blocked");
    expect(worstStatus(["done", "idle"])).toBe("idle");
    expect(worstStatus(["done", "unknown", "idle"])).toBe("unknown");
    expect(worstStatus(["done"])).toBe("done");
  });
});

describe("ringForProfile", () => {
  it("profile 1 shows the dial mode, exactly as before", () => {
    expect(ringForProfile(1, "workspaces", "blocked")).toEqual(RING_OFF);
    expect(ringForProfile(1, "agents", "blocked")).toEqual(RING_AGENTS);
    expect(ringForProfile(1, "scroll", null)).toEqual(RING_SCROLL);
  });

  it("profile 2 shows the worst agent state in the key palette", () => {
    const blocked = ringForProfile(2, "workspaces", "blocked");
    expect(blocked).toMatchObject({ c: STATUS_COLORS.blocked, e: 1, b: 1, m: 1 });
    const working = ringForProfile(2, "agents", "working");
    expect(working).toMatchObject({ c: STATUS_COLORS.working, e: 4, b: 1, m: 1 });
    expect(working.s).toBeGreaterThan(0);
    expect(ringForProfile(2, "workspaces", "done")).toMatchObject({ c: STATUS_COLORS.done, e: 1 });
    const idle = ringForProfile(2, "workspaces", "idle");
    expect(idle).toMatchObject({ c: STATUS_COLORS.idle, e: 1 });
    expect(idle.b).toBe(1);
  });

  it("profile 2 is off with no agents and ignores the dial mode", () => {
    expect(ringForProfile(2, "workspaces", null)).toEqual(RING_OFF);
    expect(ringForProfile(2, "scroll", "blocked")).toEqual(ringForProfile(2, "workspaces", "blocked"));
  });

  it("profile 3 is Work Louder's stock rainbow whatever the agents or dial do", () => {
    expect(RING_RAINBOW).toEqual({ e: 3, b: 1, s: 0.55, m: 1, c: 0xffffff });
    expect(ringForProfile(3, "scroll", "blocked")).toEqual(RING_RAINBOW);
    expect(ringForProfile(3, "workspaces", null)).toEqual(RING_RAINBOW);
  });
});

describe("profile table", () => {
  it("has three named profiles", () => {
    expect(LIGHTING_PROFILES).toEqual([1, 2, 3]);
    expect(Object.keys(LIGHTING_PROFILE_NAMES)).toEqual(["1", "2", "3"]);
  });
});

describe("slotLighting brightness", () => {
  it("scales every lit key and leaves empty keys off", () => {
    const full = slotLighting(["working", null]);
    const half = slotLighting(["working", null], 50);
    expect(half[0]!.b).toBeCloseTo(full[0]!.b / 2);
    expect(half[1]!.b).toBe(0);
  });

  it("lights the bottom two rows with the rainbow only when asked", () => {
    const plain = slotLighting(["idle"]);
    expect(plain).toHaveLength(13);
    expect(plain.slice(6).every((key) => key.e === 0 && key.b === 0)).toBe(true);
    const rainbow = slotLighting(["idle"], 50, { mode: "rainbow", color: 0xffffff });
    expect(rainbow.slice(0, 6)).toHaveLength(6);
    expect(rainbow.slice(6).map((key) => key.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(rainbow.slice(6).every((key) => key.e === 3 && key.b === 0.5)).toBe(true);
  });

  it("solid mode paints the bottom rows one colour", () => {
    const solid = slotLighting([], 100, { mode: "solid", color: 0x2277ff });
    expect(solid.slice(6).every((key) => key.c === 0x2277ff && key.e === 1 && key.b === 1)).toBe(true);
    expect(solid.slice(0, 6).every((key) => key.e === 0)).toBe(true);
  });
});
