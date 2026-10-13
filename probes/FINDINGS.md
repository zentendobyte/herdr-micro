# Probe findings — Creator Micro 2, firmware 0.6.3 (2026-10-10)

Method: `node probes/listen.js 75` (read-only). Layer 1 already bound by micro-manager-win:
keys 0–5 and 7 → `KV_OAI_AG00–05/07`, dial → `AG13/AG14`, joystick cardinals → `AG15–18`.
Raw log (not committed): `probes/out/listen-*.jsonl`.

## Observed
| input | what the pad sent |
|---|---|
| Agent keys 0–5, key 7 | `v.oai.hid {k:"AGnn", act:1}` then `{act:0}` ~100–160 ms later. Order matched the user's reading-order presses: top-left = AG00, top-right = AG01, then AG02–05 across row 2, AG07 third row second key. |
| Dial, clockwise | `AG13` act 1 then act 0 within ~1 ms, once per detent |
| Dial, counter-clockwise | `AG14`, same shape |
| Dial click | **nothing** (press keeps its stock keycode, not AG-bound) |
| Joystick | notification is **`kb.radial`**, NOT `v.oai.rad`: `{a, d, s, l, p, o}` — `a` angle 0..1, `d` distance 0..1 (saturates at 1), `s` sector 0–7 (−1 on release), `o` 2 while deflected / 0 on release; ~24 ms cadence |
| Joystick sector keys | `AG15/16/18` fired **on release/return to centre**, not on deflection |
| Unrelated | 7 replies to ids 204–210 we never issued ("foreign"); no other Work Louder/Codex/Electron process was running |

## Deltas vs the Codex Micro plugin (alasano/house-of-herdr, codex-micro)
- Dial ticks arrive as act 1/0 pairs; the plugin dispatches `ENC_CW/CC` only on `act === 2`.
- Joystick: plugin listens for `v.oai.rad`; this firmware sends `kb.radial` (different fields).
- Dial click is not observable until bound (needs a keymap write; untested).
- Keys 6, 8–12 not yet probed (unbound on layer 1).

## Still open
1. Joystick physical orientation: angles seen in push order were 0.24, 0.49, 0.01, 0.77 (then a circle with `a` increasing 0.77→0.99→0→0.25→0.5→0.77). Needs the user's push order / circle direction to decide whether 0.25 is up or down.
2. Can the encoder press be bound to an AG code (e.g. AG19)? Needs a keymap write.
3. Do keys 6–12 emit `AG06–AG12` when bound? Needs a keymap write.

---
# Guided probe (all keys bound) — results

Method: `probes/bind-all.js apply` (keys 6,8–12 → AG06,08–12; dial press → AG19), then voice-guided
`probes/guided.js`, then `probes/bind-all.js restore`. Raw log: `probes/out/guided-*.jsonl`.

| input | result |
|---|---|
| Keys 0–12 | all report `AGnn` act 1/0. Top-left = AG00, top-right = AG01; row 2 = AG02–05; row 3 = AG06–09; bottom row: wide cap left end = **AG10**, right end = **AG11** (distinct), bottom-right = AG12 |
| Dial clockwise | `AG13` (1/0 pair per detent) |
| Dial counter-clockwise | `AG14` |
| **Dial press** | `AG19` act 1 then 0 — **bindable** (`encoders[0][2] = "KV_OAI_AG19"` accepted and works) |
| Joystick notification | `kb.radial {a, d, s, l, p, o}`; no `v.oai.rad` |
| **Joystick angle** | **0 = right, increases CLOCKWISE** (right 0.01, down 0.24, left 0.49, up 0.76). Circle trace clockwise: 0.76→0.89→0.01→0.24→0.50→0.73. The hacking guide's "counter-clockwise, 0.25 = north" is wrong for fw 0.6.3 |
| Joystick sector keys | centre 0.25 → **AG15 = DOWN**, 0.5 → AG16 = LEFT, 0.75 → AG17 = **UP**, 0.0 → AG18 = RIGHT |
| `s` field | sector 0–7 clockwise (4 = up, 6 = right, 0 = down, 2 = left); −1 on release |

## Consequences
- Plugin joystick maths (clockwise from east; sectors right, down, left, up) is already correct for the Micro 2.
- Plugin names map: AG00–05 agent keys; AG06–12 = ACT06–12; AG13/14 = ENC_CW/ENC_CC (act 1, not act 2); AG19 = ENC_CLK; joystick from `kb.radial` (a, d).
- micro-manager-win has joystick north/south swapped (it assumed AG15 = north).
