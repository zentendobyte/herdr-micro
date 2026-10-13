import { describe, expect, it } from "vitest";
import { renderLightingTab, renderTabs } from "../src/lighting-tab.js";

// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("renderTabs", () => {
  it("shows both tabs and marks the active one", () => {
    expect(plain([renderTabs("keys")])).toMatch(/\[Keys\].*Lighting/);
    expect(plain([renderTabs("lighting")])).toMatch(/Keys.*\[Lighting\]/);
  });
});

describe("renderLightingTab", () => {
  it("lists the three profiles with the active one marked", () => {
    for (const active of [1, 2, 3] as const) {
      const lines = plain(renderLightingTab(active)).split("\n");
      const marked = lines.filter((l) => l.includes("▶"));
      expect(marked).toHaveLength(1);
      expect(marked[0]).toContain(String(active));
    }
    const text = plain(renderLightingTab(1));
    expect(text).toContain("Dial ring");
    expect(text).toContain("Agent status");
    expect(text).toContain("Work Louder rainbow");
  });

  it("explains that the strip and border are one zone and how to choose", () => {
    const text = plain(renderLightingTab(2));
    expect(text).toMatch(/back strip.*border/i);
    expect(text).toMatch(/1.*2.*3.*select/i);
  });

  it("colours the agent-status swatches with the key palette", () => {
    const raw = renderLightingTab(2).join("\n");
    expect(raw).toContain("38;2;255;45;45"); // blocked red 0xff2d2d
    expect(raw).toContain("38;2;34;204;85"); // done green 0x22cc55
    expect(raw).toContain("38;2;34;119;255"); // working blue 0x2277ff
  });
});
