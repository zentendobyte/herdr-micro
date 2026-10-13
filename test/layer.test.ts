import { describe, expect, it } from "vitest";
import { isOwnedLayer } from "../src/layer.js";

describe("isOwnedLayer", () => {
  it("owns profile 0, layer 1 only", () => {
    expect(isOwnedLayer({ profile_index: 0, layer_index: 1 })).toBe(true);
    expect(isOwnedLayer({ profile_index: 0, layer_index: 2 })).toBe(false);
    expect(isOwnedLayer({ profile_index: 0, layer_index: 3 })).toBe(false);
    expect(isOwnedLayer({ profile_index: 1, layer_index: 1 })).toBe(false);
  });

  it("assumes ownership when the firmware omits the fields", () => {
    expect(isOwnedLayer({})).toBe(true);
    expect(isOwnedLayer({ battery: 90 })).toBe(true);
  });

  it("ignores non-integer values rather than guessing", () => {
    expect(isOwnedLayer({ profile_index: "1", layer_index: null })).toBe(true);
  });
});
