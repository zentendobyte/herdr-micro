import { describe, expect, it } from "vitest";
import { translateHid } from "../src/inputs.js";

describe("translateHid", () => {
  it("passes the agent keys through with their edges", () => {
    expect(translateHid("AG00", 1)).toEqual({ key: "AG00", act: 1 });
    expect(translateHid("AG05", 0)).toEqual({ key: "AG05", act: 0 });
  });

  it("renames the command keys AG06-AG12 to ACT06-ACT12", () => {
    expect(translateHid("AG06", 1)).toEqual({ key: "ACT06", act: 1 });
    expect(translateHid("AG10", 0)).toEqual({ key: "ACT10", act: 0 });
    expect(translateHid("AG11", 1)).toEqual({ key: "ACT11", act: 1 });
    expect(translateHid("AG12", 1)).toEqual({ key: "ACT12", act: 1 });
  });

  it("maps the dial to upstream's reported directions, one act-2 tick per detent", () => {
    // Physical clockwise (AG13) must become ENC_CC so it lands on dial-next.
    expect(translateHid("AG13", 1)).toEqual({ key: "ENC_CC", act: 2 });
    expect(translateHid("AG14", 1)).toEqual({ key: "ENC_CW", act: 2 });
    expect(translateHid("AG13", 0)).toBeNull();
    expect(translateHid("AG14", 0)).toBeNull();
  });

  it("maps the dial press to ENC_CLK with both edges", () => {
    expect(translateHid("AG19", 1)).toEqual({ key: "ENC_CLK", act: 1 });
    expect(translateHid("AG19", 0)).toEqual({ key: "ENC_CLK", act: 0 });
  });

  it("ignores the joystick sector keys and anything unknown", () => {
    for (const k of ["AG15", "AG16", "AG17", "AG18", "AG16x", "KC_A", "", "AG20"]) {
      expect(translateHid(k, 1)).toBeNull();
    }
  });
});
