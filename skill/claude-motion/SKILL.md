---
name: claude-motion
description: Create motion graphics that open in Adobe After Effects as native, editable compositions — logo reveals, kinetic type, titles, lower thirds, explainers, UI and product animations, social videos. Use whenever the user wants an animation "for After Effects", "editable in AE", as an AE comp or .aep, mentions ClaudeAE, or asks Claude to build or change their After Effects timeline. Three routes - live through the ClaudeAE MCP tools (ae_*), an HTML motion page the ClaudeAE panel converts into layers, or Claude Motion JSON.
---

# Motion design for After Effects (ClaudeAE)

ClaudeAE turns motion into real After Effects content: text layers, shape layers, eased keyframes,
masks/track mattes, effects, precomps — nothing is flattened to video unless it has to be.

## 1. Choose the route

| Situation | Route |
|---|---|
| `ae_*` tools are available (ClaudeAE MCP connected) | **Build live in After Effects.** See §2. |
| No tools, the user wants to watch it first, or you are in a chat with artifacts | **HTML motion page.** Make it an artifact / file; the user drops it on the ClaudeAE panel (Import tab). See §3. |
| The user wants AE-specific structure (precomps, expressions, text animators, effects, exact keyframes) without live tools | **Claude Motion JSON** file, imported from the panel. See §4 and `reference/format.md`. |

If the tools exist, prefer route 1 — and you can still import HTML or JSON yourself with `ae_import_html` / `ae_import_motion`.

## 2. Live in After Effects (ae_* tools)

1. `ae_status`, then `ae_get_project` / `ae_get_comp` to see what is open (layer names, timing, what is animated).
2. Plan the piece in beats before building: size, fps, duration, layers top→bottom, and when each thing happens.
3. Build in as few calls as possible: `ae_create_comp` with `layers`, `ae_add_layers` (many layers at once), or `ae_import_motion` for multi-comp designs. Read `ae_motion_format` before writing a big spec.
4. Edit precisely: `ae_update_layer`, `ae_set_property` (keyframes at exact times — seconds, `"12f"` or `"00:00:02:10"`), `ae_add_effect`, `ae_move_layer`, `ae_precompose`.
5. Generate graphics by writing SVG and calling `ae_import_svg` (paths, gradients and strokes become editable shapes). Import footage/URLs at exact times with `ae_import_file`.
6. **Look at your work**: `ae_render_frame` at 2–3 key times; fix overlaps, contrast, alignment, timing. Then summarise what you built.
7. Every call is one undo step; `ae_undo` reverts. Don't delete or overwrite the user's layers unless asked.

## 3. HTML motion pages (convert to native layers)

Write the animation exactly as you normally would (CSS animations, Web Animations, GSAP, `requestAnimationFrame`,
SVG). The ClaudeAE panel plays the page frame by frame in headless Chrome/Edge and rebuilds what it sees.
Follow these rules so everything stays editable:

1. **One HTML file.** Pictures/fonts next to it with relative paths or as data URIs. Libraries from a CDN are fine.
2. **A fixed-size stage in px**: `<div id="stage">` sized 1920×1080 / 1080×1920 / 1080×1080 … with
   `position: relative; overflow: hidden`. Scaling the stage to fit the window is fine.
3. **Declare the length**: `const DURATION = 6;` (seconds) at the top level of a script.
4. **Autoplay and determinism**: starts on load, no clicks; same time → same picture (`Math.random` is seeded).
5. **Real text** in HTML/SVG elements (never images of text). Use installed fonts or Google Fonts.
6. **Each independently moving thing is its own element** — wrap letters/words in `<span>`s for staggered type.
7. **Prefer these (they map 1:1):** transform (translate / scale / rotate), opacity, colours, width/height,
   border-radius, borders, box-shadow, 2-colour linear/radial gradients, `filter: blur()` / `drop-shadow()`,
   `mix-blend-mode`, `overflow: hidden` reveals (become track mattes), SVG shapes, SVG stroke draw-ons
   (`stroke-dasharray` + `stroke-dashoffset` → Trim Paths), animated SVG `d`, `<img>`, `<video>` (H.264 MP4).
8. **Avoid for visible things:** `::before` / `::after` content (not captured — use real elements), CSS 3D
   (flattened), skew (dropped), 3+ colour / conic / repeating gradients (become 2-colour), per-side borders,
   `<canvas>`/WebGL (becomes an image sequence), background images (imported as footage).

Deliver: save `<Name>.html`, give the user its full path (or the artifact) and tell them:
After Effects → Window → Extensions → **Claude AE** → **Import** → drop the file (or *Choose file…*).
Details and a template: `reference/html-motion.md`. Examples: `examples/`.

## 4. Claude Motion JSON

A JSON description of compositions → layers → keyframes, built natively by ClaudeAE.
Minimal example:

```json
{ "format": "claude-motion", "version": 1, "name": "Title Card",
  "width": 1920, "height": 1080, "fps": 30, "duration": 5, "backgroundColor": "#0b0b12",
  "layers": [
    { "type": "text", "name": "Title", "text": { "content": "Hello", "fontFamily": "Inter", "fontStyle": "Bold", "fontSize": 140, "color": "#ffffff" },
      "transform": { "position": [960, 540], "opacity": [{ "t": 0, "v": 0, "ease": "easeOutCubic" }, { "t": 0.6, "v": 100 }] } },
    { "type": "shape", "name": "Underline", "transform": { "position": [960, 640] },
      "shapes": [{ "type": "rect", "size": [520, 10], "roundness": 5, "fill": "#f59e7a",
        "transform": { "scale": [{ "t": 0.3, "v": [0, 100], "ease": "easeOutExpo" }, { "t": 1.1, "v": [100, 100] }] } }] }
  ] }
```

Rules of thumb: `layers[0]` is the top layer; times are comp seconds (or `"12f"`, timecode); `ease` on a
keyframe shapes the move to the next key; shape geometry is relative to the layer position; colours are hex.
Full reference: `reference/format.md`.

## 5. Make it look designed

- Pick a clear hierarchy: one hero element, supporting text smaller and calmer.
- Time in beats; stagger related elements by 2–5 frames; give text time to be read (≈ 3 words per second).
- Entrances: `easeOut*` (cubic/quint/expo); exits: `easeIn*`; moves: `easeInOut*`; overshoot: `easeOutBack`.
- Animate few properties well (position + opacity, or scale + opacity) instead of everything at once.
- Keep 5–8% safe margins; check contrast on every background; use 2–3 colours plus neutrals.
- Use a `null` (JSON) or a wrapper element (HTML) as a rig for things that move together.
