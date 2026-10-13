import net from "node:net";
import { describe, expect, it, vi } from "vitest";

process.env.HERDR_PLUGIN_STATE_DIR = "C:\\wl-test\\state";
process.env.HERDR_PLUGIN_CONFIG_DIR = "C:\\wl-test\\config";

const { pipeName, connect, requestLine, readLines } = await import("../src/socket.js");
const { socketPath } = await import("../src/herdr.js");
const { CONTROL_SOCKET, STATE_DIR, PLUGIN_ID } = await import("../src/config.js");

describe("pipeName", () => {
  it("prefixes a plain path once", () => {
    expect(pipeName("C:\\a\\herdr.sock")).toBe("\\\\.\\pipe\\C:\\a\\herdr.sock");
    expect(pipeName("\\\\.\\pipe\\x")).toBe("\\\\.\\pipe\\x");
  });
});

describe("herdr socket path", () => {
  it("prefers HERDR_SOCKET_PATH", () => {
    process.env.HERDR_SOCKET_PATH = "C:\\h\\herdr.sock";
    expect(socketPath()).toBe("C:\\h\\herdr.sock");
    delete process.env.HERDR_SOCKET_PATH;
  });

  it("falls back to %APPDATA%\\herdr\\herdr.sock", () => {
    delete process.env.HERDR_SOCKET_PATH;
    const old = process.env.APPDATA;
    process.env.APPDATA = "C:\\Users\\M\\AppData\\Roaming";
    expect(socketPath()).toBe("C:\\Users\\M\\AppData\\Roaming\\herdr\\herdr.sock");
    process.env.APPDATA = old;
  });
});

describe("config paths", () => {
  it("uses the herdr.micro2 plugin id and a pipe for the control socket", () => {
    expect(PLUGIN_ID).toBe("herdr.micro2");
    expect(STATE_DIR).toBe("C:\\wl-test\\state");
    expect(CONTROL_SOCKET.startsWith("\\\\.\\pipe\\")).toBe(true);
  });
});

describe("state dir and control pipe resolution", () => {
  // Herdr launches the plugin with HERDR_PLUGIN_STATE_DIR set; a shell launch
  // does not. Both must still find the same daemon.
  it("the control pipe name does not depend on the state dir", async () => {
    const before = CONTROL_SOCKET;
    vi.resetModules();
    process.env.HERDR_PLUGIN_STATE_DIR = "C:\\somewhere\\else";
    const other = (await import("../src/config.js")).CONTROL_SOCKET;
    process.env.HERDR_PLUGIN_STATE_DIR = "C:\\wl-test\\state";
    expect(other).toBe(before);
  });

  it("falls back to the directory Herdr itself uses (LOCALAPPDATA)", async () => {
    vi.resetModules();
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    const old = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\M\\AppData\\Local";
    const state = (await import("../src/config.js")).STATE_DIR;
    process.env.LOCALAPPDATA = old;
    process.env.HERDR_PLUGIN_STATE_DIR = "C:\\wl-test\\state";
    expect(state).toBe("C:\\Users\\M\\AppData\\Local\\herdr\\plugins\\herdr.micro2");
  });
});

describe("named pipe round trip", () => {
  it("connect() + requestLine() talk to a pipe server by plain path", async () => {
    const plain = `C:\\wl-test\\echo-${process.pid}.sock`;
    const server = net.createServer((socket) => {
      readLines(socket, (line) => socket.write(line.toUpperCase() + "\n"));
    });
    await new Promise<void>((resolve) => server.listen(pipeName(plain), resolve));
    try {
      const reply = await requestLine(await connect(plain), "hello");
      expect(reply).toBe("HELLO");
    } finally {
      server.close();
    }
  });
});
