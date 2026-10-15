# herdr-micro-win

Use a Work Louder **Creator Micro 2** with [Herdr](https://herdr.dev) on **Windows**: the six top keys
light with live agent status and focus the agent on press; the dial, joystick and command keys control
Herdr. A Windows/Micro 2 port of `codex-micro` from
[alasano/house-of-herdr](https://github.com/alasano/house-of-herdr) (see NOTICE.md).

**Requires:** Windows 11, Herdr ≥ 0.9.3, Node ≥ 22, Creator Micro 2 on firmware 0.6.x.

## Install

### On a new computer

1. **Prerequisites:** Windows 11, Herdr 0.9.3 or newer, Node 22 or newer, and the Creator Micro 2 on
   firmware 0.6.x.
2. **Copy the folder.** Leave out `node_modules` and `dist`: both are rebuilt, and `node_modules` holds
   native pieces for the machine it was installed on. A zip or a git clone works.
3. **Build and link**, from inside the folder:

       npm install && npm run build
       herdr plugin link .

   The daemon starts with Herdr. Quit Work Louder's Input app (and anything else driving the pad, such as
   the Codex app) first.
4. **Config (optional):** copy `config.example.json` to
   `%APPDATA%\herdr\plugins\config\herdr.micro2\config.json`. Without it the plugin runs on its defaults.
   See CONFIGURING.md for every setting.

## Layers

The plugin owns **layer 1** (profile 1 in the Input app). On the Micro 2 the Input app's profiles 2 and 3
are layers 2 and 3: configure them freely. While the pad is on another layer its lights are off and the
plugin ignores it. The first time it runs it **binds layer 1's keys, dial and joystick** to `KV_OAI_AG*`
(they stop typing their letters) after saving the original to `<state dir>\backup\keymap-original.json`.
The `restore-keymap` action puts layer 1 back and stops the daemon.

## Controls (defaults)

| Control | Action |
|---|---|
| Keys 1-6 (top two rows, left to right) | Focus the assigned Herdr agent |
| Joystick | Move pane focus; circle the stick to keep moving |
| Dial turn | Cycle workspaces or agents (clockwise = next); in scroll mode, scroll Herdr's focused pane |
| Dial click | Switch dial mode (workspaces, agents, scroll) |
| Row 3 keys, wide bar, bottom key | `ACT06`-`ACT12`: popup, Escape, previous/next tab, unbound, unbound, Enter |

Everything except the six agent keys is remappable; see [CONFIGURING.md](CONFIGURING.md). The input names
`ACT06`-`ACT12` are upstream's; on the Micro 2 they are the keys after the first six, in reading order.

## XPAD Mini (optional second pad)

The plugin can also drive a Pulsar Lab **XPAD Mini** (its 13 LEDs and 240x135 LCD) from Herdr's agent
status, alongside the Micro 2. Turn it on from the popup's Lighting tab (`x` cycles the mode) or set
`xpad_mode` in `config.json`:

| `xpad_mode` | The pad shows |
|---|---|
| `off` (default) | nothing; the pad is left alone |
| `worst` | the neediest agent: blue scanning dot (working), flashing red (blocked), pulsing green (done), dark (idle), plus the matching Clawd animation on the LCD |
| `focused` | the same, for whichever agent Herdr has focused |
| `per-key` | the three keys show agents 1-3 (blue breathing, red, green, white), the bar and LCD show the worst state |

The LCD plays the built-in Clawd by default. `xpad_art: "pixel"` (or `a` on the Lighting tab) switches to the
pixel-art Clawd bundled in `assets/xpad-pixel/`; see NOTICE.md for its licensing.

Either pad can be unplugged: each is found and reconnected on its own. The pad's keys are not touched.
Quit the XPAD app (xpad-mini-claude-code) first if you run it, since only one program can drive the pad. Brightness
from the Lighting tab applies to both pads.

## Ring lighting

The popup has a **Lighting** tab (`tab` switches tabs) for the back strip and the border around the pad, which are
one lighting zone. Three profiles, picked with `1` / `2` / `3` and saved: **1** the dial mode (the default),
**2** the worst agent state, **3** Work Louder's stock rainbow.

## Not yet

Herdr inside WSL2 and kitty-on-WSLg.

## Diagnose

    node dist/doctor.js
