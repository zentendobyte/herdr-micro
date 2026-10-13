// Windows input backend: synthetic keys and mouse-wheel events through
// user32.SendInput, called in-process via koffi (prebuilt FFI, no compiler,
// no helper binary). Replaces upstream's macOS-only `tapkey` helper.
//
// Everything that is pure (key translation, event ordering, geometry) is
// exported and unit-tested; only loadInputBackend touches the OS. koffi is
// loaded lazily so a machine where it fails costs one logged error, not the
// daemon.
import { createRequire } from "node:module";
import { KEY_CODES, isModifierKey, type KeyCombo } from "./keys.js";

export type KeyMode = "tap" | "down" | "up";

export interface WindowInfo {
  processName: string;
  /** Client area in screen coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A visible, titled, uncloaked top-level window. `hwnd` is the native handle. */
export interface WindowCandidate {
  hwnd: number;
  processName: string;
  title: string;
}

export interface InputBackend {
  key(vk: number, up: boolean): void;
  wheel(delta: number): void;
  setCursor(x: number, y: number): void;
  foreground(): WindowInfo | null;
  /** Top-level windows in z-order, topmost (most recently used) first. */
  listWindows(): WindowCandidate[];
  /** Restores if minimized and brings the window to the foreground; throws if Windows refuses. */
  raise(hwnd: number): void;
}

const TAP_HOLD_MS = 30;
const WHEEL_NOTCH = 120;

// Windows virtual-key codes by the same names keys.ts uses.
function buildVkTable(): Record<string, number> {
  const vk: Record<string, number> = {};
  for (let c = 0x41; c <= 0x5a; c++) vk[String.fromCharCode(c).toLowerCase()] = c;
  for (let d = 0; d <= 9; d++) vk[String(d)] = 0x30 + d;
  for (let f = 1; f <= 20; f++) vk[`f${f}`] = 0x70 + (f - 1);
  Object.assign(vk, {
    return: 0x0d, enter: 0x0d, escape: 0x1b, esc: 0x1b, tab: 0x09, space: 0x20,
    delete: 0x08, backspace: 0x08, forwarddelete: 0x2e,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
    minus: 0xbd, equal: 0xbb, leftbracket: 0xdb, rightbracket: 0xdd,
    backslash: 0xdc, semicolon: 0xba, quote: 0xde, comma: 0xbc,
    period: 0xbe, slash: 0xbf, grave: 0xc0, backtick: 0xc0,
    // Bare modifiers. "cmd" is the Windows key on this platform.
    lcmd: 0x5b, rcmd: 0x5c, lshift: 0xa0, rshift: 0xa1,
    lctrl: 0xa2, rctrl: 0xa3, lopt: 0xa4, lalt: 0xa4, ropt: 0xa5, ralt: 0xa5,
  });
  return vk;
}
export const VK_BY_NAME: Record<string, number> = buildVkTable();

// keys.ts numbers keys with macOS keycodes (so its tests and the config
// grammar stay shared); translate keycode -> name -> Windows VK.
const NAME_BY_MAC_CODE = new Map<number, string>(
  Object.entries(KEY_CODES).map(([name, code]) => [code, name]),
);

export function vkForKeyCode(macKeyCode: number): number | null {
  const name = NAME_BY_MAC_CODE.get(macKeyCode);
  return name === undefined ? null : (VK_BY_NAME[name] ?? null);
}

// Modifier mask bits shared with keys.ts: 1=cmd 2=shift 4=alt 8=ctrl.
export function modifierVks(mask: number): number[] {
  const out: number[] = [];
  if (mask & 1) out.push(0x5b); // cmd -> left Windows key
  if (mask & 2) out.push(0x10);
  if (mask & 4) out.push(0x12);
  if (mask & 8) out.push(0x11);
  return out;
}

// Navigation keys, the Windows keys and right Ctrl/Alt are "extended" keys.
const EXTENDED = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c, 0xa3, 0xa5,
]);

