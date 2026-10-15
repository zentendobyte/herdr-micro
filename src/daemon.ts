// The Codex Micro broker daemon: owns the HID connection, mirrors Herdr agent
// state onto the six Agent Key LEDs, and routes device input back into Herdr.
// Session-leased: if Herdr stays unreachable beyond the lease, the daemon
// clears the LEDs, releases the device, and exits.
import path from "node:path";
import { processRunning } from "./contention.js";
import { MicroDevice } from "./device.js";
import { raiseTerminal as raiseTerminalWindow } from "./tapkey.js";
import { translateHid } from "./inputs.js";
import * as keymap from "./keymap.js";
import { isOwnedLayer } from "./layer.js";
import {
  HerdrClient,
  HerdrError,
  subscribe,
  type AgentInfo,
  type PaneInfo,
  type Subscription,
} from "./herdr.js";
import fs from "node:fs";
import { Controls } from "./controls.js";
import { ControlServer, type SlotStatus } from "./control.js";
import { DEFAULT_DIAL_MODE_ORDER, type DialMode } from "./dial.js";
import {
  BOTTOM_ROWS_MODES,
  DEFAULT_BOTTOM,
  LIGHTING_PROFILES,
  RING_OFF,
  ringForProfile,
  scaled,
  slotLighting,
  worstStatus,
  type BottomLighting,
  type BottomRows,
  type LightingProfile,
} from "./lights.js";
import {
  assignSlots,
  SLOT_COUNT,
  type AgentStatus,
  type Policy,
} from "./slots.js";
import { defaultBindings, type Bindings } from "./bindings.js";
import { XpadHost } from "./xpad/host.js";
import { XPAD_ARTS, XPAD_MODES, resolveXpadView, type XpadArt, type XpadMode } from "./xpad/view.js";
import {
  CONFIG_DIR,
  STATE_DIR,
  ensurePluginDirs,
  loadConfig,
  saveBrightness,
  saveBottomColor,
  saveBottomRows,
  saveXpadArt,
  saveXpadMode,
  saveLightingProfile,
  savePolicy,
  PLUGIN_ID,
} from "./config.js";

const REFRESH_DEBOUNCE_MS = 75;
const HERDR_RETRY_MS = 3000;
const HERDR_LEASE_MS = 60_000;
const YIELD_POLL_MS = 4000;
const LAYER_POLL_MS = 2000;
const CONFIG_RELOAD_DEBOUNCE_MS = 300;
const CONFIG_WATCH_RETRY_MS = 5000;
// Releasing the device outranks tidying Herdr's sidebar: if Herdr is wedged,
// stop waiting on it and finish shutting down.
const SHUTDOWN_CLEANUP_MS = 3000;
const KEY_GLYPHS = ["①", "②", "③", "④", "⑤", "⑥"];

