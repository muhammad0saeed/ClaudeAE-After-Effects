# ClaudeAE — Claude ⇄ Adobe After Effects

Open-source bridge that lets Claude **see and edit your After Effects timeline** and turns Claude's motion
designs into **native, editable** compositions — text layers, shape layers, eased keyframes, masks, track
mattes, effects and precomps.

- **Claude Desktop / Claude Code / any MCP app** → 31 After Effects tools over MCP (build comps, add layers at
  exact times, keyframes with real easing, effects, SVG → shapes, import files, render frames so Claude can look at its work…).
- **Claude inside After Effects** → a dockable *Claude AE* panel with a chat (your Claude account through Claude
  Code, or an Anthropic API key), plus importers and an activity log with one-click undo.
- **Import Claude's motion designs**:
  - **HTML motion pages** (CSS animations, GSAP, Web Animations, SVG, `requestAnimationFrame`) → played frame by frame in
    headless Chrome/Edge and rebuilt as native layers with fitted eases. Measured on the bundled examples: mean
    pixel difference ≤ 1/255 between the browser and the After Effects render.
  - **Claude Motion JSON** → a documented format for compositions → layers → keyframes ([reference](docs/CLAUDE_MOTION_FORMAT.md)).
  - **SVG** → editable shape layers (paths, gradients, strokes, dashes, text → text layers).
- **A Claude skill** (`claude-motion`) that teaches Claude how to produce all of the above.

Everything runs locally. No accounts, keys or licence checks of its own. MIT licensed.

---

## Requirements

| | |
|---|---|
| Adobe After Effects | 2020 or newer (developed and tested on **After Effects 2026 / 26.3**, Windows 11) |
| Node.js | 18 or newer (MCP server, chat, HTML converter) |
| Chrome or Microsoft Edge | only for HTML import (Edge ships with Windows) |
| Claude | Claude Desktop, Claude Code, or an Anthropic API key — any of them |

macOS paths are implemented (AE discovery, osascript transport, Chrome/Edge discovery) but have not been tested yet.

## Install (Windows)

**Easy way:** download `ClaudeAE-v1.0.0.zip` from the [Releases](../../releases) page (or *Code → Download ZIP*),
unzip it to a folder you'll keep (e.g. `Documents\ClaudeAE`), install [Node.js LTS](https://nodejs.org) if you
don't have it, then double-click **`Install ClaudeAE.cmd`**. Step-by-step guide, checks and troubleshooting:
[INSTALL.txt](INSTALL.txt). To remove it, double-click **`Uninstall ClaudeAE.cmd`**.

**From a terminal** (same thing, with switches):

```bash
scripts\install.cmd -All
```

`-All` = link the After Effects extension + connect Claude Desktop + Claude Code + install the skill.
Use the individual switches `-ClaudeDesktop`, `-ClaudeCode`, `-Skill` instead if you prefer, `-Uninstall` to remove.
The installer:

1. checks Node.js and installs the npm packages,
2. allows unsigned CEP panels (`PlayerDebugMode`, per-user registry, CSXS 9–13) — skip with `-NoRegistry`,
3. links `extension/` into `%APPDATA%\Adobe\CEP\extensions\com.claudeae` (updates in this folder are live),
4. adds the `claudeae` MCP server to Claude Desktop (a backup of your config is kept next to it) / Claude Code,
5. installs the `claude-motion` skill for Claude Code and builds `dist/claude-motion-skill.zip` for the Claude app
   (*Settings → Capabilities → Skills → Upload skill*).

Then **restart After Effects** and **quit and reopen Claude Desktop**.

## Use

### From Claude Desktop (or Claude Code)
Open After Effects, then just ask Claude, e.g.:

> Check the After Effects connection, then build a 6-second 1080×1920 promo for "Nova Coffee" with a logo
> reveal, two feature cards and a call to action. Render a few frames and polish it.

> In the active comp, add a lower third for "Jane Doe — Producer" at 00:00:02:10 that leaves at 00:00:07:00.

> Make the selected text layers animate in word by word with a slight overshoot.

If After Effects is closed, the first tool call opens it.

### Inside After Effects
**Window → Extensions → Claude AE**

- **Chat** — talk to Claude next to your timeline. The active comp, playhead and selection are sent with every
  message (toggle *Timeline context*). Tool calls, warnings and rendered frames appear inline.
  Backends (Connect tab): **Claude account via Claude Code** (one-time *Sign in…*) or **Anthropic API key**.
- **Import** — drop a `.json` (Claude Motion), `.html` (motion page), `.svg`, or images/video/audio. Build into
  new comps, or into the active comp at the playhead (as a precomp or as layers).
- **Connect** — connect Claude Desktop / Claude Code, copy the MCP config, chat settings.
- **Activity** — every command Claude ran (from the panel or from MCP apps), with *Undo last action*.

