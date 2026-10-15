// Plugin file locations and persisted settings. Herdr-provided plugin dirs
// win; the fallbacks mirror Herdr's own plugin path layout so manual launches
// resolve the same locations as hook/action/pane launches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBindings, type Bindings } from "./bindings.js";
import { DEFAULT_DIAL_MODE_ORDER, DIAL_MODES, type DialMode } from "./dial.js";
import {
  BOTTOM_ROWS_MODES,
  LIGHTING_PROFILES,
  type BottomRows,
  type LightingProfile,
} from "./lights.js";
import { XPAD_ARTS, XPAD_MODES, type XpadArt, type XpadMode } from "./xpad/view.js";
import type { Policy } from "./slots.js";

export const PLUGIN_ID = "herdr.micro2";

const herdrDir = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "herdr",
);
export const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ??
  path.join(herdrDir, "plugins", "config", PLUGIN_ID);
// Herdr's own state dir for plugins on Windows (what it passes as
// HERDR_PLUGIN_STATE_DIR); the fallback only matters for manual launches.
const stateDir =
  process.env.HERDR_PLUGIN_STATE_DIR ??
  path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "herdr",
    "plugins",
    PLUGIN_ID,
  );
export const STATE_DIR = stateDir;
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// A named pipe: its name is the daemon's single-instance lock, and it
// disappears with the process, so there is no stale file to clean up. The name
// is per user and deliberately NOT derived from a directory: a daemon started
// from a shell and a popup launched by Herdr can resolve their dirs
// differently and must still find each other.
const pipeUser = os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_");
export const CONTROL_SOCKET = `\\\\.\\pipe\\${PLUGIN_ID}-control-${pipeUser}`;
export const LOG_FILE = path.join(stateDir, "daemon.log");

export interface Config {
  policy: Policy;
  scrollSteps: number;
  dialModeOrder: DialMode[];
  bindings: Bindings;
  /** Process names (without .exe) whose presence makes the daemon yield the pad. */
  yieldTo: string[];
  /** What the ring (back strip + border) shows: 1 dial ring, 2 agent status, 3 rainbow. */
  lightingProfile: LightingProfile;
  /** LED brightness in percent, 10 to 100, applied to the keys and the ring. */
  brightness: number;
  /** What the bottom two rows of keys show: the rainbow, one solid colour, or nothing. */
  bottomRows: BottomRows;
  /** The solid colour (0xRRGGBB), written as "#rrggbb" in the file. */
  bottomColor: number;
  /** Whether the XPAD Mini is driven, and which agent(s) it mirrors. */
  xpadMode: XpadMode;
  /** Which artwork the XPAD's LCD plays. */
  xpadArt: XpadArt;
  /** Process names (no .exe) of the terminals Herdr may run in; an agent key raises one of their windows. */
  terminalProcesses: string[];
  /** Window-title fragments that identify Herdr's window; empty = derive from Herdr's workspace labels. */
  terminalTitleContains: string[];
}

// Throws with an entry-naming message on any invalid config - unparseable
// JSON, a non-object root, an unknown policy, or a bad binding. The caller
// decides whether to fall back to the last good state (daemon) or abort.
export function loadConfig(): Config {
  const raw = readRawConfig();
  return {
    policy: resolvePolicy(raw.policy),
    scrollSteps: resolveScrollSteps(raw.scroll_steps),
    dialModeOrder: resolveDialModeOrder(raw.dial_mode_order),
    bindings: resolveBindings(raw.bindings),
    yieldTo: resolveYieldTo(raw.yield_to),
    lightingProfile: resolveLightingProfile(raw.lighting_profile),
    brightness: resolveBrightness(raw.brightness),
    bottomRows: resolveBottomRows(raw.bottom_rows, raw.rainbow_keys),
    bottomColor: resolveBottomColor(raw.bottom_color),
    xpadMode: resolveXpadMode(raw.xpad_mode),
    xpadArt: resolveXpadArt(raw.xpad_art),
    terminalProcesses: resolveTerminalProcesses(raw.terminal_processes),
    terminalTitleContains: resolveTitleHints(raw.terminal_title_contains),
  };
}

// Read-modify-write preserving fields this writer does not own (bindings and
// anything a future version adds). Propagates the read error rather than
// treating an unreadable file as empty: writing over a config we could not
// parse would silently delete every binding in it.
export function savePolicy(policy: Policy): void {
  saveSetting("policy", policy);
}

export function saveLightingProfile(profile: LightingProfile): void {
  saveSetting("lighting_profile", profile);
}

export function saveBrightness(percent: number): void {
  saveSetting("brightness", percent);
}

export function saveBottomRows(mode: BottomRows): void {
  saveSetting("bottom_rows", mode);
}

export function saveBottomColor(color: number): void {
  saveSetting("bottom_color", "#" + color.toString(16).padStart(6, "0"));
}

