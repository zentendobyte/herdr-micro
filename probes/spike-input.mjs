import koffi from "koffi";
const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const MOUSEINPUT = koffi.struct("MOUSEINPUT", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
const INPUT = koffi.struct("INPUT", { type: "uint32", u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }) });
const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });

const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)");
const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ POINT *p)");
const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
const GetClientRect = user32.func("bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *r)");
const ClientToScreen = user32.func("bool __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *p)");
const OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *h)");
const QueryFullProcessImageNameW = kernel32.func("bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)");

console.log("sizeof(INPUT) =", koffi.sizeof(INPUT), "(expect 40 on x64)");
const key = (vk, up) => SendInput(1, [{ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } }], koffi.sizeof(INPUT));
const wheel = (delta) => SendInput(1, [{ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: delta >>> 0, dwFlags: 0x0800, time: 0, dwExtraInfo: 0 } } }], koffi.sizeof(INPUT));

console.log("F24 down/up sent:", key(0x87, false), key(0x87, true), "(1 each = ok)");
console.log("wheel +120/-120 sent:", wheel(120), wheel(-120));
const p = {}; console.log("GetCursorPos:", GetCursorPos(p), p);
console.log("SetCursorPos(same):", SetCursorPos(p.x, p.y));
const hwnd = GetForegroundWindow();
const pid = [0]; GetWindowThreadProcessId(hwnd, pid);
const h = OpenProcess(0x1000, false, pid[0]);
const buf = Buffer.alloc(1040); const size = [520];
console.log("QueryFullProcessImageNameW:", QueryFullProcessImageNameW(h, 0, buf, size), "->", buf.toString("utf16le", 0, size[0] * 2));
CloseHandle(h);
const r = {}; GetClientRect(hwnd, r); const o = { x: 0, y: 0 }; ClientToScreen(hwnd, o);
console.log("client rect:", r, "origin on screen:", o);
