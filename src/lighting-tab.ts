// The popup's Lighting tab and the tab header, as pure functions so they can be
// tested without a terminal.
import {
  LIGHTING_PROFILES,
  LIGHTING_PROFILE_NAMES,
  RING_AGENTS,
  RING_RAINBOW,
  RING_SCROLL,
  STATUS_COLORS,
  BOTTOM_PALETTE,
  BOTTOM_ROWS_MODES,
  DEFAULT_BOTTOM,
  type BottomLighting,
  type LightingProfile,
} from "./lights.js";
import { XPAD_ARTS, XPAD_MODES, type XpadArt, type XpadMode } from "./xpad/view.js";

export type Tab = "keys" | "lighting";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function fg(color: number): string {
  return `\x1b[38;2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}m`;
}
const swatch = (color: number, label: string) => `${fg(color)}■${RESET} ${label}`;

export function renderTabs(active: Tab): string {
  const tab = (id: Tab, label: string) =>
    id === active ? `${BOLD}[${label}]${RESET}` : `${DIM} ${label} ${RESET}`;
  return `  ${tab("keys", "Keys")}  ${tab("lighting", "Lighting")}`;
}

const DETAIL: Record<LightingProfile, string> = {
  1:
    `shows the dial mode: off in workspaces, ` +
    `${swatch(RING_AGENTS.c, "blue in agents")}, ${swatch(RING_SCROLL.c, "purple in scroll")}`,
  2:
    `worst agent: ${swatch(STATUS_COLORS.blocked, "blocked")} · ` +
    `${swatch(STATUS_COLORS.working, "working")} · ${swatch(STATUS_COLORS.idle, "idle")} · ` +
    `${swatch(STATUS_COLORS.done, "done")}`,
  3: `${swatch(RING_RAINBOW.c, "stock rainbow")}, speed ${RING_RAINBOW.s}`,
};

export function renderLightingTab(
  active: LightingProfile,
  brightness = 100,
  bottom: BottomLighting = DEFAULT_BOTTOM,
  xpad: { mode: XpadMode; connected: boolean; art: XpadArt } = {
    mode: "off",
    connected: false,
    art: "clawd",
  },
): string[] {
  const lines = [
    `  ${BOLD}Ring lighting${RESET}  ${DIM}the back strip and the border around the pad are one zone${RESET}`,
    "",
  ];
  for (const profile of LIGHTING_PROFILES) {
    const marker = profile === active ? `${BOLD}▶${RESET}` : " ";
    const name = LIGHTING_PROFILE_NAMES[profile].padEnd(22);
    const label = profile === active ? `${BOLD}${name}${RESET}` : name;
    lines.push(`  ${marker} ${BOLD}${profile}${RESET}  ${label}${DIM}${RESET} ${DETAIL[profile]}`);
    lines.push("");
  }
  const filled = Math.round(brightness / 10);
  lines.push(
    `  ${BOLD}Brightness${RESET}  ${"█".repeat(filled)}${DIM}${"░".repeat(10 - filled)}${RESET} ${BOLD}${brightness}%${RESET}  ${DIM}keys and ring${RESET}`,
    "",
  );
  lines.push(
    `  ${BOLD}Bottom rows${RESET}  ` +
      BOTTOM_ROWS_MODES.map((mode) =>
        mode === bottom.mode ? `${BOLD}[${mode}]${RESET}` : `${DIM} ${mode} ${RESET}`,
      ).join(" ") +
      `  ${DIM}the two rows under the agent keys${RESET}`,
  );
  if (bottom.mode === "solid") {
    const cells = BOTTOM_PALETTE.map(({ color }) =>
      color === bottom.color ? `${fg(color)}[■]${RESET}` : `${fg(color)} ■ ${RESET}`,
    ).join("");
    const known = BOTTOM_PALETTE.find((p) => p.color === bottom.color);
    const hex = "#" + bottom.color.toString(16).padStart(6, "0");
    lines.push(`  Colour       ${cells}  ${BOLD}${known?.name ?? "custom"}${RESET} ${DIM}${hex}${RESET}`);
  }
  lines.push("");
  lines.push(
    `  ${BOLD}XPAD Mini${RESET}    ` +
      XPAD_MODES.map((mode) =>
        mode === xpad.mode ? `${BOLD}[${mode}]${RESET}` : `${DIM} ${mode} ${RESET}`,
      ).join(" ") +
      (xpad.mode === "off"
        ? ""
        : `  ${xpad.connected ? "connected" : `${DIM}not found${RESET}`}`),
  );
  lines.push(
    `  ${BOLD}XPAD art${RESET}     ` +
      XPAD_ARTS.map((art) =>
        art === xpad.art ? `${BOLD}[${art}]${RESET}` : `${DIM} ${art} ${RESET}`,
      ).join(" "),
    "",
  );
  lines.push(
    `  ${DIM}1 / 2 / 3 select · + / - brightness · b bottom rows mode · ←/→ colour · x XPAD mode · a XPAD art · r re-push keymap and lights · tab keys view · q close${RESET}`,
  );
  return lines;
}
