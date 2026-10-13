// Standalone setup diagnostics. Deliberately not routed through the daemon:
// the moment you need a doctor is when the daemon may be dead or blocked.
// Prints one line per check plus guidance for anything failing.
import net from "node:net";
import { CONTROL_SOCKET, STATE_DIR, loadConfig } from "./config.js";
import { processRunning } from "./contention.js";
import { daemonAlive, sendCommand } from "./control.js";
import { MicroDevice } from "./device.js";
import { socketPath } from "./herdr.js";
import * as keymap from "./keymap.js";
import { isOwnedLayer } from "./layer.js";
import { pipeName } from "./socket.js";
import { loadInputBackend } from "./winput.js";

const check = (name: string, ok: boolean, detail: string) =>
  console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Herdr server reachable?
const herdrUp = await new Promise<boolean>((resolve) => {
  const socket = net.createConnection(pipeName(socketPath()));
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
});
check(
  "herdr server",
  herdrUp,
  herdrUp ? socketPath() : `no pipe for ${socketPath()}; is Herdr running?`,
);

// Config valid, and which apps should the daemon yield to?
let yieldTo: string[] = [];
try {
  yieldTo = loadConfig().yieldTo;
  check("config", true, "valid");
} catch (error) {
  check("config", false, (error as Error).message);
}
console.log(`  state dir: ${STATE_DIR}
  control pipe: ${CONTROL_SOCKET}`);
const daemonUp = await daemonAlive();
if (daemonUp) {
  const status = await sendCommand("status");
  check(
    "daemon",
    true,
    `running (state: ${String(status.state)}, policy: ${String(status.policy)})`,
  );
  if (status.configError) check("daemon config", false, String(status.configError));
} else {
  check("daemon", false, "not running; start with: node dist/start.js");
}

if (yieldTo.length > 0) {
  const running = await processRunning(yieldTo);
  check(
    "yield_to apps",
    !running,
    running
      ? `one of ${yieldTo.join(", ")} is running; the daemon yields the pad while it is`
      : `none of ${yieldTo.join(", ")} running`,
  );
}

// Synthetic input (global key bindings and dial scroll mode).
try {
  const front = loadInputBackend().foreground();
  check("input helper", true, `koffi/user32 ready (foreground: ${front?.processName ?? "unknown"})`);
} catch (error) {
  check(
    "input helper",
    false,
    `${(error as Error).message}; global key bindings and scroll mode are unavailable`,
  );
}

// Device: present, answers, and bound. Uses the daemon's own device module so
// a diagnosis here can never drift from what the daemon actually does.
const device = new MicroDevice(
  {
    onConnect() {},
    onDisconnect() {},
    onStateChange() {},
    onHid() {},
    onJoystick() {},
  },
  () => {},
);
device.start();
const deadline = Date.now() + 8000;
while (!device.connected && Date.now() < deadline) await sleep(150);
if (!device.connected) {
  const hints: Record<string, string> = {
    device_absent: "Creator Micro 2 not found; check the cable and that it is on USB",
    device_busy: "another app holds the pad (Work Louder Input? Codex?)",
  };
  check("device", false, hints[device.state] ?? `could not open it (state: ${device.state})`);
} else {
  try {
    const version = (await device.call("sys.version")) as { version?: string };
    const status = (await device.call("device.status")) as {
      profile_index?: unknown;
      layer_index?: unknown;
      battery?: unknown;
    };
    check(
      "device",
      true,
      `answers (firmware ${version?.version ?? "?"}, battery ${String(status?.battery ?? "?")}%)`,
    );
    const owned = isOwnedLayer(status ?? {});
    check(
      "layer",
      owned,
      owned
        ? "layer 1 (the layer this plugin owns)"
        : `pad is on layer ${String(status?.layer_index)}; the plugin pauses off layer 1`,
    );
    const applied = keymap.isApplied(await keymap.read((m, p) => device.call(m, p)));
    check(
      "keymap",
      applied,
      applied
        ? "keys, dial and joystick are bound for Herdr"
        : "not bound yet; the daemon binds them when it connects (original is saved first)",
    );
  } catch (error) {
    check("device", false, `opened but did not answer: ${(error as Error).message}`);
  }
}
await device.stop();
process.exit(0);
