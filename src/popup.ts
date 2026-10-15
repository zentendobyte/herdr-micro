// Key-map popup TUI: the six Agent Keys in the device's physical layout (two
// centered on top, four below) as boxes colored by status, fed by the
// daemon's watch stream, plus a Lighting tab for the ring. Keys: p toggles
// sticky/mirror, tab switches tabs, 1/2/3 pick a lighting profile (Lighting
// tab), q / esc / ctrl+c closes.
import { clipEnd, clipStart, padTo, sanitize } from "./text.js";
import {
  sendCommand,
  watchStatus,
  type ControlState,
  type SlotStatus,
  type StatusPayload,
} from "./control.js";
import { BOTTOM_PALETTE, BOTTOM_ROWS_MODES, STATUS_COLORS } from "./lights.js";
import { XPAD_ARTS, XPAD_MODES } from "./xpad/view.js";
import { renderLightingTab, renderTabs, type Tab } from "./lighting-tab.js";

const CELL = 36; // outer box width
const INNER = CELL - 4; // text width inside "│ ... │"
const GAP = 3;
const MARGIN = 3;
const GRID = 4 * CELL + 3 * GAP;
const TOP_INDENT = MARGIN + Math.floor((GRID - (2 * CELL + GAP)) / 2);
const BOX_HEIGHT = 6;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

let status: StatusPayload | null = null;
let tab: Tab = "keys";
let connected = true;
let notice = "";

const STATE_LABELS: Record<ControlState, [number, string]> = {
  connected: [0x22cc55, "connected"],
  connecting: [0xffaa00, "connecting…"],
  yielded: [0xffaa00, "yielded to another app"],
  paused: [0xffaa00, "paused (pad is on another layer)"],
  device_absent: [0xff5555, "not found"],
  permission_required: [0xff5555, "Input Monitoring permission required"],
  device_busy: [0xff5555, "held by another app"],
  stopped: [0xff5555, "released"],
};

function fg(color: number): string {
  return `\x1b[38;2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}m`;
}

function content(text: string, style = ""): string {
  const padded = padTo(text, INNER);
  return `│ ${style ? style + padded + RESET : padded} │`;
}

function field(text: string): string {
  return clipEnd(sanitize(text), INNER);
}

function boxLines(slot: SlotStatus | null, key: number): string[] {
  if (!slot) {
    const top = `┌ [${key}] ` + "─".repeat(CELL - 7) + "┐";
    return [
      DIM + top + RESET,
      DIM + content("") + RESET,
      DIM + content("· empty ·".padStart(Math.floor((INNER + 9) / 2))) + RESET,
      DIM + content("") + RESET,
      DIM + content("") + RESET,
      DIM + "└" + "─".repeat(CELL - 2) + "┘" + RESET,
    ];
  }
  const color = fg(STATUS_COLORS[slot.status]);
  const label = ` [${key}] ● ${slot.status} `;
  const top =
    "┌" + label + "─".repeat(Math.max(0, CELL - 2 - label.length)) + "┐";
  const name = slot.paneName ? `${slot.paneName} (${slot.agent})` : slot.agent;
  return [
    color + BOLD + top + RESET,
    content(field(name)),
    content(field(slot.tab)),
    content(field(slot.workspace)),
    content(clipStart(sanitize(slot.cwd), INNER), DIM),
    color + "└" + "─".repeat(CELL - 2) + "┘" + RESET,
  ];
}

function renderRow(
  slots: (SlotStatus | null)[],
  keys: number[],
  indent: number,
): string[] {
  const boxes = keys.map((key, i) => boxLines(slots[i] ?? null, key));
  return Array.from(
    { length: BOX_HEIGHT },
    (_, line) =>
      " ".repeat(indent) + boxes.map((box) => box[line]).join(" ".repeat(GAP)),
  );
}

