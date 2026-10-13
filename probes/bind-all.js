"use strict";
// Probe helper (WRITES the keymap, layer 1 only). Usage: node probes/bind-all.js apply|restore
//  apply:   snapshot the current keymap, then bind keys 6-12 to KV_OAI_AG06-12 and the dial press to KV_OAI_AG19
//  restore: put layer 1 back from the snapshot (other layers are left alone)
const fs = require("node:fs");
const path = require("node:path");
const { WLDevice } = require("../../micro-manager-win/lib/device");
const { position } = require("../../micro-manager-win/lib/pad");

const outDir = path.join(__dirname, "out");
const snapshotFile = path.join(outDir, "keymap-before-probe.json");
const mode = process.argv[2];
const code = (n) => `KV_OAI_AG${String(n).padStart(2, "0")}`;

(async () => {
  const dev = new WLDevice();
  dev.connect();
  const read = async () => JSON.parse((await dev.call("fs.read", { file: "keymap.json" })).data);
  try {
    if (mode === "apply") {
      fs.mkdirSync(outDir, { recursive: true });
      const raw = await dev.call("fs.read", { file: "keymap.json" });
      if (!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile, JSON.stringify(raw));
      const cfg = JSON.parse(raw.data);
      const layout = cfg.profiles[0].layers[0].layout;
      for (const key of [6, 8, 9, 10, 11, 12]) {
        const at = position(key);
        layout.keymap[at.row][at.column] = code(key);
      }
      layout.encoders[0][2] = code(19); // dial press
      await dev.call("fs.write", { file: "keymap.json", data: JSON.stringify(cfg) });
      const after = (await read()).profiles[0].layers[0].layout;
      console.log("keymap row 2:", JSON.stringify(after.keymap[2]), "row 3:", JSON.stringify(after.keymap[3]));
      console.log("encoder:", JSON.stringify(after.encoders[0]));
      const ok = after.keymap[3].every((c, i) => c === code([10, 11, 12][i])) && after.encoders[0][2] === code(19);
      console.log(ok ? "APPLIED" : "NOT ACCEPTED");
    } else if (mode === "restore") {
      const snap = JSON.parse(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).data);
      const cfg = await read();
      cfg.profiles[0].layers[0] = snap.profiles[0].layers[0];
      await dev.call("fs.write", { file: "keymap.json", data: JSON.stringify(cfg) });
      const back = await read();
      console.log(JSON.stringify(back.profiles[0].layers[0]) === JSON.stringify(snap.profiles[0].layers[0]) ? "RESTORED" : "RESTORE MISMATCH");
    } else {
      console.log("usage: node probes/bind-all.js apply|restore");
    }
  } finally { dev.disconnect(); process.exit(0); }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
