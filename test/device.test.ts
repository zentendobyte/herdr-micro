import { describe, expect, it, vi } from "vitest";

vi.mock("node-hid", async () => {
  const { EventEmitter } = await import("node:events");
  const handle: any = new EventEmitter();
  handle.written = [] as Buffer[];
  handle.write = async (buf: Buffer) => { handle.written.push(Buffer.from(buf)); return buf.length; };
  handle.close = async () => {};
  return {
    __handle: handle,
    devicesAsync: async () => [
      { vendorId: 0x303a, productId: 0x8298, usagePage: 1, usage: 6, path: "kbd" },
      { vendorId: 0x303a, productId: 0x8298, usagePage: 0xff00, usage: 1, path: "vendor" },
    ],
    HIDAsync: { open: async () => handle },
  };
});

const hid: any = await import("node-hid");
const handle = hid.__handle;
const { MicroDevice, classifyOpenError, PRODUCT_ID } = await import("../src/device.js");
const { encodeMessage } = await import("../src/framing.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function feed(obj: unknown): void {
  for (const r of encodeMessage(JSON.stringify(obj))) handle.emit("data", r);
}
function lastRequest(): any {
  const bytes = Buffer.concat(handle.written.map((w: Buffer) => w.subarray(3, 3 + w[2]!)));
  return JSON.parse(bytes.toString("utf8"));
}
async function connected(handlers: Record<string, unknown> = {}) {
  const device = new MicroDevice(
    { onConnect() {}, onDisconnect() {}, onStateChange() {}, onHid() {}, onJoystick() {}, ...handlers } as any,
    () => {},
  );
  device.start();
  for (let i = 0; i < 50 && !device.connected; i++) await sleep(10);
  expect(device.connected).toBe(true);
  handle.written.length = 0;
  return device;
}

describe("MicroDevice", () => {
  it("targets the Micro 2 vendor interface", () => {
    expect(PRODUCT_ID).toBe(0x8298);
  });

  it("call() sends an id < 1000 and resolves with the matching result", async () => {
    const device = await connected();
    const p = device.call("sys.version");
    await sleep(5);
    const req = lastRequest();
    expect(req.method).toBe("sys.version");
    expect(req.id).toBeGreaterThan(0);
    expect(req.id).toBeLessThan(1000);
    feed({ id: req.id, result: { version: "0.6.3" }, method: "sys.version" });
    await expect(p).resolves.toEqual({ version: "0.6.3" });
    await device.stop();
  });

  it("rejects on an error response and on timeout", async () => {
    const device = await connected();
    const p = device.call("nope");
    await sleep(5);
    feed({ id: lastRequest().id, error: { message: "Method not found" } });
    await expect(p).rejects.toThrow("Method not found");
    await expect(device.call("slow", null, 20)).rejects.toThrow("timeout waiting for slow");
    await device.stop();
  });

  it("dispatches key and joystick notifications (both envelope forms)", async () => {
    const hidEvents: unknown[] = [];
    const sticks: unknown[] = [];
    const device = await connected({
      onHid: (k: string, act: number) => hidEvents.push([k, act]),
      onJoystick: (a: number, d: number) => sticks.push([a, d]),
    });
    feed({ m: "v.oai.hid", p: { k: "AG03", act: 1 } });
    feed({ m: "kb.radial", p: { a: 0.76, d: 1, s: 4, l: 0, p: 0, o: 2 } });
    feed({ m: "v.oai.rad", p: { a: 0.25, d: 0.5 } });
    expect(hidEvents).toEqual([["AG03", 1]]);
    expect(sticks).toEqual([[0.76, 1], [0.25, 0.5]]);
    await device.stop();
  });

  it("reports replies to ids it never issued as foreign", async () => {
    const foreign: number[] = [];
    const device = await connected({ onForeign: (id: number) => foreign.push(id) });
    feed({ id: 555, result: { ok: 1 } });
    expect(foreign).toEqual([555]);
    await device.stop();
  });

  it("stop() rejects calls still in flight", async () => {
    const device = await connected();
    const p = device.call("sys.version", null, 5000);
    await device.stop();
    await expect(p).rejects.toThrow(/disconnected|not connected/);
  });

  it("classifies open errors", () => {
    expect(classifyOpenError("device not found")).toBe("device_absent");
    expect(classifyOpenError("something odd")).toBe("connecting");
  });
});

describe("MicroDevice reply matching and recovery", () => {
  it("does not accept another host's reply that happens to share our id", async () => {
    const foreign: number[] = [];
    const device = await connected({ onForeign: (id: number) => foreign.push(id) });
    const p = device.call("fs.read", { file: "keymap.json" });
    await sleep(5);
    const req = lastRequest();
    feed({ id: req.id, result: { battery: 1 }, method: "device.status" });
    expect(foreign).toEqual([req.id]);
    feed({ id: req.id, result: { data: "{}" }, method: "fs.read" });
    await expect(p).resolves.toEqual({ data: "{}" });
    await device.stop();
  });

  it("a timed-out call drops a half-received frame so later replies still arrive", async () => {
    const device = await connected();
    for (const report of encodeMessage('{"id":99,"junk":"')) handle.emit("data", report);
    await expect(device.call("slow", null, 20)).rejects.toThrow("timeout waiting for slow");
    handle.written.length = 0;
    const p = device.call("sys.version");
    await sleep(5);
    feed({ id: lastRequest().id, result: { version: "0.6.3" }, method: "sys.version" });
    await expect(p).resolves.toEqual({ version: "0.6.3" });
    await device.stop();
  });
});