export function keyFlags(vk: number, up: boolean): number {
  return (up ? 0x0002 : 0) | (EXTENDED.has(vk) ? 0x0001 : 0);
}

export interface KeyStep {
  vk: number;
  up: boolean;
  /** Pause after this event, in ms. */
  afterMs: number;
}

// Both edges carry the combo's modifiers: they go down before the key and up
// after it, so a held combo ends with the same state it started from.
export function keySequence(combo: KeyCombo, mode: KeyMode): KeyStep[] {
  const vk = vkForKeyCode(combo.keyCode);
  if (vk === null) {
    throw new Error(`no Windows virtual-key for keycode ${combo.keyCode}`);
  }
  // A bare modifier key carries no combo modifiers and mirrors the hold itself.
  const mods = isModifierKey(combo.keyCode) ? [] : modifierVks(combo.modifiers);
  const press = (v: number, afterMs = 0): KeyStep => ({ vk: v, up: false, afterMs });
  const release = (v: number): KeyStep => ({ vk: v, up: true, afterMs: 0 });
  const pressMods = mods.map((v) => press(v));
  const releaseMods = [...mods].reverse().map(release);
  if (mode === "down") return [...pressMods, press(vk)];
  if (mode === "up") return [release(vk), ...releaseMods];
  return [...pressMods, press(vk, TAP_HOLD_MS), release(vk), ...releaseMods];
}

// Positive lines scroll up (+120 per line), negative down: the convention the
// upstream scroller was written against.
export function wheelDeltas(lines: number): number[] {
  const count = Math.abs(Math.trunc(lines));
  return Array.from({ length: count }, () => (lines > 0 ? WHEEL_NOTCH : -WHEEL_NOTCH));
}

export function paneLocation(
  window: WindowInfo,
  xFraction: number,
  yFraction: number,
): { x: number; y: number } {
  return {
    x: Math.round(window.left + window.width * xFraction),
    y: Math.round(window.top + window.height * yFraction),
  };
}

