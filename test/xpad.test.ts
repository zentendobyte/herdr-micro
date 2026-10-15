import { describe, expect, it } from "vitest";
import { GifWriter } from "omggif";
import { gifToFrames } from "../src/xpad/gif.js";
import { renderLeds } from "../src/xpad/leds.js";
import { buildPacket, ledPayload } from "../src/xpad/protocol.js";
import { resolveXpadView, xpadState } from "../src/xpad/view.js";

const agent = (status: string, focused = false) =>
  ({ status, focused }) as { status: never; focused: boolean };

describe("xpadState", () => {
  it("maps Herdr statuses onto the pad's four states", () => {
    expect(xpadState("blocked")).toBe("attention");
    expect(xpadState("working")).toBe("working");
    expect(xpadState("done")).toBe("done");
    expect(xpadState("idle")).toBe("idle");
    expect(xpadState("unknown")).toBe("idle");
    expect(xpadState(null)).toBe("idle");
  });
});

describe("resolveXpadView", () => {
  const agents = [agent("idle", true), agent("working"), agent("blocked")];

  it("worst mode follows the neediest agent", () => {
    expect(resolveXpadView("worst", agents, [])).toEqual({
      state: "attention",
      keys: null,
    });
  });

  it("focused mode follows the focused agent, idle when none is focused", () => {
    expect(resolveXpadView("focused", agents, []).state).toBe("idle");
    const other = [agent("idle"), agent("working", true)];
    expect(resolveXpadView("focused", other, []).state).toBe("working");
    expect(resolveXpadView("focused", [agent("working")], []).state).toBe("idle");
  });

  it("per-key mode gives each of the three keys its slot and the bar the worst state", () => {
    const view = resolveXpadView("per-key", agents, ["idle", "working", "blocked", "done"]);
    expect(view).toEqual({ state: "attention", keys: ["idle", "working", "blocked"] });
    expect(resolveXpadView("per-key", [], ["working"]).keys).toEqual(["working", null, null]);
  });

  it("is idle with no agents", () => {
    expect(resolveXpadView("worst", [], []).state).toBe("idle");
  });
});

describe("renderLeds", () => {
  const dark = { r: 0, g: 0, b: 0 };

  it("always returns exactly 13 LEDs", () => {
    for (const state of ["idle", "working", "attention", "done"] as const) {
      expect(renderLeds({ state, keys: null }, 0.3, 1)).toHaveLength(13);
    }
  });

  it("idle is dark", () => {
    expect(renderLeds({ state: "idle", keys: null }, 0, 1).every((c) => c.r + c.g + c.b === 0)).toBe(true);
  });

  it("attention flashes red on and off", () => {
    const on = renderLeds({ state: "attention", keys: null }, 0, 1);
    const off = renderLeds({ state: "attention", keys: null }, 0.3, 1);
    expect(on[5]).toEqual({ r: 255, g: 0, b: 0 });
    expect(off[5]).toEqual(dark);
    expect(on[0]).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("brightness scales the output", () => {
    const full = renderLeds({ state: "attention", keys: null }, 0, 1)[5]!;
    const half = renderLeds({ state: "attention", keys: null }, 0, 0.5)[5]!;
    expect(half.r).toBeLessThan(full.r);
    expect(renderLeds({ state: "attention", keys: null }, 0, 0).every((c) => c.r === 0)).toBe(true);
  });

  it("per-key mode colours each key by its agent and keeps the working dot on the bar", () => {
    const leds = renderLeds({ state: "working", keys: ["idle", "blocked", null] }, 0, 1);
    expect(leds[0]).toEqual({ r: 255, g: 255, b: 255 });
    expect(leds[1]).toEqual({ r: 255, g: 0, b: 0 });
    expect(leds[2]).toEqual(dark);
    expect(leds.slice(3).some((c) => c.b > 0)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const view = { state: "working", keys: null } as const;
    expect(renderLeds(view, 1.234, 0.8)).toEqual(renderLeds(view, 1.234, 0.8));
  });
});

describe("protocol packets", () => {
  it("frames a command in a 1024-byte report", () => {
    const packet = buildPacket(0x27, Buffer.alloc(52, 1), 0);
    expect(packet).toHaveLength(1024);
    expect(packet[0]).toBe(0x22);
    expect(packet[6]).toBe(0x27);
    expect(packet.readUInt16LE(4)).toBe(56);
  });

  it("checksums the used words with the checksum field zeroed", () => {
    const packet = buildPacket(0x02, Buffer.alloc(0));
    const stored = packet.readUInt16LE(2);
    packet.writeUInt16LE(0, 2);
    let sum = 0;
    for (let i = 0; i < 8; i += 2) sum = (sum + packet.readUInt16LE(i)) & 0xffff;
    expect(stored).toBe(sum);
  });

  it("LED payloads are exactly 13 [R,G,B,0] entries", () => {
    const payload = ledPayload([{ r: 1, g: 2, b: 3 }]);
    expect(payload).toHaveLength(52);
    expect([...payload.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
    expect([...payload.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});

describe("gifToFrames", () => {
  it("crops to the artwork and scales it onto a black LCD frame", () => {
    const buf = Buffer.alloc(4096);
    const writer = new GifWriter(buf, 20, 20, { palette: [0x000000, 0xff0000] });
    const px = new Array<number>(20 * 20).fill(0);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) px[y * 20 + x] = 1;
    writer.addFrame(0, 0, 20, 20, px, { delay: 10, transparent: 0 });
    const { frames, delayMs } = gifToFrames(buf.subarray(0, writer.end()));
    expect(delayMs).toBe(100);
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f).toHaveLength(240 * 135 * 4);
    const at = (x: number, y: number) => [...f.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 4)];
    expect(at(120, 67)).toEqual([255, 0, 0, 255]); // artwork centred
    expect(at(2, 2)).toEqual([0, 0, 0, 255]); // black margin
  });
});
