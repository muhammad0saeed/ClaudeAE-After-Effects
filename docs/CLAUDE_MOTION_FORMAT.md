# Claude Motion format (v1)

A JSON description of an After Effects motion design. ClaudeAE builds it as **native, editable**
compositions, layers, shapes, text, keyframes, effects and expressions — nothing is rasterised.

Use it through the MCP tool `ae_import_motion`, the panel's **Import** tab (drop a `.json`), or
`ae_create_comp` / `ae_add_layers` for single comps (they take the same layer objects).

```json
{
  "format": "claude-motion",
  "version": 1,
  "name": "Product Launch",
  "defaultEase": "easeInOutCubic",
  "assets": [{ "id": "logo", "path": "C:/brand/logo.png" }],
  "main": "main",
  "compositions": [
    {
      "id": "main", "name": "Launch 16x9",
      "width": 1920, "height": 1080, "fps": 30, "duration": 8,
      "backgroundColor": "#0b0b12",
      "markers": [{ "time": 2, "comment": "Beat 1" }],
      "layers": [ /* first = top of the timeline */ ]
    }
  ]
}
```

Shorthand for one composition: put `width`, `height`, `fps`, `duration`, `backgroundColor` and `layers`
at the top level and omit `compositions`.

## Conventions

| Thing | Rule |
|---|---|
| Layer order | `layers[0]` is the **top** layer (same as the AE timeline). |
| Coordinates | Pixels, origin at the comp's top-left. `position` is where the layer's anchor point sits. |
| Shape geometry | Relative to the shape layer's own origin, so a `rect` at `[0,0]` is centred on the layer `position`. |
| Text | Anchor is centred on the text box by default (`"anchor": "baseline"` keeps AE's native baseline anchor). |
| Times | Seconds in **composition time** (number), or strings: `"24f"`, `"1.5s"`, `"500ms"`, `"00:00:01:12"` (hh:mm:ss:ff). |
| Colours | `"#rrggbb"`, `"#rgb"`, `"#rrggbbaa"`, `"rgb(…)"`, named colours, or `[r,g,b]` with 0–1 values. |
| Angles | Degrees. Opacity / percentages: 0–100. Scale: percent, `100` or `[100,100]`. |

## Animation

Any animatable value can be a static value, a keyframe list, or an object with keyframes and/or an expression:

```json
"opacity": 100
"opacity": [{ "t": 0, "v": 0, "ease": "easeOutCubic" }, { "t": "12f", "v": 100 }]
"rotation": { "keyframes": [{ "t": 0, "v": 0 }, { "t": 2, "v": 360 }], "expression": "loopOut()" }
"position": { "value": [960, 540], "expression": "wiggle(2, 20)" }
```

Keyframe fields: `t` (or `time` / `frame`), `v` (or `value`), and optionally:

- `ease` — shapes the segment **from this key to the next** (CSS/GSAP convention):
  `linear` (default), `hold`, `easyEase`, `ease`, `easeIn`, `easeOut`, `easeInOut`,
  `easeIn|Out|InOut` + `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back` (e.g. `easeOutBack`),
  GSAP names (`power2.out`, `expo.inOut`, `back.out`), or a cubic-bezier `[x1, y1, x2, y2]` /
  `"cubic-bezier(0.2,0.8,0.2,1)"`. Beziers are converted exactly to AE speed/influence.
- `easeIn` / `easeOut` — raw AE temporal ease `{ "speed": 0, "influence": 75 }` for this key.
- `spatialIn` / `spatialOut` — position path tangents (default: straight lines between keys).
- `hold: true` — hold this value until the next key.

Set `"defaultEase"` on the spec, a composition, or a tool call to change the default from `linear`.

## Layers

Common fields (all optional except `type`):

```json
{
  "type": "shape",                 // solid | adjustment | shape | text | null | camera | light | footage | precomp | svg
  "id": "card",                    // reference for parent / trackMatte (defaults to name)
  "name": "Card",
  "inPoint": 0.5, "outPoint": 6,   // or "duration": 5.5
  "startTime": 0,                  // footage/precomp source offset (defaults to inPoint for timed sources)
  "parent": "rig",                 // child transform values are in the parent's space
  "threeD": true, "blendMode": "screen", "motionBlur": true,
  "enabled": true, "solo": false, "shy": false, "locked": false, "guide": false, "label": 9, "comment": "",
  "adjustment": false, "collapseTransformation": false, "autoOrient": "path",
  "trackMatte": { "layer": "matte", "type": "alpha" },   // alpha | alphaInverted | luma | lumaInverted
  "transform": { "anchorPoint": [0,0], "position": [960,540], "scale": 100, "rotation": 0, "opacity": 100 },
  "masks": [ … ], "effects": [ … ], "markers": [ … ],
  "expressions": { "Transform/Rotation": "time * 30" },
  "properties": { "Contents/Card/Transform/Skew": 10 }
}
```

`transform` keys: `anchorPoint`, `position`, `positionX`/`positionY`/`positionZ` (separates dimensions),
`scale`, `rotation`, `rotationX`, `rotationY`, `orientation`, `opacity`. For cameras `pointOfInterest`.

Blend modes: `normal, darken, multiply, colorBurn, linearBurn, darkerColor, lighten, screen, colorDodge,
linearDodge, add, lighterColor, overlay, softLight, hardLight, linearLight, vividLight, pinLight, hardMix,
difference, exclusion, subtract, divide, hue, saturation, color, luminosity, stencilAlpha, silhouetteAlpha …`

`properties` / `expressions` keys are property paths: display names or match names joined by `/`
(`"Effects/Glow/Glow Radius"`, `"Text/Animators/Animator 1/Properties/Opacity"`), or shortcuts
(`position`, `scale`, `rotation`, `opacity`, `anchorPoint`, `sourceText`, `timeRemap`, `zoom` …).

### solid / adjustment
`"color": "#1e293b"`, `"width"`, `"height"` (default: comp size). Adjustment layers apply their effects to everything below.

### null
Invisible controller — use as a `parent` rig.

### shape
```json
{ "type": "shape", "name": "Badge", "transform": { "position": [960, 540] },
  "shapes": [
    { "type": "rect", "name": "Plate", "size": [480, 160], "roundness": 32,
      "fill": "#ff5a1f", "stroke": { "color": "#ffffff", "width": 4 },
      "transform": { "position": [0, 0], "scale": [{ "t": 0, "v": [0,0], "ease": "easeOutBack" }, { "t": 0.6, "v": [100,100] }] } },
    { "type": "ellipse", "radius": 40, "fill": { "color": "#22d3ee", "opacity": 80 } },
    { "type": "path", "d": "M-200 80 C -100 0 100 0 200 80", "stroke": { "color": "#fff", "width": 6, "lineCap": "round" },
      "trimPaths": { "end": [{ "t": 0, "v": 0, "ease": "easeInOutCubic" }, { "t": 1.2, "v": 100 }] } }
  ] }
```

Shape item types:

| type | fields |
|---|---|
| `rect` | `size` [w,h], `position`, `roundness` |
| `ellipse` | `size` [w,h] or `radius`, `position` |
| `star` / `polygon` | `points`, `outerRadius`, `innerRadius` (star), `outerRoundness`, `innerRoundness`, `rotation`, `position` |
| `path` | `d` (SVG path data, may contain several sub-paths) **or** `path` `{vertices, inTangents, outTangents, closed}` (animatable: keyframe values can be `d` strings with the same number of points) **or** `paths` [ … ] |
| `group` | `items` [ … ], `transform` |
| `fill` | `color`, `opacity`, `rule` (`nonzero`/`evenodd`) |
| `stroke` | `color`, `width`, `opacity`, `lineCap` (butt/round/square), `lineJoin` (miter/round/bevel), `miterLimit`, `dashes` [dash, gap, …], `dashOffset` |
| `gradientFill` | `gradientType` (linear/radial), `start`, `end`, `colors` [from, to] |
| `trimPaths` | `start`, `end`, `offset`, `multiple` (simultaneously/individually) |
| `repeater` | `copies`, `offset`, `composite` (above/below), `transform` {position, scale, rotation, anchorPoint, startOpacity, endOpacity} |
| `roundCorners` `offsetPaths` `zigzag` `wigglePaths` `twist` `puckerBloat` `mergePaths` | their AE parameters (`radius`, `amount`, `size`, `ridges`, `angle`, `mode`…) |
| `svg` | `svg` markup or `file`: converted into a group of native shapes |

Convenience: a `rect`/`ellipse`/`star`/`polygon`/`path` with `fill`, `stroke`, `gradient`, `transform`,
`trimPaths`, `repeater`, `roundCorners` … becomes its own named group containing the path, modifiers and
paint (stroke drawn above fill unless `"strokeBelowFill": true`). Items listed first draw on top.
Group `transform`: `anchorPoint`, `position`, `scale`, `rotation`, `skew`, `skewAxis`, `opacity`.

Gradients: After Effects scripting cannot set gradient colour stops directly, so a 2-colour gradient is
built as a white→black gradient remapped by a *Tint* effect named "Gradient Colors" on the layer. Keep
each gradient on its own shape layer (the tint applies to the whole layer). More than two stops → first & last.

### text
```json
{ "type": "text", "name": "Headline",
  "text": { "content": "Meet Claude\nin After Effects", "font": "Inter-Bold", "fontSize": 96, "color": "#ffffff",
            "justification": "center", "tracking": -10, "leading": 100,
            "animators": [{ "name": "Rise", "properties": { "opacity": 0, "position": [0, 60], "blur": 8 },
                            "selector": { "basedOn": "words", "shape": "rampUp", "easeHigh": 60,
                                          "offset": [{ "t": 0, "v": -100, "ease": "easeOutCubic" }, { "t": 1.2, "v": 100 }] } }] },
  "transform": { "position": [960, 540] } }
```

`text` fields: `content` (string, `\n` for new lines, or keyframes of strings), `font` (PostScript name, e.g.
`Arial-BoldMT`; `ae_list_fonts` lists them) **or** `fontFamily` + `fontStyle`/`fontWeight`, `fontSize`,
`color`, `stroke` {color, width} / `strokeColor` / `strokeWidth`, `strokeOverFill`, `justification`
(left/center/right/justify), `tracking` (1/1000 em) or `letterSpacing` (px), `leading` (px) or `lineHeight`
(multiplier), `baselineShift`, `allCaps`, `smallCaps`, `fauxBold`, `fauxItalic`, `box` [w,h] (paragraph text),
`anchor` (`center` default, `baseline`, `top-left`, `top`, `left`, `bottom-right`, …), `animators`.
Missing fonts fall back to Arial with a warning.

Animator `properties`: `opacity`, `position`, `scale`, `rotation`, `rotationX`, `rotationY`, `anchorPoint`,
`skew`, `skewAxis`, `tracking`, `lineSpacing`, `blur`, `fillColor`, `strokeColor`, `fillOpacity`,
`strokeWidth`, `characterOffset`, `fillHue`. Selector: `start`, `end`, `offset` (%), `basedOn`
(characters/charactersExcludingSpaces/words/lines), `shape` (square/rampUp/rampDown/triangle/round/smooth),
`mode`, `amount`, `smoothness`, `easeHigh`, `easeLow`, `randomize`, `seed`, `units` (percentage/index).

### footage (image / video / audio / svg file / sequence)
`"asset": "<asset id>"` or `"path": "C:/…/clip.mp4"` (or `"url"` / `"data"` — downloaded/decoded first),
`"sequence": true` for image sequences, `"fit": "contain"|"cover"|"width"|"height"|"stretch"`,
`"sourceIn": 2` trims the first 2 s of the clip, `"timeStretch": 50` (percent), `"timeRemap": true` or keyframes.

### precomp
`"comp": "<composition id in this spec>"` (or an existing project comp name / id). The precomp starts at
`inPoint` (its `startTime` defaults to the in point) and lasts as long as the nested comp.

### svg (generate graphics)
`"svg": "<svg …>…</svg>"` or `"file": "logo.svg"` — converted to a native shape layer (paths, rects,
circles, ellipses, lines, polygons, groups, transforms, fills, strokes, dashes, 2-colour gradients, CSS
classes). `<text>` becomes text layers parented to it. `"width"`/`"height"` scale it; the artwork is centred
on the layer position. `"as": "footage"` imports the SVG file flat instead.

### camera / light
Camera: `"zoom"`, `transform.position` / `pointOfInterest`; 3D layers need `"threeD": true`.
Light: `"lightType": "point|spot|parallel|ambient"`, `"color"`, `"intensity"`, `"castsShadows"`.

## Masks
```json
"masks": [
  { "rect": [x, y, w, h], "roundness": 20, "mode": "add", "feather": 10, "opacity": 100, "expansion": 0, "inverted": false },
  { "ellipse": [cx, cy, rx, ry] },
  { "d": "M0 0 L100 0 L50 80 Z", "mode": "subtract" },
  { "path": [{ "t": 0, "v": "M…" }, { "t": 1, "v": "M…" }] }
]
```
Mask coordinates are in layer space (solids/footage: from the layer's top-left).

## Effects
```json
"effects": [
  { "name": "Gaussian Blur", "properties": { "Blurriness": [{ "t": 0, "v": 30 }, { "t": 0.5, "v": 0 }] } },
  { "matchName": "ADBE Glo2", "label": "Soft Glow", "properties": { "Glow Radius": 40, "Glow Intensity": 1.5 } },
  { "name": "dropShadow", "properties": { "Distance": 20, "Softness": 40, "Opacity": 128 } }
]
```
`name` is the display name (or a shortcut: `blur`, `glow`, `dropShadow`, `fill`, `tint`, `gradientRamp`,
`fractalNoise`, `turbulentDisplace`, `curves`, `levels`, `hueSaturation`, `exposure`, `linearWipe`,
`radialWipe`, `motionTile`, `echo`, `slider`, `checkbox`, `colorControl`, `pointControl` …); `matchName`
is locale independent. Property keys are the parameter names shown in the Effect Controls panel.
Note: some percentages are stored 0–255 by AE (e.g. Drop Shadow *Opacity* 128 ≈ 50 %).

## Markers
`[{ "time": 2, "comment": "Drop", "duration": 0.5, "label": 3, "chapter": "", "url": "" }]` on a
composition or a layer.

## Import modes (`ae_import_motion`)
- `new` — creates the comps in a new project folder named after the spec (`Name`, `Name 2`, …) and opens the main comp.
- `precomp` — as `new`, then adds the main comp as a layer to `comp` at `time` (default: playhead).
- `flatten` — builds the main comp's layers directly inside `comp`, every time shifted by `time`.

## Tips for great results
- Plan beats on a timeline first (e.g. 0–0.6 s intro, 0.6–2 s headline …) and stagger with small offsets (3–6 frames).
- Prefer `easeOut*` for entrances, `easeIn*` for exits, `easeInOut*` for moves; overshoot with `easeOutBack`.
- Use a `null` rig as `parent` for groups that move together; use precomps for reusable pieces.
- Keep text as text layers and graphics as shapes so everything stays editable.
- After building, call `ae_render_frame` at key times and fix spacing, contrast and timing.
