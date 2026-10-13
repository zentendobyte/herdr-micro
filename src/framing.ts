// Creator Micro 2 vendor HID framing: 64-byte reports carrying JSON-RPC on a
// channel byte. Report layout: [report id 6][channel][length][payload...61].
// Device-to-host JSON objects have NO terminator (firmware 0.6.3) and may span
// reports, so objects are cut out by balancing braces.
export const REPORT_ID = 6;
export const CHANNEL_DEBUG = 1;
export const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_PAYLOAD = 61;
const HEADER_SIZE = 3;
// A message that never terminates must not grow the buffer without bound.
const MAX_BUFFERED = 256 * 1024;
// The reports of one message arrive back to back. An object still open this
// long after it began lost a report (there is no end marker to resync on), so
// it is dropped rather than swallowing every later message.
const STALE_FRAME_MS = 250;

export function encodeMessage(message: string): Buffer[] {
  const bytes = Buffer.from(message, "utf8");
  const reports: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += MAX_PAYLOAD) {
    const chunk = bytes.subarray(off, off + MAX_PAYLOAD);
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = CHANNEL_RPC;
    report[2] = chunk.length;
    chunk.copy(report, HEADER_SIZE);
    reports.push(report);
  }
  return reports;
}

export interface FrameMessage {
  channel: number;
  message: string;
}

// Bytes are accumulated and decoded only once a whole object is present, so a
// multibyte UTF-8 character crossing a report boundary decodes correctly.
// Braces and quotes are ASCII, so scanning raw bytes is safe.
export class Reassembler {
  private buffer: Buffer = Buffer.alloc(0);
  private openSince: number | null = null;

  constructor(private now: () => number = Date.now) {}

  push(data: Buffer): FrameMessage[] {
    // node-hid may or may not include the report id as byte 0; a real report
    // id is 6, while without one byte 0 is the channel (1 or 2).
    const off = data[0] === REPORT_ID ? 1 : 0;
    const channel = data[off];
    const length = data[off + 1];
    if (channel !== CHANNEL_RPC) return [];
    if (length === undefined || length > MAX_PAYLOAD) return [];
    if (off + 2 + length > data.length) return [];
    const t = this.now();
    if (
      this.buffer.length > 0 &&
      this.openSince !== null &&
      t - this.openSince > STALE_FRAME_MS
    ) {
      this.buffer = Buffer.alloc(0);
    }
    this.buffer = Buffer.concat([this.buffer, data.subarray(off + 2, off + 2 + length)]);

    const messages: FrameMessage[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i]!;
      if (depth === 0 && c !== 0x7b) continue; // garbage before an object
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true;
        else if (c === 0x22) inString = false;
        continue;
      }
      if (c === 0x22) inString = true;
      else if (c === 0x7b) {
        if (depth++ === 0) start = i;
      } else if (c === 0x7d && --depth === 0) {
        messages.push({
          channel: CHANNEL_RPC,
          message: this.buffer.subarray(start, i + 1).toString("utf8"),
        });
        this.buffer = this.buffer.subarray(i + 1);
        i = -1;
        start = -1;
        inString = false;
        escaped = false;
      }
    }
    // Nothing open: drop leftover garbage. Something open: keep it for the next
    // report, up to a ceiling.
    if (depth === 0 || this.buffer.length > MAX_BUFFERED) {
      this.buffer = Buffer.alloc(0);
    }
    if (this.buffer.length === 0) this.openSince = null;
    else if (messages.length > 0 || this.openSince === null) this.openSince = t;
    return messages;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.openSince = null;
  }
}
