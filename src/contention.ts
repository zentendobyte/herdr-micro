// Other hosts (Work Louder's Input app, the Codex desktop app) also drive the
// pad. Which of them to yield to is user-configurable (`yield_to`), because
// their process names are not something this plugin can know.
import { spawn } from "node:child_process";

const normalize = (name: string) => name.trim().toLowerCase().replace(/\.exe$/, "");

// `tasklist /FO CSV /NH` lines look like "Image Name","PID","Session",...
export function parseTasklist(csv: string): string[] {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line);
    if (match) names.push(normalize(match[1]!));
  }
  return names;
}

export function anyRunning(running: string[], wanted: string[]): boolean {
  const set = new Set(running);
  return wanted.some((name) => set.has(normalize(name)));
}

export function processRunning(names: string[]): Promise<boolean> {
  if (names.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("tasklist", ["/FO", "CSV", "/NH"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (data: Buffer) => (out += data.toString("utf8")));
    child.on("close", () => resolve(anyRunning(parseTasklist(out), names)));
    child.on("error", () => resolve(false));
  });
}