const BASE_SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
  // Renames change the labels the popup shows for a slot.
  { type: "workspace.renamed" },
  { type: "tab.renamed" },
];

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function shortenHome(path: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// Resolves either way after ms, so a wedged peer cannot stall an exit path.
function atMost(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

class Daemon {
  private herdr = new HerdrClient();
  private policy: Policy = "sticky";
  private scrollSteps = 1;
  private dialModeOrder: DialMode[] = [...DEFAULT_DIAL_MODE_ORDER];
  private bindings: Bindings = defaultBindings();
  private configError: string | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private configWatchRetryTimer: NodeJS.Timeout | null = null;
  private slots: (string | null)[] = Array.from(
    { length: SLOT_COUNT },
    () => null,
  );
  private slotDetails: (SlotStatus | null)[] = Array.from(
    { length: SLOT_COUNT },
    () => null,
  );
  private agents = new Map<string, AgentInfo>();
  private tokenPanes = new Map<string, string>();
  private lastLighting = "";
  private lightingProfile: LightingProfile = 1;
  private brightness = 100;
  private xpadMode: XpadMode = "off";
  private xpadArt: XpadArt = "clawd";
  private xpad = new XpadHost(log, () => this.control.broadcast());
  private bottom: BottomLighting = { ...DEFAULT_BOTTOM };
  private terminalProcesses: string[] = ["WindowsTerminal", "wezterm-gui"];
  private terminalTitleContains: string[] = [];
  private lastRing = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshQueued: Promise<void> | null = null;
  private subGeneration = 0;
  private closeSubscription: (() => void) | null = null;
  private subRetryTimer: NodeJS.Timeout | null = null;
  private subscribedPanes = "";
  private herdrReached = false;
  private herdrLostAt: number | null = null;
  private yielded = false;
  private paused = false;
  private yieldTo: string[] = [];
  private yieldTimer: NodeJS.Timeout | null = null;
  private yieldPolling = false;
  private layerTimer: NodeJS.Timeout | null = null;
  private layerChecking = false;
  private keymapError: string | null = null;
  private lastForeignLog = 0;
  private stopping = false;

  private device = new MicroDevice(
    {
      onConnect: () => void this.onDeviceConnected(),
      onDisconnect: () => this.controls.resetInputState(),
      onStateChange: () => this.control.broadcast(),
      onHid: (key, act) => this.onHid(key, act),
      onJoystick: (angle, distance) => this.onJoystick(angle, distance),
      onForeign: () => this.noteForeign(),
    },
    log,
  );

  private controls = new Controls(
    this.herdr,
    {
      bindings: () => this.bindings,
      scrollSteps: () => this.scrollSteps,
      dialModeOrder: () => this.dialModeOrder,
      slotPaneId: (slot) => this.agentForSlot(slot)?.pane_id ?? null,
      togglePopup: () => void this.togglePopup(),
      togglePolicy: () => this.togglePolicy(),
      onDialModeChange: (mode) => this.onDialModeChange(mode),
      raiseTerminal: () => void this.raiseTerminal(),
    },
    log,
  );

  private control = new ControlServer({
    status: () => ({
      policy: this.policy,
      scrollSteps: this.scrollSteps,
      lightingProfile: this.lightingProfile,
      brightness: this.brightness,
      bottomRows: this.bottom.mode,
      bottomColor: this.bottom.color,
      xpadMode: this.xpadMode,
      xpadConnected: this.xpad.connected,
      xpadArt: this.xpadArt,
      dialMode: this.controls.dialMode,
      dialModeOrder: this.dialModeOrder,
      state: this.yielded
        ? "yielded"
        : this.paused
          ? "paused"
          : this.device.state,
      herdrConnected: this.herdrReached && this.herdrLostAt === null,
      configError:
        this.configError ??
        (this.keymapError ? `keymap: ${this.keymapError}` : null),
      slots: this.slotDetails,
    }),
    togglePolicy: () => this.togglePolicy(),
    popup: () => void this.togglePopup(),
    stop: () => void this.shutdown(),
    restoreKeymap: () => this.restoreKeymap(),
    setLightingProfile: (profile) => this.setLightingProfile(profile),
    setBrightness: (percent) => this.setBrightness(percent),
    setBottom: (mode, color) => this.setBottom(mode, color),
    setXpadMode: (mode) => this.setXpadMode(mode),
    setXpadArt: (art) => this.setXpadArt(art),
    repush: () => this.repush(),
    // Slot labels are resolved lazily; the arrival of a watcher is what makes
    // them worth fetching.
    watchersChanged: () => this.scheduleRefresh(),
  });

  async start(): Promise<void> {
    ensurePluginDirs();
    await this.control.listen();
    this.applyConfig(true);
    this.watchConfig();
    log(`daemon started, policy: ${this.policy}`);
    process.on("SIGTERM", () => void this.shutdown());
    process.on("SIGINT", () => void this.shutdown());
    this.device.start();
    this.maintainSubscription();
    this.yieldTimer = setInterval(() => void this.pollYield(), YIELD_POLL_MS);
    this.layerTimer = setInterval(() => void this.pollLayer(), LAYER_POLL_MS);
  }

  // Invalid config never kills the daemon: it keeps the last good (or
  // default) state and surfaces the validation error through status, which
  // is the feedback loop a config-editing agent reads.
  private applyConfig(initial = false): void {
    try {
      const config = loadConfig();
      const policyChanged = config.policy !== this.policy;
      this.policy = config.policy;
      this.scrollSteps = config.scrollSteps;
      this.dialModeOrder = config.dialModeOrder;
      this.bindings = config.bindings;
      this.yieldTo = config.yieldTo;
      this.terminalProcesses = config.terminalProcesses;
      this.terminalTitleContains = config.terminalTitleContains;
      const profileChanged = config.lightingProfile !== this.lightingProfile;
      this.lightingProfile = config.lightingProfile;
      const brightnessChanged = config.brightness !== this.brightness;
      this.brightness = config.brightness;
      const bottomChanged =
        config.bottomRows !== this.bottom.mode ||
        config.bottomColor !== this.bottom.color;
      this.bottom = { mode: config.bottomRows, color: config.bottomColor };
      if (brightnessChanged || bottomChanged) {
        this.lastLighting = "";
        this.lastRing = "";
        void this.pushLighting();
      }
      if (profileChanged || brightnessChanged) this.pushRing();
      this.xpadMode = config.xpadMode;
      this.xpadArt = config.xpadArt;
      this.applyXpad();
      this.configError = null;
      if (initial) this.controls.resetDialMode();
      // A mode nothing can toggle anymore must not linger: without any
      // dial-mode binding, collapse back to workspace mode.
      const hasDialMode = [
        ...Object.values(this.bindings.buttons),
        ...Object.values(this.bindings.joystick),
      ].some(
        (binding) =>
          binding?.kind === "preset" && binding.preset === "dial-mode",
      );
      if (!hasDialMode && this.controls.dialMode !== "workspaces") {
        this.controls.resetDialMode("workspaces");
        this.pushRing();
      }
      if (!initial) {
        log(`config applied, policy: ${this.policy}`);
        if (policyChanged) this.scheduleRefresh();
      }
    } catch (error) {
      this.configError = (error as Error).message;
      log(`config invalid, keeping previous: ${this.configError}`);
    }
    this.control.broadcast();
  }

  // Watches the config dir (not the file: atomic tmp+rename writes replace
  // the inode) and hot-applies changes; no restart needed for config edits.
  // Retries, because a watch that failed once must not disable hot-reload for
  // the life of the daemon.
  private watchConfig(): void {
    if (this.stopping) return;
    try {
      this.configWatcher = fs.watch(CONFIG_DIR, () => {
        if (this.configReloadTimer) return;
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null;
          this.applyConfig();
        }, CONFIG_RELOAD_DEBOUNCE_MS);
      });
    } catch (error) {
      log(`config watch unavailable, retrying: ${(error as Error).message}`);
      this.configWatchRetryTimer = setTimeout(
        () => this.watchConfig(),
        CONFIG_WATCH_RETRY_MS,
      );
    }
  }

  private togglePolicy(): Policy {
    const next: Policy = this.policy === "sticky" ? "mirror" : "sticky";
    try {
      savePolicy(next); // the file watcher applies and broadcasts it
    } catch (error) {
      // Persisting over a config we could not parse would delete the user's
      // bindings, so refuse and report instead.
      this.configError = (error as Error).message;
      log(`policy not saved: ${this.configError}`);
      this.control.broadcast();
      return this.policy;
    }
    this.policy = next;
    log(`policy: ${this.policy}`);
    this.scheduleRefresh();
    return this.policy;
  }

  // Chosen from the popup's Lighting tab: persisted, applied at once.
  private setLightingProfile(profile: unknown): LightingProfile {
    if (!(LIGHTING_PROFILES as readonly unknown[]).includes(profile)) {
      throw new Error("lighting profile must be 1, 2 or 3");
    }
    const next = profile as LightingProfile;
    try {
      saveLightingProfile(next);
    } catch (error) {
      // Same rule as the policy: never overwrite a config we could not parse.
      this.configError = (error as Error).message;
      log(`lighting profile not saved: ${this.configError}`);
      this.control.broadcast();
      throw error;
    }
    this.lightingProfile = next;
    log(`lighting profile: ${next}`);
    this.pushRing();
    this.control.broadcast();
    return next;
  }

  // Chosen from the popup's Lighting tab: persisted, applied at once.
  private setBrightness(percent: unknown): number {
    if (typeof percent !== "number" || percent < 10 || percent > 100) {
      throw new Error("brightness must be a percentage from 10 to 100");
    }
    const next = Math.round(percent);
    try {
      saveBrightness(next);
    } catch (error) {
      this.configError = (error as Error).message;
      log(`brightness not saved: ${this.configError}`);
      this.control.broadcast();
      throw error;
    }
    this.brightness = next;
    this.xpad.setBrightness(next);
    log(`brightness: ${next}%`);
    this.lastLighting = "";
    this.lastRing = "";
    void this.pushLighting();
    this.pushRing();
    this.control.broadcast();
    return next;
  }

  // Chosen from the popup Lighting tab: persisted, applied at once.
  private setXpadMode(mode: unknown): XpadMode {
    if (!(XPAD_MODES as readonly unknown[]).includes(mode)) {
      throw new Error('xpad mode must be "off", "worst", "focused" or "per-key"');
    }
    const next = mode as XpadMode;
    try {
      saveXpadMode(next);
    } catch (error) {
      this.configError = (error as Error).message;
      log(`xpad mode not saved: ${this.configError}`);
      this.control.broadcast();
      throw error;
    }
    this.xpadMode = next;
    log(`xpad mode: ${next}`);
    this.applyXpad();
    this.control.broadcast();
    return next;
  }

  private setXpadArt(art: unknown): XpadArt {
    if (!(XPAD_ARTS as readonly unknown[]).includes(art)) {
      throw new Error('xpad art must be "clawd" or "pixel"');
    }
    const next = art as XpadArt;
    try {
      saveXpadArt(next);
    } catch (error) {
      this.configError = (error as Error).message;
      log(`xpad art not saved: ${this.configError}`);
      this.control.broadcast();
      throw error;
    }
    this.xpadArt = next;
    log(`xpad art: ${next}`);
    this.applyXpad();
    this.control.broadcast();
    return next;
  }

  // The XPAD Mini runs in its own worker and only while its mode is not off.
  private applyXpad(): void {
    if (this.xpadMode === "off") {
      this.xpad.stop();
      return;
    }
    this.xpad.setBrightness(this.brightness);
    this.xpad.setArt(this.xpadArt);
    this.xpad.start();
    this.pushXpad();
  }

  // Independent of the Micro 2: a paused or yielded Micro does not blank this.
  private pushXpad(): void {
    if (this.xpadMode === "off" || this.stopping) return;
    const agents = [...this.agents.values()].map((agent) => ({
      status: agent.agent_status,
      focused: agent.focused,
    }));
    const slots = this.slottedAgents().map(
      (agent): AgentStatus | null => agent?.agent_status ?? null,
    );
    this.xpad.setView(resolveXpadView(this.xpadMode, agents, slots));
  }

  // Chosen from the popup Lighting tab: persisted, applied at once. Either
  // part may be left out to keep its current value.
  private setBottom(
    mode: unknown,
    color: unknown,
  ): { bottomRows: BottomRows; bottomColor: number } {
    if (mode !== undefined && !(BOTTOM_ROWS_MODES as readonly unknown[]).includes(mode)) {
      throw new Error('bottom rows must be "rainbow", "solid" or "off"');
    }
    if (
      color !== undefined &&
      !(Number.isInteger(color) && (color as number) >= 0 && (color as number) <= 0xffffff)
    ) {
      throw new Error("bottom colour must be an RGB integer");
    }
    const next: BottomLighting = {
      mode: (mode as BottomRows | undefined) ?? this.bottom.mode,
      color: (color as number | undefined) ?? this.bottom.color,
    };
    try {
      if (next.mode !== this.bottom.mode) saveBottomRows(next.mode);
      if (next.color !== this.bottom.color) saveBottomColor(next.color);
    } catch (error) {
      this.configError = (error as Error).message;
      log(`bottom rows not saved: ${this.configError}`);
      this.control.broadcast();
      throw error;
    }
    this.bottom = next;
    log(`bottom rows: ${next.mode} #${next.color.toString(16).padStart(6, "0")}`);
    this.lastLighting = "";
    void this.pushLighting();
    this.control.broadcast();
    return { bottomRows: next.mode, bottomColor: next.color };
  }

  // Another app (Work Louder Input) may have rewritten the keymap or the
  // lighting; this re-binds what drifted and writes every LED again.
  private async repush(): Promise<void> {
    if (!this.device.connected) throw new Error("the pad is not connected");
    if (this.yielded) throw new Error("yielded to another app");
    await this.ensureKeymap();
    if (this.keymapError) throw new Error(`keymap: ${this.keymapError}`);
    this.lastLighting = "";
    this.lastRing = "";
    await this.pushLighting();
    this.pushRing();
    log("keymap and lighting re-pushed");
  }

  // Herdr selects the agent but leaves its terminal wherever it was in the
  // window order, so an agent key pressed from another app would change a pane
  // nobody can see. Herdr titles its window "<host>: <workspace>", which tells
  // its window apart from other windows of the same terminal process.
  private async raiseTerminal(): Promise<void> {
    let hints = this.terminalTitleContains;
    if (hints.length === 0) {
      hints = ["herdr"];
      try {
        const labels = (await this.herdr.workspaceList())
          .map((workspace) => workspace.label)
          .filter((label) => label);
        hints = [...labels.map((label) => `: ${label}`), ...hints];
      } catch {
        // No labels: the topmost terminal window is the fallback.
      }
    }
    await raiseTerminalWindow(this.terminalProcesses, hints, log);
  }

  private onDialModeChange(mode: DialMode): void {
    log(`dial mode: ${mode}`);
    this.herdr
      .request("notification.show", { title: `dial → ${mode}` })
      .catch(() => {});
    this.pushRing();
    this.control.broadcast();
  }

  private pushRing(): void {
    if (!this.device.connected || this.yielded || this.paused || this.stopping) {
      return;
    }
    const worst = worstStatus(
      [...this.agents.values()].map((agent) => agent.agent_status),
    );
    const base = ringForProfile(
      this.lightingProfile,
      this.controls.dialMode,
      worst,
    );
    const lighting = { ...base, b: scaled(base.b, this.brightness) };
    // Agent status changes on every refresh; only write when the ring changes.
    const key = JSON.stringify(lighting);
    if (key === this.lastRing) return;
    this.lastRing = key;
    this.device.setAmbientLighting(lighting).catch((error: Error) => {
      this.lastRing = "";
      log(`ring update failed: ${error.message}`);
    });
  }

  // Clears every LED and hands the device back. Used both when yielding to
  // the ChatGPT app and on shutdown.
  private async blankDevice(): Promise<void> {
    if (!this.device.connected) return;
    this.lastRing = "";
    await this.device.setThreadLighting(slotLighting([])).catch(() => {});
    await this.device.setAmbientLighting(RING_OFF).catch(() => {});
  }

  // Another host (named in yield_to) on the pad: let go while it runs.
  private async pollYield(): Promise<void> {
    // Overlapping polls could interleave a yield and a reclaim and leave the
    // device stopped while this.yielded says otherwise.
    if (this.stopping || this.yieldPolling) return;
    this.yieldPolling = true;
    try {
      const running = await processRunning(this.yieldTo);
      if (this.stopping || running === this.yielded) return;
      this.yielded = running;
      if (running) {
        log("a yield_to app is running, yielding the device");
        this.controls.resetInputState();
        await this.blankDevice();
        await this.device.stop();
      } else {
        log("yield_to app gone, reclaiming the device");
        this.device.start();
      }
      this.control.broadcast();
    } finally {
      this.yieldPolling = false;
    }
  }

  // Bindings and lights belong to layer 1. On any other layer (the Input
  // app's profile 2 and 3) the pad is left alone: dark, input ignored.
  private async pollLayer(): Promise<void> {
    if (
      this.stopping ||
      this.yielded ||
      this.layerChecking ||
      !this.device.connected
    ) {
      return;
    }
    this.layerChecking = true;
    try {
      const status = (await this.device.call("device.status")) as {
        profile_index?: unknown;
        layer_index?: unknown;
      };
      const paused = !isOwnedLayer(status ?? {});
      if (paused === this.paused) return;
      this.paused = paused;
      if (paused) {
        log("pad is on another layer, pausing");
        this.controls.resetInputState();
        await this.blankDevice();
      } else {
        log("pad is back on layer 1, resuming");
        this.lastLighting = "";
        this.lastRing = "";
        await this.pushLighting();
        this.pushRing();
      }
      this.control.broadcast();
    } catch {
      // A missed poll is transient; the next one decides.
    } finally {
      this.layerChecking = false;
    }
  }

  private async onDeviceConnected(): Promise<void> {
    await this.ensureKeymap();
    this.paused = false;
    await this.pollLayer();
    this.lastLighting = "";
    this.lastRing = "";
    void this.pushLighting();
    this.pushRing();
  }

  // Per-key lighting and key events need KV_OAI_AG* bindings on layer 1; this
  // writes them only when they differ, after saving the original once.
  private async ensureKeymap(): Promise<void> {
    // The first fs.read after the pad (re)connects can time out while the
    // firmware is still settling, so a failure is retried before it is shown.
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const changed = await keymap.apply((m, p) => this.device.call(m, p), {
          backupDir: path.join(STATE_DIR, "backup"),
        });
        this.keymapError = null;
        if (changed) log("keymap bound for Herdr (original layer saved)");
        break;
      } catch (error) {
        this.keymapError = (error as Error).message;
        log(`keymap bind failed (try ${attempt}/${attempts}): ${this.keymapError}`);
        if (attempt === attempts || !this.device.connected || this.stopping) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    this.control.broadcast();
  }

  // Puts the original layer 1 back, then stops: with the bindings gone the
  // daemon has nothing to drive, and a restart would just re-bind them.
  private async restoreKeymap(): Promise<void> {
    if (!this.device.connected) throw new Error("the pad is not connected");
    await keymap.restore(
      (m, p) => this.device.call(m, p),
      path.join(STATE_DIR, "backup"),
    );
    log("original layer-1 keymap restored; stopping");
    setTimeout(() => void this.shutdown(), 200);
  }

  private onHid(key: string, act: number): void {
    if (this.paused || this.yielded) return;
    const input = translateHid(key, act);
    if (input) this.controls.onHid(input.key, input.act);
  }

  private onJoystick(angle: number, distance: number): void {
    if (this.paused || this.yielded) return;
    this.controls.onJoystick(angle, distance);
  }

  private noteForeign(): void {
    if (Date.now() - this.lastForeignLog < 60_000) return;
    this.lastForeignLog = Date.now();
    log("replies to requests this daemon never made: another app is talking to the pad");
  }

  // Keeps one events connection alive, rebuilt whenever the agent pane set
  // changes (per-pane status subscriptions cannot be added incrementally).
  // Generation tags distinguish intentional closes from failures.
  private maintainSubscription(): void {
    if (this.stopping) return;
    const generation = ++this.subGeneration;
    void (async () => {
      try {
        // Awaiting a refresh that started after this call matters: Herdr
        // rejects the whole batch if any subscribed pane has since closed.
        await this.runRefresh();
        if (this.stopping || generation !== this.subGeneration) return;
        const panes = this.agentPaneIds();
        const subscriptions = [
          ...BASE_SUBSCRIPTIONS,
          ...panes.map((paneId) => ({
            type: "pane.agent_status_changed",
            pane_id: paneId,
          })),
        ];
        const close = await subscribe(
          subscriptions,
          () => this.scheduleRefresh(),
          () =>
            this.onSubscriptionLost(
              generation,
              new Error("events connection closed"),
            ),
        );
        if (this.stopping || generation !== this.subGeneration) {
          close();
          return;
        }
        this.closeSubscription = close;
        this.subscribedPanes = panes.join(",");
        this.herdrReached = true;
        this.herdrLostAt = null;
        log(`subscribed to ${panes.length} agent panes`);
        // Reconcile anything that changed between the snapshot and the ack.
        this.scheduleRefresh();
      } catch (error) {
        this.onSubscriptionLost(generation, error as Error);
      }
    })();
  }

  private onSubscriptionLost(generation: number, error: Error): void {
    if (this.stopping || generation !== this.subGeneration) return;
    this.closeSubscription = null;
    // Herdr answering with an error proves it is reachable. It probes every
    // pane-scoped subscription at subscribe time and refuses the whole batch
    // if one pane has closed since the snapshot, which is a lost race, not a
    // dead server - counting it against the lease would exit the daemon and
    // go dark while Herdr was fine.
    if (error instanceof HerdrError) {
      this.herdrReached = true;
      this.herdrLostAt = null;
    } else {
      this.herdrLostAt ??= Date.now();
      if (Date.now() - this.herdrLostAt > HERDR_LEASE_MS) {
        log("herdr unreachable beyond lease, releasing device and exiting");
        void this.shutdown();
        return;
      }
    }
    log(`resubscribing in ${HERDR_RETRY_MS}ms: ${error.message}`);
    this.subRetryTimer = setTimeout(
      () => this.maintainSubscription(),
      HERDR_RETRY_MS,
    );
  }

  private rebuildSubscription(): void {
    this.subGeneration++; // invalidates the old connection's onClose
    this.closeSubscription?.();
    this.closeSubscription = null;
    this.maintainSubscription();
  }

  private scheduleRefresh(): void {
    if (this.stopping || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runRefresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  // Single-flight, and the returned promise always covers a refresh that
  // began no earlier than the call: awaiting it therefore guarantees a fresh
  // snapshot, which a caller building a subscription list depends on.
  private runRefresh(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.executeRefresh().finally(() => {
        this.refreshing = null;
      });
      return this.refreshing;
    }
    this.refreshQueued ??= this.refreshing
      .catch(() => {})
      .then(() => {
        this.refreshQueued = null;
        return this.runRefresh();
      });
    return this.refreshQueued;
  }

  private async executeRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      log(`refresh failed: ${(error as Error).message}`);
    }
  }

  private async refresh(): Promise<void> {
    const list = await this.herdr.agentList();
    this.agents = new Map(list.map((agent) => [agent.terminal_id, agent]));
    this.slots = assignSlots(
      this.slots,
      list.map((agent) => ({
        terminalId: agent.terminal_id,
        status: agent.agent_status,
        seq: agent.state_change_seq,
      })),
      this.policy,
    );
    await this.updateSlotDetails();
    await this.updateKeyTokens();
    await this.pushLighting();
    this.pushRing();
    this.control.broadcast();

    if (
      this.closeSubscription &&
      this.agentPaneIds().join(",") !== this.subscribedPanes
    ) {
      this.rebuildSubscription();
    }
  }

  /** Sorted pane ids of every known agent; the subscription's identity. */
  private agentPaneIds(): string[] {
    return [...this.agents.values()].map((agent) => agent.pane_id).sort();
  }

  private agentForSlot(slot: number): AgentInfo | null {
    const terminalId = this.slots[slot] ?? null;
    return terminalId ? (this.agents.get(terminalId) ?? null) : null;
  }

  private slottedAgents(): (AgentInfo | null)[] {
    return this.slots.map((_, i) => this.agentForSlot(i));
  }

  // One failed lookup must not discard the ones that succeeded.
  private async orEmpty<T>(work: Promise<T[]>, what: string): Promise<T[]> {
    try {
      return await work;
    } catch (error) {
      log(`${what} lookup failed: ${(error as Error).message}`);
      return [];
    }
  }

  // Resolves the display facts the popup shows per slot: pane name, workspace
  // and tab labels, and the pane's live working directory. Those cost 2+N
  // socket round trips and feed nothing but the popup, so they are resolved
  // only while something is watching; otherwise the slots fall back to ids,
  // and the first watcher triggers a refresh that fills them in.
  private async updateSlotDetails(): Promise<void> {
    const agents = this.slottedAgents();
    const present = agents.filter(
      (agent): agent is AgentInfo => agent !== null,
    );
    let workspaceLabels = new Map<string, string>();
    let tabLabels = new Map<string, string>();
    let panes = new Map<string, PaneInfo>();
    if (present.length > 0 && this.control.hasWatchers) {
      const workspaceIds = [
        ...new Set(present.map((agent) => agent.workspace_id)),
      ];
      const [workspaces, paneInfos, tabLists] = await Promise.all([
        this.orEmpty(this.herdr.workspaceList(), "workspace"),
        this.orEmpty(this.herdr.paneList(), "pane"),
        Promise.all(
          workspaceIds.map((id) => this.orEmpty(this.herdr.tabList(id), "tab")),
        ),
      ]);
      workspaceLabels = new Map(
        workspaces.map((w) => [w.workspace_id, w.label]),
      );
      panes = new Map(paneInfos.map((pane) => [pane.pane_id, pane]));
      tabLabels = new Map(
        tabLists
          .flat()
          .flatMap((tab) =>
            tab.label ? [[tab.tab_id, tab.label] as const] : [],
          ),
      );
    }
    this.slotDetails = agents.map((agent, i) => {
      if (!agent) return null;
      const pane = panes.get(agent.pane_id);
      const cwd = pane?.foreground_cwd ?? pane?.cwd ?? "";
      return {
        key: i + 1,
        paneId: agent.pane_id,
        agent: agent.agent ?? "agent",
        paneName: pane?.label ?? agent.name ?? null,
        workspace:
          workspaceLabels.get(agent.workspace_id) ?? agent.workspace_id,
        tab: tabLabels.get(agent.tab_id) ?? "",
        cwd: shortenHome(cwd),
        status: agent.agent_status,
      };
    });
  }

  private async pushLighting(): Promise<void> {
    this.pushXpad();
    if (this.yielded || this.paused || this.stopping) return;
    const statuses = this.slottedAgents().map(
      (agent): AgentStatus | null => agent?.agent_status ?? null,
    );
    const lighting = slotLighting(statuses, this.brightness, this.bottom);
    const key = JSON.stringify(lighting);
    if (key === this.lastLighting || !this.device.connected) return;
    try {
      await this.device.setThreadLighting(lighting);
      this.lastLighting = key;
    } catch (error) {
      log(`lighting update failed: ${(error as Error).message}`);
    }
  }

  // Stamps each slotted agent's sidebar row with its key glyph via the $key
  // metadata token. Only confirmed writes update the cache, so failures retry
  // on the next refresh.
  private async updateKeyTokens(): Promise<void> {
    const desired = new Map<string, string>();
    this.slottedAgents().forEach((agent, i) => {
      if (agent) desired.set(agent.pane_id, KEY_GLYPHS[i]!);
    });
    const ops: [string, string | null][] = [];
    for (const [paneId, glyph] of desired) {
      if (this.tokenPanes.get(paneId) !== glyph) ops.push([paneId, glyph]);
    }
    for (const paneId of this.tokenPanes.keys()) {
      if (!desired.has(paneId)) ops.push([paneId, null]);
    }
    if (ops.length === 0) return;
    const results = await Promise.allSettled(
      ops.map(([paneId, glyph]) => this.reportKeyToken(paneId, glyph)),
    );
    const next = new Map(this.tokenPanes);
    results.forEach((result, i) => {
      const [paneId, glyph] = ops[i]!;
      if (result.status === "fulfilled") {
        if (glyph) next.set(paneId, glyph);
        else next.delete(paneId);
      } else {
        log(
          `token update failed for ${paneId}: ${(result.reason as Error).message}`,
        );
      }
    });
    this.tokenPanes = next;
  }

  private async reportKeyToken(
    paneId: string,
    glyph: string | null,
  ): Promise<void> {
    try {
      await this.herdr.request("pane.report_metadata", {
        pane_id: paneId,
        source: PLUGIN_ID,
        tokens: { key: glyph },
      });
    } catch (error) {
      // Clearing a token on a pane Herdr has already forgotten has achieved
      // what it was for; treating it as a failure would retry and log it on
      // every refresh for the life of the daemon.
      if (
        glyph === null &&
        error instanceof HerdrError &&
        error.code === "pane_not_found"
      ) {
        return;
      }
      throw error;
    }
  }

  // Stateless: probe by closing; a popup_not_open error means open one.
  private async togglePopup(): Promise<void> {
    try {
      await this.herdr.request("popup.close", {});
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "popup_not_open") {
        log(`popup toggle failed: ${(error as Error).message}`);
        return;
      }
      try {
        await this.herdr.request("plugin.pane.open", {
          plugin_id: PLUGIN_ID,
          entrypoint: "keys",
          placement: "popup",
        });
      } catch (openError) {
        log(`popup open failed: ${(openError as Error).message}`);
      }
    }
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log("shutting down");
    this.subGeneration++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.subRetryTimer) clearTimeout(this.subRetryTimer);
    if (this.yieldTimer) clearInterval(this.yieldTimer);
    if (this.layerTimer) clearInterval(this.layerTimer);
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    if (this.configWatchRetryTimer) clearTimeout(this.configWatchRetryTimer);
    this.configWatcher?.close();
    this.closeSubscription?.();
    // Once here and once more when the handle drops, because there may be no
    // live handle to drop.
    this.controls.resetInputState();
    this.xpad.stop();
    await this.blankDevice();
    // Bounded: a wedged Herdr must not keep the device held hostage.
    await atMost(
      Promise.allSettled(
        [...this.tokenPanes.keys()].map((paneId) =>
          this.reportKeyToken(paneId, null).catch(() => {}),
        ),
      ),
      SHUTDOWN_CLEANUP_MS,
    );
    await this.device.stop();
    this.control.close();
    process.exit(0);
  }
}

new Daemon().start().catch((error: Error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