export function saveXpadMode(mode: XpadMode): void {
  saveSetting("xpad_mode", mode);
}

export function saveXpadArt(art: XpadArt): void {
  saveSetting("xpad_art", art);
}

function saveSetting(key: string, value: unknown): void {
  const raw = readRawConfig();
  raw[key] = value;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_FILE);
}

// Both dirs, because the daemon watches CONFIG_DIR: watching a directory that
// does not exist fails permanently, and Herdr only pre-creates it for plugin
// launches it owns.
export function ensurePluginDirs(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
}

function resolvePolicy(value: unknown): Policy {
  if (value === undefined) return "sticky";
  if (value === "sticky" || value === "mirror") return value;
  throw new Error(
    `policy: expected "sticky" or "mirror", got ${JSON.stringify(value)}`,
  );
}

function resolveScrollSteps(value: unknown): number {
  if (value === undefined) return 1;
  if (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 12
  ) {
    return value as number;
  }
  throw new Error(
    `scroll_steps: expected an integer from 1 to 12, got ${JSON.stringify(value)}`,
  );
}

function resolveDialModeOrder(value: unknown): DialMode[] {
  if (value === undefined) return [...DEFAULT_DIAL_MODE_ORDER];
  const validModes = DIAL_MODES as readonly unknown[];
  if (
    !Array.isArray(value) ||
    value.length !== DIAL_MODES.length ||
    !value.every((mode) => validModes.includes(mode)) ||
    new Set(value).size !== DIAL_MODES.length
  ) {
    throw new Error(
      `dial_mode_order: expected each of ${DIAL_MODES.join(", ")} exactly once, got ${JSON.stringify(value)}`,
    );
  }
  return value as DialMode[];
}

function resolveTerminalProcesses(value: unknown): string[] {
  if (value === undefined) return ["WindowsTerminal", "wezterm-gui"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((name) => typeof name === "string" && name.trim() !== "")
  ) {
    throw new Error(
      `terminal_processes: expected a non-empty list of process names, got ${JSON.stringify(value)}`,
    );
  }
  return value.map((name) => String(name).trim());
}

function resolveTitleHints(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((hint) => typeof hint === "string" && hint.trim() !== "")
  ) {
    throw new Error(
      `terminal_title_contains: expected a list of strings, got ${JSON.stringify(value)}`,
    );
  }
  return value.map((hint) => String(hint));
}

function resolveLightingProfile(value: unknown): LightingProfile {
  if (value === undefined) return 1;
  if ((LIGHTING_PROFILES as readonly unknown[]).includes(value)) {
    return value as LightingProfile;
  }
  throw new Error(
    `lighting_profile: expected 1, 2 or 3, got ${JSON.stringify(value)}`,
  );
}

function resolveBrightness(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value === "number" && value >= 10 && value <= 100) {
    return Math.round(value);
  }
  throw new Error(
    `brightness: expected a percentage from 10 to 100, got ${JSON.stringify(value)}`,
  );
}

// rainbow_keys (true/false) was the first form of this setting; it still
// counts when bottom_rows is absent.
function resolveBottomRows(value: unknown, legacy: unknown): BottomRows {
  if (value === undefined) return legacy === false ? "off" : "rainbow";
  if ((BOTTOM_ROWS_MODES as readonly unknown[]).includes(value)) {
    return value as BottomRows;
  }
  throw new Error(
    `bottom_rows: expected "rainbow", "solid" or "off", got ${JSON.stringify(value)}`,
  );
}

function resolveBottomColor(value: unknown): number {
  if (value === undefined) return 0xffffff;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return parseInt(value.slice(1), 16);
  }
  throw new Error(
    `bottom_color: expected a colour like "#ffffff", got ${JSON.stringify(value)}`,
  );
}

// Off by default: the pad is optional hardware, and its vendor channels should
// not be opened on machines that do not have one.
function resolveXpadMode(value: unknown): XpadMode {
  if (value === undefined) return "off";
  if ((XPAD_MODES as readonly unknown[]).includes(value)) return value as XpadMode;
  throw new Error(
    `xpad_mode: expected "off", "worst", "focused" or "per-key", got ${JSON.stringify(value)}`,
  );
}

function resolveXpadArt(value: unknown): XpadArt {
  if (value === undefined) return "clawd";
  if ((XPAD_ARTS as readonly unknown[]).includes(value)) return value as XpadArt;
  throw new Error(`xpad_art: expected "clawd" or "pixel", got ${JSON.stringify(value)}`);
}

function resolveYieldTo(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((name) => typeof name === "string" && name.trim() !== "")
  ) {
    throw new Error(
      `yield_to: expected a list of process names, got ${JSON.stringify(value)}`,
    );
  }
  return value.map((name) => String(name).trim());
}

function readRawConfig(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch (error) {
    // Only "no config yet" is a normal state; anything else is a real fault.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${CONFIG_FILE}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
