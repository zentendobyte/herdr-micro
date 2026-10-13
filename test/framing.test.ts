import { describe, expect, it } from "vitest";
import {
  CHANNEL_DEBUG,
  CHANNEL_RPC,
  REPORT_ID,
  Reassembler,
  encodeMessage,
} from "../src/framing.js";

function report(channel: number, text: string | Buffer, withId = true): Buffer {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  const body = Buffer.alloc(64);
  let off = 0;
  if (withId) body[off++] = REPORT_ID;
  body[off++] = channel;
  body[off++] = bytes.length;
  bytes.copy(body, off);
  return body;
}

describe("encodeMessage", () => {
  it("makes one 64-byte report for a short message", () => {
    const [only, ...rest] = encodeMessage('{"method":"sys.version","id":1}');
    expect(rest).toHaveLength(0);
    expect(only!.length).toBe(64);
    expect(only![0]).toBe(REPORT_ID);
    expect(only![1]).toBe(CHANNEL_RPC);
    expect(only!.subarray(3, 3 + only![2]!).toString()).toBe('{"method":"sys.version","id":1}');
  });

  it("splits long messages into reports of at most 61 payload bytes that rejoin", () => {
    const message = JSON.stringify({ method: "fs.write", params: { data: "x".repeat(200) }, id: 2 });
    const reports = encodeMessage(message);
    expect(reports.length).toBeGreaterThan(1);
    expect(reports.every((r) => r[2]! <= 61)).toBe(true);
    const joined = reports.map((r) => r.subarray(3, 3 + r[2]!).toString("utf8")).join("");
    expect(joined).toBe(message);
  });
});

describe("Reassembler", () => {
  it("reassembles an object spanning reports, with no newline terminator", () => {
    const r = new Reassembler();
    const message = JSON.stringify({ id: 1, result: { version: "0.6.3", battery: 100 } });
    const out = encodeMessage(message).flatMap((rep) => r.push(rep));
    expect(out).toEqual([{ channel: CHANNEL_RPC, message }]);
  });

  it("accepts reports without a leading report id", () => {
    const r = new Reassembler();
    expect(r.push(report(CHANNEL_RPC, '{"id":2}', false))).toEqual([{ channel: CHANNEL_RPC, message: '{"id":2}' }]);
  });

  it("ignores braces inside strings and splits two objects in one report", () => {
    const r = new Reassembler();
    const text = '{"data":"{\\"a\\":\\"}\\"}"}{"id":2}';
    expect(r.push(report(CHANNEL_RPC, text)).map((m) => m.message)).toEqual(['{"data":"{\\"a\\":\\"}\\"}"}', '{"id":2}']);
  });

  it("survives a multi-byte character split across two reports", () => {
    const r = new Reassembler();
    const whole = Buffer.from(JSON.stringify({ label: "café ☕" }), "utf8");
    const cut = whole.indexOf(0xc3) + 1; // between the two bytes of "é"
    expect(r.push(report(CHANNEL_RPC, whole.subarray(0, cut)))).toEqual([]);
    const out = r.push(report(CHANNEL_RPC, whole.subarray(cut)));
    expect(JSON.parse(out[0]!.message)).toEqual({ label: "café ☕" });
  });

  it("skips garbage before an object and ignores non-RPC channels and bad lengths", () => {
    const r = new Reassembler();
    expect(r.push(report(CHANNEL_RPC, 'xx{"id":1}')).map((m) => m.message)).toEqual(['{"id":1}']);
    expect(r.push(report(CHANNEL_DEBUG, '{"id":9}'))).toEqual([]);
    const bad = report(CHANNEL_RPC, "{}");
    bad[2] = 200;
    expect(r.push(bad)).toEqual([]);
    expect(r.push(Buffer.from([1, 2]))).toEqual([]);
  });

  it("reset() drops a half-received message", () => {
    const r = new Reassembler();
    r.push(report(CHANNEL_RPC, '{"id":1,"res'));
    r.reset();
    expect(r.push(report(CHANNEL_RPC, '{"id":2}')).map((m) => m.message)).toEqual(['{"id":2}']);
  });
});

describe("Reassembler recovery", () => {
  function raw(text: string): Buffer {
    const bytes = Buffer.from(text, "utf8");
    const r = Buffer.alloc(64);
    r[0] = REPORT_ID; r[1] = CHANNEL_RPC; r[2] = bytes.length;
    bytes.copy(r, 3);
    return r;
  }

  it("drops a half-received frame that never completes, so the next message still arrives", () => {
    let clock = 0;
    const r = new Reassembler(() => clock);
    expect(r.push(raw('{"id":1,"result":{"x":"'))).toEqual([]); // the closing bytes are lost
    clock = 1000;
    expect(r.push(raw('{"id":2}')).map((m) => m.message)).toEqual(['{"id":2}']);
  });

  it("still joins a frame whose reports arrive back to back", () => {
    let clock = 0;
    const r = new Reassembler(() => clock);
    expect(r.push(raw('{"id":1,"res'))).toEqual([]);
    clock = 100;
    expect(r.push(raw('ult":{}}')).map((m) => m.message)).toEqual(['{"id":1,"result":{}}']);
  });
});
