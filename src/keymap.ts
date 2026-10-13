// Device keymap handling for the Creator Micro 2.
//
// Per-key lighting and key events only exist for keys bound to KV_OAI_AG*
// keycodes on the ACTIVE layer, and nothing reports a mismatch: v.oai.thstatus
// answers {"ok":1} for a key that cannot light. So the bindings are checked,
// not assumed. Binding a key stops it sending its normal keystroke.
//
// Everything here is pinned to profile 0, layer 1: the Input app's "profile 2"
// and "profile 3" are layers 2 and 3 of the same profile and stay the user's.
import fs from "node:fs";
import path from "node:path";

export type Call = (method: string, params?: unknown) => Promise<unknown>;
// The device's keymap.json is untyped JSON owned by the firmware.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KeymapConfig = any;

// Matrix [2, 4, 4, 3], key index row-major; firmware 0.6.3 numbers the top
// row left to right (index 0 is top-LEFT).
const ROWS: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3, 4, 5],
  [6, 7, 8, 9],
  [10, 11, 12],
];
const code = (n: number) => `KV_OAI_AG${String(n).padStart(2, "0")}`;
const KEY_CODES = Array.from({ length: 13 }, (_, i) => code(i));
// Dial: clockwise, counter-clockwise, press. (AG19 is the table's last code.)
const DIAL_CODES = [code(13), code(14), code(19)] as const;
// Joystick cardinal sectors by the angle at their centre. Firmware 0.6.3:
// 0 = right, increasing clockwise, so 0.25 is DOWN and 0.75 is UP.
const JOYSTICK_CODES: readonly (readonly [number, string])[] = [
  [0.25, code(15)],
  [0.5, code(16)],
  [0.75, code(17)],
  [0, code(18)],
];

const BACKUP_NAME = "keymap-original.json";

function sectorCentre(a1: number, a2: number): number {
  const centre = a2 >= a1 ? (a1 + a2) / 2 : (a1 + a2 + 1) / 2;
  return centre % 1;
}

function layerOne(config: KeymapConfig): KeymapConfig {
  return config?.profiles?.[0]?.layers?.[0] ?? null;
}

function bindings(): { row: number; column: number; code: string }[] {
  const out: { row: number; column: number; code: string }[] = [];
  ROWS.forEach((keys, row) =>
    keys.forEach((key, column) => out.push({ row, column, code: KEY_CODES[key]! })),
  );
  return out;
}

// Positions the device's keymap does not have are skipped by both functions
// below, so a short keymap converges instead of being rewritten on every start.
export function isApplied(config: KeymapConfig): boolean {
  const layout = layerOne(config)?.layout;
  const keymap = layout?.keymap;
  if (!Array.isArray(keymap)) return false;
  for (const b of bindings()) {
    const row = keymap[b.row];
    if (Array.isArray(row) && b.column < row.length && row[b.column] !== b.code) return false;
  }
  const dial = layout.encoders?.[0];
  if (Array.isArray(dial)) {
    for (let i = 0; i < Math.min(dial.length, DIAL_CODES.length); i++) {
      if (dial[i] !== DIAL_CODES[i]) return false;
    }
  }
  const sectors = layout.joystick?.sectors;
  if (Array.isArray(sectors)) {
    for (const [centre, want] of JOYSTICK_CODES) {
      const bound = sectors.some(
        (s: KeymapConfig) =>
          typeof s.a1 === "number" && typeof s.a2 === "number" &&
          Math.abs(sectorCentre(s.a1, s.a2) - centre) < 0.01 && s.k === want,
      );
      if (!bound) return false;
    }
  }
  return true;
}

export function withKeymap(config: KeymapConfig): KeymapConfig {
  const next = structuredClone(config);
  const layout = layerOne(next)?.layout;
  if (!layout || !Array.isArray(layout.keymap)) throw new Error("Device keymap has no profiles.");

  for (const b of bindings()) {
    const row = layout.keymap[b.row];
    if (Array.isArray(row) && b.column < row.length) row[b.column] = b.code;
  }
  const dial = layout.encoders?.[0];
  if (Array.isArray(dial)) {
    for (let i = 0; i < Math.min(dial.length, DIAL_CODES.length); i++) dial[i] = DIAL_CODES[i];
  }
  const sectors = layout.joystick?.sectors;
  if (Array.isArray(sectors)) {
    for (const sector of sectors) {
      if (typeof sector.a1 !== "number" || typeof sector.a2 !== "number") continue;
      const centre = sectorCentre(sector.a1, sector.a2);
      const match = JOYSTICK_CODES.find(([c]) => Math.abs(c - centre) < 0.01);
      if (match) sector.k = match[1];
    }
  }
  return next;
}

export function parse(raw: unknown): KeymapConfig {
  const fail = (detail: string) => new Error(`Could not read the device keymap: ${detail}`);
  if (!raw || typeof raw !== "object") throw fail("unexpected response shape");
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== "string") throw fail("missing or malformed `data` field");
  try {
    const config = JSON.parse(data) as unknown;
    if (!config || typeof config !== "object") throw new Error("not an object");
    return config;
  } catch (error) {
    throw fail(`missing or malformed \`data\` field (${(error as Error).message})`);
  }
}

export async function read(call: Call): Promise<KeymapConfig> {
  return parse(await call("fs.read", { file: "keymap.json" }));
}

// Returns true when it had to write (a flash write: only when bindings differ).
export async function apply(call: Call, { backupDir }: { backupDir: string }): Promise<boolean> {
  const raw = await call("fs.read", { file: "keymap.json" });
  const config = parse(raw);
  if (isApplied(config)) return false;

  const next = withKeymap(config);

  // The first thing ever on the device is the one worth keeping: never overwrite.
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, BACKUP_NAME);
  if (!fs.existsSync(backupFile)) {
    // Temp file + rename: a crash mid-write must not leave a truncated backup
    // that the never-overwrite rule would then protect forever.
    const tmp = `${backupFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, backupFile);
  }

  await call("fs.write", { file: "keymap.json", data: JSON.stringify(next) });
  if (!isApplied(await read(call))) throw new Error("The device did not accept the keymap.");
  return true;
}

// Puts back only layer 1 from the backup. Other layers (the Input app's
// profiles 2 and 3) are the user's, so edits made since must survive.
export async function restore(call: Call, backupDir: string): Promise<void> {
  const backupFile = path.join(backupDir, BACKUP_NAME);
  if (!fs.existsSync(backupFile)) throw new Error("No original keymap backup found.");
  const original = parse(JSON.parse(fs.readFileSync(backupFile, "utf8")));
  const originalLayer = layerOne(original);
  if (!originalLayer) throw new Error("The backup has no layer 1.");
  // If the pad's keymap is unreadable (a write interrupted by an unplug), it
  // cannot be merged: put the whole original back, which is exactly when a
  // restore is needed most.
  let next: KeymapConfig;
  try {
    const current = await read(call);
    if (!layerOne(current)) throw new Error("no layer 1");
    next = structuredClone(current);
    next.profiles[0].layers[0] = originalLayer;
  } catch {
    next = original;
  }
  await call("fs.write", { file: "keymap.json", data: JSON.stringify(next) });
  const after = await read(call);
  if (JSON.stringify(layerOne(after)) !== JSON.stringify(originalLayer)) {
    throw new Error("The device did not accept the restored keymap.");
  }
}
