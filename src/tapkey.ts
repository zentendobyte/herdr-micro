// Posts synthetic keystrokes and wheel events on Windows. Same exported API as
// upstream's tapkey.ts (which spawned a macOS helper); here the work happens
// in-process through the input backend in winput.ts.
import type { KeyCombo } from "./keys.js";
import {
  type KeyStep,
  keySequence,
  loadInputBackend,
  paneLocation,
  pickWindow,
  sameProcess,
  wheelDeltas,
  type InputBackend,
} from "./winput.js";

export type { KeyMode } from "./winput.js";
import type { KeyMode } from "./winput.js";

export interface ScrollOperation {
  cancel(): void;
  done: Promise<void>;
}

const SCROLL_EVENT_GAP_MS = 20;
const POINTER_SETTLE_MS = 30;

let loader: () => InputBackend = loadInputBackend;
let backend: InputBackend | null = null;
let backendError: Error | null = null;

// Test hooks: inject a fake backend, or a loader that fails. null restores the
// real, lazily loaded backend.
export function useBackend(next: InputBackend | null): void {
  backend = next;
  backendError = null;
}
export function useBackendLoader(next: (() => InputBackend) | null): void {
  loader = next ?? loadInputBackend;
  backend = null;
  backendError = null;
}

function getBackend(): InputBackend {
  if (backend) return backend;
  if (backendError) throw backendError;
  try {
    backend = loader();
    return backend;
  } catch (error) {
    backendError = new Error(`input helper unavailable: ${(error as Error).message}`);
    throw backendError;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Taps and hold edges queue behind each other so their events never interleave.
let keyChain: Promise<void> = Promise.resolve();

export function postKey(
  combo: KeyCombo,
  mode: KeyMode,
  log: (message: string) => void,
): void {
  keyChain = keyChain.then(async () => {
    const pressed: number[] = [];
    let steps: KeyStep[] = [];
    let at = 0;
    let input: InputBackend | null = null;
    try {
      input = getBackend();
      steps = keySequence(combo, mode);
      for (; at < steps.length; at++) {
        const step = steps[at]!;
        input.key(step.vk, step.up);
        if (step.up) {
          const held = pressed.lastIndexOf(step.vk);
          if (held >= 0) pressed.splice(held, 1);
        } else {
          pressed.push(step.vk);
        }
        if (step.afterMs > 0) await sleep(step.afterMs);
      }
    } catch (error) {
      log(`key ${combo.keyCode} ${mode} failed: ${(error as Error).message}`);
      if (!input) return;
      // A modifier left down system-wide is far worse than a dropped key:
      // release what this call pressed, then finish the releases still queued
      // (best effort; the failing key itself is not retried).
      const failing = steps[at]?.vk;
      const releases = new Set<number>([...pressed].reverse());
      for (const step of steps.slice(at + 1)) {
        if (step.up && step.vk !== failing) releases.add(step.vk);
      }
      for (const vk of releases) {
        try {
          input.key(vk, true);
        } catch {
          // keep releasing the rest
        }
      }
    }
  });
}

function runScroll(
  lines: number,
  aim: ((input: InputBackend) => Promise<void>) | null,
  log: (message: string) => void,
): ScrollOperation {
  let cancelled = false;
  const done = (async () => {
    try {
      const input = getBackend();
      if (aim) await aim(input);
      const deltas = wheelDeltas(lines);
      for (let i = 0; i < deltas.length; i++) {
        if (cancelled) return;
        input.wheel(deltas[i]!);
        if (i + 1 < deltas.length) await sleep(SCROLL_EVENT_GAP_MS);
      }
    } catch (error) {
      if (!cancelled) log(`scroll ${lines} failed: ${(error as Error).message}`);
    }
  })();
  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}

// Targets the supplied terminal-pane position only while that terminal owns
// the foreground; otherwise the wheel goes under the pointer like a real one.
export function postScroll(
  lines: number,
  xFraction: number,
  yFraction: number,
  windowOwner: string,
  log: (message: string) => void,
): ScrollOperation {
  return runScroll(
    lines,
    async (input) => {
      const front = input.foreground();
      if (front && sameProcess(front.processName, windowOwner)) {
        const at = paneLocation(front, xFraction, yFraction);
        input.setCursor(at.x, at.y);
        await sleep(POINTER_SETTLE_MS);
      }
    },
    log,
  );
}

// Behaves like a physical mouse wheel: Windows routes the event to the window
// under the pointer.
export function postSystemScroll(
  lines: number,
  log: (message: string) => void,
): ScrollOperation {
  return runScroll(lines, null, log);
}

// Brings the terminal that hosts Herdr to the foreground. Nothing is launched:
// no terminal window just means there is nothing to raise.
export async function raiseTerminal(
  processNames: readonly string[],
  titleHints: readonly string[],
  log: (message: string) => void,
): Promise<void> {
  try {
    const input = getBackend();
    const target = pickWindow(input.listWindows(), processNames, titleHints);
    if (target) input.raise(target.hwnd);
  } catch (error) {
    log(`raise terminal failed: ${(error as Error).message}`);
  }
}