function render(): void {
  const out: string[] = ["\x1b[2J\x1b[H"];
  if (!status) {
    out.push("  connecting to Micro daemon...");
  } else {
    // Total over ControlState, so a new device state is a compile error here
    // rather than a raw enum name rendered at runtime.
    const [color, label] = STATE_LABELS[status.state];
    const device = fg(color) + label + RESET;
    const daemon = connected
      ? ""
      : `    ${fg(0xff5555)}daemon disconnected${RESET}`;
    const herdr = status.herdrConnected
      ? ""
      : `    ${fg(0xff5555)}herdr disconnected${RESET}`;
    const dial =
      status.dialMode === "scroll"
        ? `${status.dialMode} (${status.scrollSteps}×)`
        : status.dialMode;
    out.push(
      `  ${BOLD}Micro${RESET}    policy: ${BOLD}${status.policy.toUpperCase()}${RESET}    dial: ${BOLD}${dial}${RESET}    device: ${device}${daemon}${herdr}`,
    );
    if (status.configError) {
      // Clipped: a validation message is unbounded and would wrap the grid.
      const message = clipEnd(sanitize(status.configError), GRID - 16);
      out.push(`  ${fg(0xff5555)}config error: ${message}${RESET}`);
    }
    out.push("  " + DIM + "─".repeat(GRID) + RESET);
    out.push(renderTabs(tab));
    out.push("");
    if (tab === "lighting") {
      out.push(...renderLightingTab(
          status.lightingProfile,
          status.brightness,
          { mode: status.bottomRows, color: status.bottomColor },
          { mode: status.xpadMode, connected: status.xpadConnected, art: status.xpadArt },
        ));
    } else {
      out.push(...renderRow(status.slots.slice(0, 2), [1, 2], TOP_INDENT));
      out.push("");
      out.push(...renderRow(status.slots.slice(2, 6), [3, 4, 5, 6], MARGIN));
      out.push("");
      out.push(`  ${DIM}p toggle policy · r re-push keymap and lights · tab lighting · q close${RESET}`);
    }
  }
  if (notice) out.push("", `  ${DIM}${notice}${RESET}`);
  process.stdout.write(out.join("\r\n") + "\r\n");
}

const watcher = watchStatus(
  (payload) => {
    status = payload;
    connected = true;
    render();
  },
  () => {
    connected = false;
    render();
  },
);

let exiting = false;
function quit(): void {
  if (exiting) process.exit(0);
  exiting = true;
  watcher.stop();
  process.stdin.setRawMode?.(false);
  process.stdout.write(ALT_LEAVE);
  process.exit(0);
}

// The alternate buffer keeps the popup from scribbling over whatever was on
// screen; leaving it restores the caller's view when run outside a Herdr pane.
process.stdout.write(ALT_ENTER);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const key = data.toString("utf8");
  if (key === "q" || key === "\x1b" || key === "\x03") quit();
  if (key === "p") void sendCommand("toggle-policy").catch(() => {});
  if (tab === "lighting" && status && key === "x") {
    const modes = XPAD_MODES;
    const mode = modes[(modes.indexOf(status.xpadMode) + 1) % modes.length];
    void sendCommand("set-xpad", { mode }).catch(() => {});
  }
  if (tab === "lighting" && status && key === "a") {
    const arts = XPAD_ARTS;
    const art = arts[(arts.indexOf(status.xpadArt) + 1) % arts.length];
    void sendCommand("set-xpad-art", { art }).catch(() => {});
  }
  if (tab === "lighting" && status && key === "b") {
    const modes = BOTTOM_ROWS_MODES;
    const mode = modes[(modes.indexOf(status.bottomRows) + 1) % modes.length];
    void sendCommand("set-bottom", { mode }).catch(() => {});
  }
  if (
    tab === "lighting" &&
    status &&
    status.bottomRows === "solid" &&
    (key === "\x1b[C" || key === "\x1b[D")
  ) {
    const colors = BOTTOM_PALETTE.map((p) => p.color);
    const at = Math.max(0, colors.indexOf(status.bottomColor));
    const next = (at + (key === "\x1b[C" ? 1 : colors.length - 1)) % colors.length;
    void sendCommand("set-bottom", { color: colors[next] }).catch(() => {});
  }
  if (key === "r") {
    notice = "re-pushing…";
    render();
    void sendCommand("repush")
      .then((reply) => {
        notice = reply.error
          ? `re-push failed: ${String(reply.error)}`
          : "keymap and lights re-pushed";
      })
      .catch((error: Error) => {
        notice = `re-push failed: ${error.message}`;
      })
      .finally(render);
  }
  if (tab === "lighting" && status && (key === "+" || key === "=" || key === "-")) {
    const step = key === "-" ? -10 : 10;
    const percent = Math.min(100, Math.max(10, status.brightness + step));
    void sendCommand("set-brightness", { percent }).catch(() => {});
  }
  if (key === "\t") {
    tab = tab === "keys" ? "lighting" : "keys";
    render();
  }
  if (tab === "lighting" && (key === "1" || key === "2" || key === "3")) {
    void sendCommand("set-lighting", { profile: Number(key) }).catch(() => {});
  }
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.stdout.on("resize", render);
render();
