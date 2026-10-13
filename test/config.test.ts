import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts resolves its paths from the environment at import time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-config-"));
process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
process.env.HERDR_PLUGIN_STATE_DIR = dir;

const { CONFIG_FILE, loadConfig, savePolicy, saveLightingProfile, saveBrightness, saveBottomRows, saveBottomColor } =
  await import("../src/config.js");

const MALFORMED =
  '{ "policy": "mirror", "bindings": { "ACT10": {"key":"rcmd"} } ,}';

function write(text: string): void {
  fs.writeFileSync(CONFIG_FILE, text);
}

beforeEach(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config exists yet", () => {
    const config = loadConfig();
    expect(config.policy).toBe("sticky");
    expect(config.scrollSteps).toBe(1);
    expect(config.dialModeOrder).toEqual(["workspaces", "agents", "scroll"]);
    expect(config.yieldTo).toEqual([]);
    expect(config.bindings.buttons.ACT06).toEqual({
      kind: "preset",
      preset: "popup",
    });
  });

  it("reads a valid config", () => {
    write(
      JSON.stringify({
        policy: "mirror",
        scroll_steps: 3,
        dial_mode_order: ["scroll", "workspaces", "agents"],
        yield_to: ["Work Louder Input"],
        bindings: { ACT10: "zoom" },
      }),
    );
    const config = loadConfig();
    expect(config.policy).toBe("mirror");
    expect(config.scrollSteps).toBe(3);
    expect(config.dialModeOrder).toEqual(["scroll", "workspaces", "agents"]);
    expect(config.yieldTo).toEqual(["Work Louder Input"]);
    expect(config.bindings.buttons.ACT10).toEqual({
      kind: "preset",
      preset: "zoom",
    });
  });

  it("reports malformed JSON instead of silently reverting to defaults", () => {
    write(MALFORMED);
    expect(() => loadConfig()).toThrow(/is not valid JSON/);
  });

  it("rejects a non-object root", () => {
    write("[1, 2, 3]");
    expect(() => loadConfig()).toThrow(/expected a JSON object/);
    write("null");
    expect(() => loadConfig()).toThrow(/expected a JSON object/);
  });

  it("rejects an unknown policy rather than coercing it", () => {
    write(JSON.stringify({ policy: "banana" }));
    expect(() => loadConfig()).toThrow(/policy: expected "sticky" or "mirror"/);
  });

  it("accepts the scroll step boundaries", () => {
    for (const value of [1, 12]) {
      write(JSON.stringify({ scroll_steps: value }));
      expect(loadConfig().scrollSteps).toBe(value);
    }
  });

  it("rejects an invalid scroll step count", () => {
    for (const value of [0, 13, 1.5, "3"]) {
      write(JSON.stringify({ scroll_steps: value }));
      expect(() => loadConfig()).toThrow(
        /scroll_steps: expected an integer from 1 to 12/,
      );
    }
  });

  it("rejects an invalid dial mode order", () => {
    for (const value of [
      "scroll-first",
      ["scroll", "workspaces"],
      ["scroll", "scroll", "agents"],
      ["scroll", "workspaces", "volume"],
    ]) {
      write(JSON.stringify({ dial_mode_order: value }));
      expect(() => loadConfig()).toThrow(
        /dial_mode_order: expected each of workspaces, agents, scroll exactly once/,
      );
    }
  });
});

describe("yield_to", () => {
  it("rejects a malformed yield_to", () => {
    for (const value of ["Input", [1], [""]]) {
      write(JSON.stringify({ yield_to: value }));
      expect(() => loadConfig()).toThrow(/yield_to: expected a list of process names/);
    }
  });
});

