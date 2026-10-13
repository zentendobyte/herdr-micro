// Spike: enumerate top-level windows via koffi (intptr handles), then raise the first Windows Terminal window
// whose title contains the given hint (default: the first terminal window). Raising an already-front window is a no-op.
import koffi from "koffi";
const hint = (process.argv[2] ?? "").toLowerCase();
const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const dwm = koffi.load("dwmapi.dll");

const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(intptr hwnd, intptr lparam)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)");
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(intptr hwnd)");
const IsIconic = user32.func("bool __stdcall IsIconic(intptr hwnd)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(intptr hwnd, int cmd)");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(intptr hwnd)");
const GetForegroundWindow = user32.func("intptr __stdcall GetForegroundWindow()");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16_t *text, int max)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)");
const DwmGetWindowAttribute = dwm.func("int __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int *value, uint32 size)");
const OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *h)");
const QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");
const MOUSEINPUT = koffi.struct("MOUSEINPUT", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
const INPUT = koffi.struct("INPUT", { type: "uint32", u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }) });
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)");

function processName(pid) {
  const h = OpenProcess(0x1000, false, pid);
  if (!h) return "";
  try { const buf = Buffer.alloc(1040); const size = [520]; return QueryFullProcessImageNameW(h, 0, buf, size) ? buf.toString("utf16le", 0, size[0] * 2) : ""; }
  finally { CloseHandle(h); }
}
function titleOf(hwnd) { const t = Buffer.alloc(1024); const n = GetWindowTextW(hwnd, t, 512); return t.toString("utf16le", 0, n * 2); }

const wins = [];
const cb = koffi.register((hwnd) => {
  if (!IsWindowVisible(hwnd)) return true;
  const title = titleOf(hwnd);
  if (!title) return true;
  const cloaked = [0]; DwmGetWindowAttribute(hwnd, 14, cloaked, 4);
  if (cloaked[0] !== 0) return true;
  const pid = [0]; GetWindowThreadProcessId(hwnd, pid);
  wins.push({ hwnd, title, exe: processName(pid[0]).split("\\").pop() });
  return true;
}, koffi.pointer(EnumWindowsProc));
EnumWindows(cb, 0); koffi.unregister(cb);

const terminals = wins.filter((w) => /^(windowsterminal|wezterm-gui)\.exe$/i.test(w.exe));
console.log("terminal windows (z-order):", terminals.map((w) => JSON.stringify(w.title)).join(" | "));
const target = terminals.find((w) => !hint || w.title.toLowerCase().includes(hint));
if (!target) { console.log("no matching terminal window"); process.exit(0); }
console.log("target:", JSON.stringify(target.title), "| foreground before:", JSON.stringify(titleOf(GetForegroundWindow())));
if (IsIconic(target.hwnd)) ShowWindow(target.hwnd, 9);
// A tap of Alt gives this process the right to take the foreground.
for (const up of [false, true]) SendInput(1, [{ type: 1, u: { ki: { wVk: 0x12, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } }], koffi.sizeof(INPUT));
console.log("SetForegroundWindow ->", SetForegroundWindow(target.hwnd));
await new Promise((r) => setTimeout(r, 300));
console.log("foreground after:", JSON.stringify(titleOf(GetForegroundWindow())));
