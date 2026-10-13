import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InputBackend } from "../src/winput.js";

const { postKey, postScroll, postSystemScroll, raiseTerminal, useBackend, useBackendLoader } =
  await import("../src/tapkey.js");

function fake(overrides: Partial<InputBackend> = {}) {
  const events: string[] = [];
  const backend: InputBackend = {
    key: (vk, up) => void events.push(`${up ? "up" : "down"}:${vk.toString(16)}`),
    wheel: (delta) => void events.push(`wheel:${delta}`),
    setCursor: (x, y) => void events.push(`cursor:${x},${y}`),
    foreground: () => null,
    listWindows: () => [],
    raise: (hwnd) => void events.push(`raise:${String(hwnd)}`),
    ...overrides,
  };
  return { backend, events };
}

beforeEach(() => {
  useBackend(null);
  useBackendLoader(null);
});

describe("postKey", () => {
  it("taps cmd+shift+p: modifiers first, released last", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    postKey({ keyCode: 35, modifiers: 3 }, "tap", vi.fn());
    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events).toEqual(["down:5b", "down:10", "down:50", "up:50", "up:10", "up:5b"]);
  });

  it("mirrors a physical hold as separate down and up calls", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    postKey({ keyCode: 35, modifiers: 3 }, "down", vi.fn());
    postKey({ keyCode: 35, modifiers: 3 }, "up", vi.fn());
    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events).toEqual(["down:5b", "down:10", "down:50", "up:50", "up:10", "up:5b"]);
  });

  it("serializes overlapping taps so their events never interleave", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    postKey({ keyCode: 0, modifiers: 0 }, "tap", vi.fn()); // a
    postKey({ keyCode: 11, modifiers: 0 }, "tap", vi.fn()); // b
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual(["down:41", "up:41", "down:42", "up:42"]);
  });

  it("logs a keycode with no Windows equivalent", async () => {
    const { backend } = fake();
    useBackend(backend);
    const log = vi.fn();
    postKey({ keyCode: 9999, modifiers: 0 }, "tap", log);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith("key 9999 tap failed: no Windows virtual-key for keycode 9999");
  });

  it("degrades to a logged error when the input backend cannot load", async () => {
    useBackendLoader(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    postKey({ keyCode: 35, modifiers: 0 }, "tap", log);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith("key 35 tap failed: input helper unavailable: boom");
  });
});

