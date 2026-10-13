// Translates the Micro 2's key names into the names the upstream plugin's
// control logic was written for (the Codex Micro's first layer).
//
//   Micro 2 (keys bound to KV_OAI_AG<NN>)    upstream input
//   AG00-AG05  agent keys                    AG00-AG05
//   AG06-AG12  command keys                  ACT06-ACT12
//   AG13 / AG14  dial clockwise / counter    ENC_CC / ENC_CW  (act 2 = one tick)
//   AG19  dial press                         ENC_CLK
//   AG15-AG18  joystick sector keys          ignored (the stick is read from kb.radial)
export interface DeviceInput {
  key: string;
  act: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function translateHid(k: string, act: number): DeviceInput | null {
  const match = /^AG(\d{2})$/.exec(k);
  if (!match) return null;
  const n = Number(match[1]);
  if (n <= 5) return { key: k, act };
  if (n <= 12) return { key: `ACT${pad2(n)}`, act };
  // Upstream's ENC_CW/ENC_CC are the Codex Micro's REPORTED directions, which
  // are opposite the physical rotation (see dial-next in controls.ts). The
  // Micro 2 reports the physical direction, so clockwise is upstream's ENC_CC.
  // Each detent is a press/release pair; the press is the tick.
  if (n === 13) return act === 1 ? { key: "ENC_CC", act: 2 } : null;
  if (n === 14) return act === 1 ? { key: "ENC_CW", act: 2 } : null;
  if (n === 19) return { key: "ENC_CLK", act };
  return null;
}