### The skill
With the skill installed, ask any Claude for an animation "for After Effects". With the MCP tools it builds
live; without them it writes an HTML motion page (great as a claude.ai artifact) or a Claude Motion JSON that
you drop on the panel. See [skill/claude-motion/SKILL.md](skill/claude-motion/SKILL.md).

## MCP tools

| Inspect | Build & edit | Import & output |
|---|---|---|
| `ae_status` | `ae_create_comp` | `ae_import_motion` (Claude Motion JSON) |
| `ae_get_project` | `ae_update_comp` | `ae_import_html` (HTML motion page) |
| `ae_get_comp` | `ae_add_layers` | `ae_import_svg` (SVG → shapes) |
| `ae_get_layer` | `ae_update_layer` | `ae_import_file` (path / URL / base64, at an exact time) |
| `ae_get_property` | `ae_set_property` (values, keyframes, expressions) | `ae_render_frame` (returns an image) |
| `ae_list_effects` | `ae_add_effect` | `ae_render` (Render Queue) |
| `ae_list_fonts` | `ae_delete_layers`, `ae_duplicate_layer`, `ae_move_layer` | `ae_save_project` |
| `ae_motion_format` | `ae_precompose`, `ae_add_markers`, `ae_select_layers`, `ae_apply_preset` | |
| | `ae_run_script` (any ExtendScript), `ae_batch`, `ae_undo` | |

Times accept seconds, frames (`"12f"`), `"1.5s"`, `"500ms"` or timecode (`"00:00:01:12"`). Every tool call is a
single undo step in After Effects.

## How it fits together

```
Claude Desktop / Claude Code / MCP app ──stdio──▶ mcp-server/index.js ─┐
Claude AE panel chat ──▶ agent/agent.js (API or Claude Code) ──────────┤  lib/tools.js
Claude AE panel import ─────────────────────────────────────────────── ┘      │
                                                                               ▼
                                  lib/transport.js ──HTTP 127.0.0.1 + token──▶ CEP bridge (hidden extension, starts with AE)
                                          └── fallback: AfterFX.exe -r / osascript ──┐            │ evalScript
                                                                                     ▼            ▼
                                                                 extension/host/claudeae.jsx  (ExtendScript engine)
```

- `extension/host/claudeae.jsx` — the engine: one entry point (`ClaudeAE.run`), ~30 commands, the Claude Motion
  builder, exact cubic-bezier → speed/influence easing, private JSON codec (other panels may break the global one).
- `lib/html/` — HTML → motion converter (headless browser, virtual clock, extractor, keyframe fitting, builder).
- `lib/svg.js` — SVG parser (paths incl. arcs, transforms, CSS classes, gradients, `<use>`, text).

### Security
The bridge listens on `127.0.0.1` only, requires a random bearer token (stored in `~/.claudeae/bridge.json`,
rotated every session), and rejects browser requests (`Origin`) and foreign `Host` headers (DNS rebinding).
`ae_run_script` executes arbitrary ExtendScript in After Effects by design — only connect MCP apps you trust.
The API key for the panel chat is stored in `~/.claudeae/settings.json` on your computer.

## Development & tests

```bash
npm test
```
Node unit tests: SVG parser, spec normalizer, keyframe fitting, MCP protocol (official SDK client), chat agent
against a mock Messages API and a fake Claude Code CLI.

With After Effects open:

```bash
node tests/ae/engine.test.js
```
```bash
node tests/ae/mcp.e2e.js
```
```bash
node tests/ae/bridge.security.js
```
```bash
node tests/ae/html.e2e.js examples/html/gsap-title.html
```
```bash
node tests/ae/panel.test.js
```
The engine tests create everything inside a `ClaudeAE Tests` folder and remove it afterwards. The panel test drives
the real panel through its DevTools port (8197, from `extension/.debug`).

## Troubleshooting

| Problem | Fix |
|---|---|
| *Claude AE* missing from Window → Extensions | Restart After Effects; run `scripts\install.cmd` again; unsigned panels need `PlayerDebugMode` (installer). |
| Claude Desktop doesn't show the tools | Quit Claude Desktop completely (tray → Quit) and reopen. Check *Connect → Claude Desktop* in the panel. |
| "bridge is not running" | Open After Effects — the hidden bridge starts with it (or open the panel). `CLAUDEAE_TRANSPORT=cli` forces the command-line fallback. |
| Several AE versions installed | Set `CLAUDEAE_AE_PATH` to the `AfterFX.exe` you want. |
| Chat says "not signed in" | *Connect → Sign in…* opens a window running `claude auth login`. Or switch to an API key. |
| HTML import: wrong length | Add `const DURATION = <seconds>;` to the page, or set Duration in the Import tab. |
| A font comes out as Arial | Install the font; the warning lists the missing family/style. |

## License

MIT — see [LICENSE](LICENSE).

ClaudeAE is an independent open-source project. It is not made, endorsed or supported by Anthropic or Adobe.
"Claude" is a trademark of Anthropic; "After Effects" is a trademark of Adobe.
