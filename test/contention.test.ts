import { describe, expect, it } from "vitest";
import { anyRunning, parseTasklist, processRunning } from "../src/contention.js";

const CSV = `"System Idle Process","0","Services","0","8 K"
"WindowsTerminal.exe","1234","Console","1","90,000 K"
"Work Louder Input.exe","4321","Console","1","120,000 K"
"node.exe","999","Console","1","40,000 K"
`;

describe("parseTasklist", () => {
  it("returns lower-cased image names without .exe", () => {
    expect(parseTasklist(CSV)).toEqual(["system idle process", "windowsterminal", "work louder input", "node"]);
  });

  it("copes with blank lines and junk", () => {
    expect(parseTasklist("\n\nINFO: No tasks are running\n")).toEqual([]);
  });
});

describe("anyRunning", () => {
  it("matches case-insensitively with or without .exe", () => {
    const running = parseTasklist(CSV);
    expect(anyRunning(running, ["Work Louder Input"])).toBe(true);
    expect(anyRunning(running, ["windowsterminal.EXE"])).toBe(true);
    expect(anyRunning(running, ["Codex"])).toBe(false);
    expect(anyRunning(running, [])).toBe(false);
  });
});

describe("processRunning", () => {
  it("is false for an empty list without spawning anything", async () => {
    await expect(processRunning([])).resolves.toBe(false);
  });
});
