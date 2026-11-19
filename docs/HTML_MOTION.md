# HTML motion → After Effects

ClaudeAE converts an HTML animation into native, editable After Effects layers. Drop the `.html` file on the
**Claude AE** panel (Import tab), or call `ae_import_html` from Claude.

## How it works

1. The page opens in headless Chrome or Microsoft Edge with a **virtual clock**: `Date`, `performance.now`,
   timers, `requestAnimationFrame`, CSS animations/transitions, Web Animations, SVG SMIL and `<video>` all
   follow ClaudeAE's frame stepping, and `Math.random` is seeded. Every run is identical.
2. The stage is found (`#stage`, `[data-stage]`, `.stage`, or the largest element with a video size) and the
   viewport is set to its exact size.
3. Every frame, everything that paints is recorded in stage coordinates with a stable identity.
4. Each element's samples become tracks; each track is fitted back into a few keyframes — standard eases
   (`easeOutCubic`, `easeInOutExpo`, `easeOutBack`, CSS `ease-in-out` …), a fitted cubic-bezier, or simplified
   linear keys for physics-like motion. Moves that start between frames (CSS delays) get sub-frame key times.
5. The result is a Claude Motion spec (saved as `<page> (ClaudeAE)/motion.json` next to the HTML) which the
   engine builds in After Effects.

## Mapping

| HTML / CSS / SVG | After Effects |
|---|---|
| text (every rendered line) | text layer, same font family/weight/size/colour/tracking, placed on the browser baseline |
| colour change of text | Fill effect with colour keyframes |
| `background-clip: text` gradient | gradient shape layer matted by the text layer |
| box with background / border / radius / box-shadow | shape layer: rectangle + fill / stroke + roundness, Drop Shadow effect |
| 2-colour `linear-gradient` / `radial-gradient` | gradient fill |
| `transform` translate / scale / rotate | position / scale / rotation keyframes (orbiting origins handled) |
| `opacity` (including ancestors) | opacity keyframes |
| `overflow: hidden` containers | shape layer used as an alpha track matte |
| `filter: blur()` / `drop-shadow()` | Gaussian Blur / Drop Shadow |
| `mix-blend-mode` | layer blending mode |
| SVG path / rect / circle / ellipse / line / polyline / polygon | shape layer in the SVG's own coordinates, layer transform = the element's matrix |
| SVG `stroke-dasharray` + animated `stroke-dashoffset` | Trim Paths (draw-on) |
| SVG gradient fill | gradient fill |
| animated SVG `d` | path keyframes |
| `<img>` | footage layer |
| `<video>` (H.264 MP4) | footage layer, timed to the page |
| `<canvas>` / WebGL | PNG image sequence |

## Limits

- `::before` / `::after` content is not captured — use real elements for visible things.
- CSS 3D transforms are flattened to 2D; skew is dropped.
- Gradients with 3+ stops, conic and repeating gradients become 2-colour gradients; gradient transparency is not kept.
- Per-side borders use the top border; inset shadows and spread are ignored.
- CSS background images are imported as footage.
- Very long or looping pages: declare `const DURATION = <seconds>;` (otherwise up to 30 s are measured).

## Template

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>My Animation</title>
<style>
  body { margin: 0; background: #000; }
  #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #0b0b12;
           font-family: "Inter", "Segoe UI", Arial, sans-serif; }
  .title { position: absolute; left: 0; right: 0; top: 440px; text-align: center; font-size: 120px; font-weight: 700; color: #fff; }
  .title span { display: inline-block; opacity: 0; transform: translateY(60px);
                animation: up .8s cubic-bezier(.22, 1, .36, 1) forwards; }
  .title span:nth-child(2) { animation-delay: .1s; }
  @keyframes up { to { opacity: 1; transform: none; } }
</style>
</head>
<body>
  <div id="stage">
    <div class="title"><span>Hello</span> <span>world</span></div>
  </div>
  <script>const DURATION = 4;</script>
</body>
</html>
```
