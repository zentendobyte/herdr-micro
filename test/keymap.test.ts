import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply, isApplied, parse, restore, withKeymap } from "../src/keymap.js";

const stock = () => ({
  activeProfileId: 0,
  profiles: [{
    layers: [
      { layout: {
        keymap: [["KC_A", "KC_B"], ["KC_C", "KC_D", "KC_E", "KC_F"], ["KC_G", "KC_H", "KC_I", "KC_J"], ["KC_K", "KC_L", "KC_M"]],
        encoders: [["KC_VOLU", "KC_VOLD", "KC_MPLY"]],
        joystick: { type: "RADIAL", sectors: [
          { k: "KC_P6", a1: 0.9375, a2: 0.0625 }, { k: "KC_P7", a1: 0.0625, a2: 0.1875 },
          { k: "KI_X", a1: 0.1875, a2: 0.3125 }, { k: "KC_P1", a1: 0.3125, a2: 0.4375 },
          { k: "KC_P2", a1: 0.4375, a2: 0.5625 }, { k: "KC_P3", a1: 0.5625, a2: 0.6875 },
          { k: "KC_P4", a1: 0.6875, a2: 0.8125 }, { k: "KC_P5", a1: 0.8125, a2: 0.9375 },
        ] },
      } },
      { layout: { keymap: [["KC_1", "KC_2"], ["KC_3", "KC_4", "KC_5", "KC_6"], ["KC_7", "KC_8", "KC_9", "KC_0"], ["KC_Q", "KC_W", "KC_E"]] } },
    ],
  }],
});

function fakeCall(config: unknown, { ignoreWrites = false } = {}) {
  const state = { config, writes: 0 };
  const call = async (method: string, params?: any): Promise<unknown> => {
    if (method === "fs.read") return { data: JSON.stringify(state.config) };
    if (method === "fs.write") {
      state.writes++;
      if (!ignoreWrites) state.config = JSON.parse(params.data);
      return null;
    }
    throw new Error("Method not found");
  };
  return { call, state };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wl-km-"));

describe("withKeymap", () => {
  it("binds all 13 keys, the dial (incl. press) and the joystick cardinals on layer 1", () => {
    const layout = withKeymap(stock()).profiles[0]!.layers[0]!.layout;
    expect(layout.keymap).toEqual([
      ["KV_OAI_AG00", "KV_OAI_AG01"],
      ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
      ["KV_OAI_AG06", "KV_OAI_AG07", "KV_OAI_AG08", "KV_OAI_AG09"],
      ["KV_OAI_AG10", "KV_OAI_AG11", "KV_OAI_AG12"],
    ]);
    expect(layout.encoders[0]).toEqual(["KV_OAI_AG13", "KV_OAI_AG14", "KV_OAI_AG19"]);
    const k = layout.joystick.sectors.map((s: any) => s.k);
    // centre 0 (wraps) = right, 0.25 = down, 0.5 = left, 0.75 = up; diagonals untouched
    expect(k).toEqual(["KV_OAI_AG18", "KC_P7", "KV_OAI_AG15", "KC_P1", "KV_OAI_AG16", "KC_P3", "KV_OAI_AG17", "KC_P5"]);
  });

  it("leaves other layers alone, does not mutate its input, and is idempotent", () => {
    const input = stock();
    const once = withKeymap(input);
    expect(input).toEqual(stock());
    expect(once.profiles[0]!.layers[1]).toEqual(stock().profiles[0]!.layers[1]);
    expect(withKeymap(once)).toEqual(once);
    expect(isApplied(stock())).toBe(false);
    expect(isApplied(once)).toBe(true);
  });

  it("tolerates a short keymap and a missing joystick/encoder", () => {
    const tiny = { profiles: [{ layers: [{ layout: { keymap: [["KC_A"]] } }] }] };
    const next = withKeymap(tiny);
    expect(next.profiles[0]!.layers[0]!.layout.keymap[0][0]).toBe("KV_OAI_AG00");
    expect(isApplied(next)).toBe(true);
  });

  it("throws a clear error when there is no profile or layout", () => {
    expect(() => withKeymap({ profiles: [] })).toThrow(/no profiles/);
    expect(() => withKeymap({})).toThrow(/no profiles/);
    expect(() => withKeymap({ profiles: [{ layers: [{}] }] })).toThrow(/no profiles/);
  });
});

describe("parse", () => {
  it("unwraps the double-encoded envelope and rejects junk", () => {
    expect(parse({ data: '{"a":1}' })).toEqual({ a: 1 });
    for (const bad of [null, {}, { data: "not json" }, { data: 5 }]) {
      expect(() => parse(bad)).toThrow(/Could not read the device keymap/);
    }
  });
});

describe("apply", () => {
  it("writes once, saves the original once, verifies, and is a no-op the second time", async () => {
    const dir = tmp();
    const { call, state } = fakeCall(stock());
    expect(await apply(call, { backupDir: dir })).toBe(true);
    expect(state.writes).toBe(1);
    expect(await apply(call, { backupDir: dir })).toBe(false);
    expect(state.writes).toBe(1);
    const backup = JSON.parse(fs.readFileSync(path.join(dir, "keymap-original.json"), "utf8"));
    expect(JSON.parse(backup.data)).toEqual(stock());
  });

  it("never overwrites an existing original backup", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "keymap-original.json"), JSON.stringify({ data: "sentinel" }));
    await apply(fakeCall(stock()).call, { backupDir: dir });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "keymap-original.json"), "utf8")).data).toBe("sentinel");
  });

  it("throws when the firmware silently ignores the write", async () => {
    await expect(apply(fakeCall(stock(), { ignoreWrites: true }).call, { backupDir: tmp() })).rejects.toThrow(
      /did not accept/,
    );
  });

  it("propagates a pad that stops answering", async () => {
    const call = async () => { throw new Error("timeout waiting for fs.read"); };
    await expect(apply(call, { backupDir: tmp() })).rejects.toThrow(/timeout/);
  });
});

describe("restore", () => {
  it("puts back layer 1 only, keeping edits made to the other layers since", async () => {
    const dir = tmp();
    const { call, state } = fakeCall(stock());
    await apply(call, { backupDir: dir });
    (state.config as any).profiles[0].layers[1].layout.keymap[0][0] = "KC_EDITED_LAYER_2";
    await restore(call, dir);
    const profile = (state.config as any).profiles[0];
    expect(profile.layers[0]).toEqual(stock().profiles[0]!.layers[0]);
    expect(profile.layers[1].layout.keymap[0][0]).toBe("KC_EDITED_LAYER_2");
  });

  it("throws without a backup", async () => {
    await expect(restore(fakeCall(stock()).call, tmp())).rejects.toThrow(/No original keymap backup/);
  });
});

describe("restore with a damaged device keymap", () => {
  it("writes the whole backup back when the current keymap cannot be parsed", async () => {
    const dir = tmp();
    await apply(fakeCall(stock()).call, { backupDir: dir });
    let raw = "{truncated";
    const call = async (method: string, params?: any): Promise<unknown> => {
      if (method === "fs.read") return { data: raw };
      if (method === "fs.write") { raw = params.data; return null; }
      throw new Error("Method not found");
    };
    await restore(call, dir);
    expect(JSON.parse(raw)).toEqual(stock());
  });

  it("writes the original backup atomically (no temp file left behind)", async () => {
    const dir = tmp();
    await apply(fakeCall(stock()).call, { backupDir: dir });
    expect(fs.readdirSync(dir)).toEqual(["keymap-original.json"]);
  });
});