describe("lighting_profile", () => {
  it("defaults to profile 1", () => {
    expect(loadConfig().lightingProfile).toBe(1);
  });

  it("reads 1, 2 and 3", () => {
    for (const value of [1, 2, 3]) {
      write(JSON.stringify({ lighting_profile: value }));
      expect(loadConfig().lightingProfile).toBe(value);
    }
  });

  it("rejects anything else, naming the field", () => {
    for (const value of [0, 4, "2", 1.5, null, [1]]) {
      write(JSON.stringify({ lighting_profile: value }));
      expect(() => loadConfig()).toThrow(/lighting_profile: expected 1, 2 or 3/);
    }
  });

  it("saveLightingProfile persists it and preserves fields it does not own", () => {
    write(JSON.stringify({ policy: "mirror", bindings: { ACT10: "zoom" } }));
    saveLightingProfile(3);
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    expect(raw.lighting_profile).toBe(3);
    expect(raw.policy).toBe("mirror");
    expect(raw.bindings).toEqual({ ACT10: "zoom" });
    expect(loadConfig().lightingProfile).toBe(3);
  });

  it("brightness defaults to 100, persists, and rejects out-of-range values", () => {
    expect(loadConfig().brightness).toBe(100);
    saveBrightness(40);
    expect(loadConfig().brightness).toBe(40);
    write(JSON.stringify({ brightness: 5 }));
    expect(() => loadConfig()).toThrow(/brightness/);
  });

  it("bottom rows default to rainbow and white, persist, and reject bad values", () => {
    expect(loadConfig().bottomRows).toBe("rainbow");
    expect(loadConfig().bottomColor).toBe(0xffffff);
    saveBottomRows("solid");
    saveBottomColor(0x2277ff);
    const config = loadConfig();
    expect(config.bottomRows).toBe("solid");
    expect(config.bottomColor).toBe(0x2277ff);
    expect(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).bottom_color).toBe("#2277ff");
    write(JSON.stringify({ bottom_rows: "disco" }));
    expect(() => loadConfig()).toThrow(/bottom_rows/);
    write(JSON.stringify({ bottom_color: "blue" }));
    expect(() => loadConfig()).toThrow(/bottom_color/);
  });

  it("the first-version rainbow_keys: false still turns the bottom rows off", () => {
    write(JSON.stringify({ rainbow_keys: false }));
    expect(loadConfig().bottomRows).toBe("off");
  });

  it("saveLightingProfile writes a fresh config when none exists", () => {
    saveLightingProfile(2);
    expect(loadConfig().lightingProfile).toBe(2);
  });

  it("saveLightingProfile refuses to overwrite a config it could not parse", () => {
    write(MALFORMED);
    expect(() => saveLightingProfile(2)).toThrow();
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).toBe(MALFORMED);
  });
});

describe("savePolicy", () => {
  it("preserves fields it does not own", () => {
    write(JSON.stringify({ policy: "sticky", bindings: { ACT10: "zoom" } }));
    savePolicy("mirror");
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as {
      policy: string;
      bindings: Record<string, string>;
    };
    expect(raw.policy).toBe("mirror");
    expect(raw.bindings).toEqual({ ACT10: "zoom" });
  });

  it("writes a fresh config when none exists", () => {
    savePolicy("mirror");
    expect(loadConfig().policy).toBe("mirror");
  });

  it("refuses to overwrite a config it could not parse", () => {
    // The whole point: a trailing comma must not cost the user every binding
    // they have, just because they toggled the policy afterwards.
    write(MALFORMED);
    expect(() => savePolicy("sticky")).toThrow(/is not valid JSON/);
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).toBe(MALFORMED);
  });
});

describe("terminal window options", () => {
  it("defaults to Windows Terminal and WezTerm with no title hints", () => {
    const config = loadConfig();
    expect(config.terminalProcesses).toEqual(["WindowsTerminal", "wezterm-gui"]);
    expect(config.terminalTitleContains).toEqual([]);
  });

  it("reads both lists", () => {
    write(JSON.stringify({ terminal_processes: ["alacritty"], terminal_title_contains: ["herdr", "work"] }));
    const config = loadConfig();
    expect(config.terminalProcesses).toEqual(["alacritty"]);
    expect(config.terminalTitleContains).toEqual(["herdr", "work"]);
  });

  it("rejects malformed lists, naming the field", () => {
    for (const value of ["WindowsTerminal", [1], [""], []]) {
      write(JSON.stringify({ terminal_processes: value }));
      expect(() => loadConfig()).toThrow(/terminal_processes: expected a non-empty list of process names/);
    }
    for (const value of ["x", [2], [""]]) {
      write(JSON.stringify({ terminal_title_contains: value }));
      expect(() => loadConfig()).toThrow(/terminal_title_contains: expected a list of strings/);
    }
  });
});