const baseName = (p: string): string =>
  (p.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

export function sameProcess(imagePath: string, owner: string): boolean {
  const name = baseName(imagePath);
  return name !== "" && name === baseName(owner);
}

// Which window to raise. Several terminal windows can belong to ONE process
// (every Windows Terminal window does), so a title hint picks Herdr's window;
// without a match the topmost (most recently used) terminal window wins.
export function pickWindow(
  windows: readonly WindowCandidate[],
  processNames: readonly string[],
  titleHints: readonly string[],
): WindowCandidate | null {
  const terminals = windows.filter((w) =>
    processNames.some((name) => sameProcess(w.processName, name)),
  );
  const hints = titleHints.map((h) => h.toLowerCase()).filter((h) => h !== "");
  const hinted = terminals.find((w) => {
    const title = w.title.toLowerCase();
    return hints.some((h) => title.includes(h));
  });
  return hinted ?? terminals[0] ?? null;
}

// The only function that touches the OS. Verified by probes/spike-input.mjs
// and probes/spike-raise.mjs.
export function loadInputBackend(): InputBackend {
  let koffi: typeof import("koffi");
  try {
    koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  } catch (error) {
    throw new Error(`could not load koffi: ${(error as Error).message}`);
  }
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
    dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
  });
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
    wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr",
  });
  const INPUT = koffi.struct("INPUT", {
    type: "uint32",
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }),
  });
  koffi.struct("POINT", { x: "int32", y: "int32" });
  koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });

  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)");
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
  // Window handles are passed as intptr so they can be kept and handed back
  // after an EnumWindows callback has returned.
  const GetForegroundWindow = user32.func("intptr __stdcall GetForegroundWindow()");
  const GetWindowThreadProcessId = user32.func(
    "uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)",
  );
  const GetClientRect = user32.func("bool __stdcall GetClientRect(intptr hwnd, _Out_ RECT *r)");
  const ClientToScreen = user32.func("bool __stdcall ClientToScreen(intptr hwnd, _Inout_ POINT *p)");
  const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(intptr hwnd, intptr lparam)");
  const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)");
  const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(intptr hwnd)");
  const IsIconic = user32.func("bool __stdcall IsIconic(intptr hwnd)");
  const ShowWindow = user32.func("bool __stdcall ShowWindow(intptr hwnd, int cmd)");
  const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(intptr hwnd)");
  const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *text, int max)");
  // DWM "cloaked" windows (suspended or hidden UWP windows) are visible to
  // EnumWindows but not to the user; skip them if dwmapi is available.
  let DwmGetWindowAttribute: ((hwnd: number, attr: number, value: number[], size: number) => number) | null = null;
  try {
    DwmGetWindowAttribute = koffi
      .load("dwmapi.dll")
      .func("int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int *value, uint32 size)");
  } catch {
    DwmGetWindowAttribute = null;
  }
  const OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
  const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *h)");
  const QueryFullProcessImageNameW = kernel32.func(
    "bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)",
  );

  const size = koffi.sizeof(INPUT);
  const send = (input: unknown): void => {
    if (SendInput(1, [input], size) !== 1) {
      // SendInput cannot target elevated windows (UIPI) and fails when blocked.
      throw new Error("SendInput was blocked (is the target window running as administrator?)");
    }
  };
  const sendKey = (vk: number, up: boolean): void =>
    send({ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: keyFlags(vk, up), time: 0, dwExtraInfo: 0 } } });

  const imageNameOf = (pid: number): string => {
    const handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (!handle) return "";
    try {
      const name = Buffer.alloc(1040);
      const length = [520];
      return QueryFullProcessImageNameW(handle, 0, name, length)
        ? name.toString("utf16le", 0, length[0]! * 2)
        : "";
    } finally {
      CloseHandle(handle);
    }
  };

  return {
    key(vk, up) {
      sendKey(vk, up);
    },
    wheel(delta) {
      // MOUSEEVENTF_WHEEL; mouseData is a DWORD, so negatives wrap.
      send({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: delta >>> 0, dwFlags: 0x0800, time: 0, dwExtraInfo: 0 } } });
    },
    setCursor(x, y) {
      if (!SetCursorPos(x, y)) throw new Error("SetCursorPos failed");
    },
    foreground() {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      const processName = imageNameOf(pid[0]!);
      if (processName === "") return null;
      const rect = { left: 0, top: 0, right: 0, bottom: 0 };
      GetClientRect(hwnd, rect);
      const origin = { x: 0, y: 0 };
      ClientToScreen(hwnd, origin);
      return {
        processName,
        left: origin.x,
        top: origin.y,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      };
    },
    listWindows() {
      const found: WindowCandidate[] = [];
      const names = new Map<number, string>();
      const callback = koffi.register((hwnd: number) => {
        if (!IsWindowVisible(hwnd)) return true;
        const text = Buffer.alloc(1024);
        const length = GetWindowTextW(hwnd, text, 512);
        if (length <= 0) return true;
        if (DwmGetWindowAttribute) {
          const cloaked = [0];
          DwmGetWindowAttribute(hwnd, 14, cloaked, 4); // DWMWA_CLOAKED
          if (cloaked[0] !== 0) return true;
        }
        const pid = [0];
        GetWindowThreadProcessId(hwnd, pid);
        let processName = names.get(pid[0]!);
        if (processName === undefined) {
          processName = imageNameOf(pid[0]!);
          names.set(pid[0]!, processName);
        }
        found.push({ hwnd, processName, title: text.toString("utf16le", 0, length * 2) });
        return true;
      }, koffi.pointer(EnumWindowsProc));
      try {
        EnumWindows(callback, 0);
      } finally {
        koffi.unregister(callback);
      }
      return found;
    },
    raise(hwnd) {
      if (GetForegroundWindow() === hwnd) return;
      if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
      // A tap of Alt gives this background process the right to take the foreground.
      sendKey(0x12, false);
      sendKey(0x12, true);
      if (!SetForegroundWindow(hwnd)) throw new Error("SetForegroundWindow was refused");
    },
  };
}
