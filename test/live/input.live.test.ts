import { describe, expect, it } from "vitest";
import { loadInputBackend } from "../../src/winput.js";

describe.skipIf(process.env.WL_LIVE !== "1")("live input backend", () => {
  it("loads, sends F24 and a net-zero wheel, and sees the foreground window", () => {
    const input = loadInputBackend();
    input.key(0x87, false); // F24: unassigned on almost every system
    input.key(0x87, true);
    input.wheel(120);
    input.wheel(-120);
    const front = input.foreground();
    expect(front).not.toBeNull();
    expect(front!.processName.length).toBeGreaterThan(0);
    expect(front!.width).toBeGreaterThan(0);
    const windows = input.listWindows();
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((w) => w.title.length > 0 && typeof w.hwnd === "number")).toBe(true);
  });
});
