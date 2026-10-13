import { describe, expect, it } from "vitest";
import { KEY_CODES } from "../src/keys.js";
import {
  VK_BY_NAME,
  keyFlags,
  keySequence,
  modifierVks,
  paneLocation,
  pickWindow,
  sameProcess,
  vkForKeyCode,
  wheelDeltas,
} from "../src/winput.js";

describe("vkForKeyCode", () => {
  it("translates macOS keycodes to Windows virtual keys", () => {
    expect(vkForKeyCode(35)).toBe(0x50); // p
    expect(vkForKeyCode(36)).toBe(0x0d); // return
    expect(vkForKeyCode(53)).toBe(0x1b); // escape
    expect(vkForKeyCode(122)).toBe(0x70); // f1
    expect(vkForKeyCode(105)).toBe(0x7c); // f13
    expect(vkForKeyCode(123)).toBe(0x25); // left arrow
    expect(vkForKeyCode(55)).toBe(0x5b); // lcmd = left Windows key
    expect(vkForKeyCode(54)).toBe(0x5c); // rcmd = right Windows key
    expect(vkForKeyCode(58)).toBe(0xa4); // lopt = left Alt
    expect(vkForKeyCode(62)).toBe(0xa3); // rctrl
    expect(vkForKeyCode(9999)).toBeNull();
  });

  it("covers every key name keys.ts can produce", () => {
    for (const name of Object.keys(KEY_CODES)) {
      expect(VK_BY_NAME[name], name).toBeDefined();
    }
  });
});

describe("modifierVks", () => {
  it("orders cmd(Win), shift, alt, ctrl", () => {
    expect(modifierVks(0)).toEqual([]);
    expect(modifierVks(3)).toEqual([0x5b, 0x10]);
    expect(modifierVks(15)).toEqual([0x5b, 0x10, 0x12, 0x11]);
  });
});

describe("keyFlags", () => {
  it("sets KEYUP for releases and EXTENDEDKEY for navigation and Windows keys", () => {
    expect(keyFlags(0x41, false)).toBe(0);
    expect(keyFlags(0x41, true)).toBe(2);
    expect(keyFlags(0x25, false)).toBe(1);
    expect(keyFlags(0x25, true)).toBe(3);
    expect(keyFlags(0x5b, false)).toBe(1);
  });
});

describe("keySequence", () => {
  const step = (vk: number, up: boolean, afterMs = 0) => ({ vk, up, afterMs });

  it("taps: modifiers down, key down (held 30 ms), key up, modifiers up in reverse", () => {
    expect(keySequence({ keyCode: 35, modifiers: 3 }, "tap")).toEqual([
      step(0x5b, false), step(0x10, false), step(0x50, false, 30),
      step(0x50, true), step(0x10, true), step(0x5b, true),
    ]);
  });

  it("down presses modifiers then the key; up releases the key then the modifiers", () => {
    expect(keySequence({ keyCode: 35, modifiers: 3 }, "down")).toEqual([
      step(0x5b, false), step(0x10, false), step(0x50, false),
    ]);
    expect(keySequence({ keyCode: 35, modifiers: 3 }, "up")).toEqual([
      step(0x50, true), step(0x10, true), step(0x5b, true),
    ]);
  });

  it("a bare modifier key is just that key", () => {
    expect(keySequence({ keyCode: 54, modifiers: 0 }, "down")).toEqual([step(0x5c, false)]);
    expect(keySequence({ keyCode: 54, modifiers: 0 }, "up")).toEqual([step(0x5c, true)]);
    expect(keySequence({ keyCode: 54, modifiers: 0 }, "tap")).toEqual([step(0x5c, false, 30), step(0x5c, true)]);
  });

  it("throws for a keycode with no Windows equivalent", () => {
    expect(() => keySequence({ keyCode: 9999, modifiers: 0 }, "tap")).toThrow(
      /no Windows virtual-key for keycode 9999/,
    );
  });
});

describe("wheelDeltas", () => {
  it("is +120 per line up and -120 per line down", () => {
    expect(wheelDeltas(3)).toEqual([120, 120, 120]);
    expect(wheelDeltas(-2)).toEqual([-120, -120]);
    expect(wheelDeltas(0)).toEqual([]);
  });
});

describe("paneLocation", () => {
  it("maps fractions of the client area to screen pixels", () => {
    expect(
      paneLocation({ processName: "x", left: 100, top: 50, width: 200, height: 100 }, 0.25, 0.5),
    ).toEqual({ x: 150, y: 100 });
  });
});

describe("sameProcess", () => {
  it("compares the image base name, case-insensitively, ignoring .exe", () => {
    const wt = "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1\\WindowsTerminal.exe";
    expect(sameProcess(wt, "WindowsTerminal")).toBe(true);
    expect(sameProcess(wt, "windowsterminal.EXE")).toBe(true);
    expect(sameProcess("C:/x/wezterm-gui.exe", "wezterm-gui")).toBe(true);
    expect(sameProcess("C:\\Windows\\notepad.exe", "WindowsTerminal")).toBe(false);
    expect(sameProcess("", "WindowsTerminal")).toBe(false);
  });
});

describe("pickWindow", () => {
  const wt = "C:\\Program Files\\WindowsApps\\WT\\WindowsTerminal.exe";
  const win = (hwnd: number, processName: string, title: string) => ({ hwnd, processName, title });
  const windows = [
    win(1, "C:\\Windows\\System32\\notepad.exe", "Untitled - Notepad"),
    win(2, wt, "PowerShell"),
    win(3, wt, "AORUS-X870E: worklouder-micro"),
    win(4, "C:\\x\\wezterm-gui.exe", "wezterm"),
  ];

  it("prefers the terminal window whose title matches a hint, wherever it is in z-order", () => {
    expect(pickWindow(windows, ["WindowsTerminal"], [": worklouder-micro"])?.hwnd).toBe(3);
  });

  it("matches hints case-insensitively", () => {
    expect(pickWindow(windows, ["WindowsTerminal"], [": WORKLOUDER-micro"])?.hwnd).toBe(3);
  });

  it("falls back to the topmost terminal window when no hint matches", () => {
    expect(pickWindow(windows, ["WindowsTerminal"], [": nothing-like-this"])?.hwnd).toBe(2);
    expect(pickWindow(windows, ["WindowsTerminal"], [])?.hwnd).toBe(2);
  });

  it("only considers windows of the configured terminal processes", () => {
    expect(pickWindow(windows, ["wezterm-gui"], [])?.hwnd).toBe(4);
    expect(pickWindow(windows, ["WindowsTerminal", "wezterm-gui"], ["wezterm"])?.hwnd).toBe(4);
  });

  it("is null when no terminal window exists", () => {
    expect(pickWindow(windows, ["alacritty"], [])).toBeNull();
    expect(pickWindow([], ["WindowsTerminal"], ["x"])).toBeNull();
  });
});