describe("postSystemScroll", () => {
  it("sends one wheel notch per line, up for positive lines", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    await postSystemScroll(3, vi.fn()).done;
    expect(events).toEqual(["wheel:120", "wheel:120", "wheel:120"]);
  });

  it("scrolls down for negative lines and never moves the pointer", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    await postSystemScroll(-2, vi.fn()).done;
    expect(events).toEqual(["wheel:-120", "wheel:-120"]);
  });

  it("logs a wheel failure and still settles", async () => {
    const { backend } = fake({
      wheel: () => {
        throw new Error("blocked");
      },
    });
    useBackend(backend);
    const log = vi.fn();
    await postSystemScroll(3, log).done;
    expect(log).toHaveBeenCalledWith("scroll 3 failed: blocked");
  });

  it("logs and settles when the backend cannot load", async () => {
    useBackendLoader(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    await postSystemScroll(3, log).done;
    expect(log).toHaveBeenCalledWith("scroll 3 failed: input helper unavailable: boom");
  });

  it("cancel stops the remaining notches and suppresses logging", async () => {
    const { backend, events } = fake();
    useBackend(backend);
    const log = vi.fn();
    const operation = postSystemScroll(50, log);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    operation.cancel();
    await operation.done;
    expect(events.length).toBeLessThan(50);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("postScroll", () => {
  const terminal = {
    processName: "C:\\Program Files\\WindowsApps\\WT\\WindowsTerminal.exe",
    left: 100,
    top: 50,
    width: 200,
    height: 100,
  };

  it("moves to the focused pane first when the terminal is in front", async () => {
    const { backend, events } = fake({ foreground: () => terminal });
    useBackend(backend);
    await postScroll(2, 0.25, 0.5, "WindowsTerminal", vi.fn()).done;
    expect(events).toEqual(["cursor:150,100", "wheel:120", "wheel:120"]);
  });

  it("leaves the pointer alone when another app is in front", async () => {
    const { backend, events } = fake({
      foreground: () => ({ ...terminal, processName: "C:\\Windows\\notepad.exe" }),
    });
    useBackend(backend);
    await postScroll(2, 0.25, 0.5, "WindowsTerminal", vi.fn()).done;
    expect(events).toEqual(["wheel:120", "wheel:120"]);
  });
});

describe("postKey failure handling", () => {
  function failing(shouldFail: (vk: number, up: boolean) => boolean) {
    const events: string[] = [];
    const backend: InputBackend = {
      key: (vk, up) => {
        if (shouldFail(vk, up)) throw new Error("blocked");
        events.push(`${up ? "up" : "down"}:${vk.toString(16)}`);
      },
      wheel: () => {},
      setCursor: () => {},
      foreground: () => null,
      listWindows: () => [],
      raise: () => {},
    };
    return { backend, events };
  }

  it("releases the modifiers it already pressed when the key press itself fails", async () => {
    const { backend, events } = failing((vk, up) => vk === 0x50 && !up);
    useBackend(backend);
    const log = vi.fn();
    postKey({ keyCode: 35, modifiers: 3 }, "tap", log); // cmd+shift+p
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log).toHaveBeenCalledWith("key 35 tap failed: blocked");
    expect(events).toEqual(["down:5b", "down:10", "up:10", "up:5b"]);
  });

  it("still sends the remaining releases when the key-up of an 'up' call fails", async () => {
    const { backend, events } = failing((vk, up) => vk === 0x50 && up);
    useBackend(backend);
    const log = vi.fn();
    postKey({ keyCode: 35, modifiers: 3 }, "up", log);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(events).toEqual(["up:10", "up:5b"]);
  });
});

describe("raiseTerminal", () => {
  const wt = "C:\\WT\\WindowsTerminal.exe";
  const windows = [
    { hwnd: 11, processName: "C:\\Windows\\notepad.exe", title: "notes" },
    { hwnd: 12, processName: wt, title: "PowerShell" },
    { hwnd: 13, processName: wt, title: "AORUS: worklouder-micro" },
  ];

  it("raises the terminal window matching a title hint", async () => {
    const { backend, events } = fake({ listWindows: () => windows });
    useBackend(backend);
    const log = vi.fn();
    await raiseTerminal(["WindowsTerminal"], [": worklouder-micro"], log);
    expect(events).toEqual(["raise:13"]);
    expect(log).not.toHaveBeenCalled();
  });

  it("falls back to the topmost terminal window", async () => {
    const { backend, events } = fake({ listWindows: () => windows });
    useBackend(backend);
    await raiseTerminal(["WindowsTerminal"], [], vi.fn());
    expect(events).toEqual(["raise:12"]);
  });

  it("does nothing, quietly, when no terminal window exists", async () => {
    const { backend, events } = fake({ listWindows: () => [windows[0]!] });
    useBackend(backend);
    const log = vi.fn();
    await raiseTerminal(["WindowsTerminal"], [], log);
    expect(events).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a refused raise instead of throwing", async () => {
    const { backend } = fake({
      listWindows: () => windows,
      raise: () => {
        throw new Error("SetForegroundWindow was refused");
      },
    });
    useBackend(backend);
    const log = vi.fn();
    await raiseTerminal(["WindowsTerminal"], [], log);
    expect(log).toHaveBeenCalledWith("raise terminal failed: SetForegroundWindow was refused");
  });

  it("degrades to a logged error when the input backend cannot load", async () => {
    useBackendLoader(() => {
      throw new Error("boom");
    });
    const log = vi.fn();
    await raiseTerminal(["WindowsTerminal"], [], log);
    expect(log).toHaveBeenCalledWith("raise terminal failed: input helper unavailable: boom");
  });
});
