/*
 * ClaudeAE engine — ExtendScript (ES3) for Adobe After Effects.
 *
 * Every entry point goes through ClaudeAE.run(jsonString) which returns a JSON string:
 *   { "ok": true,  "result": ..., "warnings": [...] }
 *   { "ok": false, "error": { "message": ..., "line": ... }, "warnings": [...] }
 *
 * The same file is loaded by the CEP bridge (evalScript) and by the command-line
 * transport (AfterFX.exe -r), so it must stay plain ES3: no Array.indexOf/forEach,
 * no Object.keys, no trailing commas.
 *
 * MIT License — part of the ClaudeAE project.
 */

/* ---------------------------------------------------------------- engine */
var ClaudeAE = (function () {
    var VERSION = "1.0.0";
    var H = {};                 // command handlers
    var NO_UNDO = {};           // handlers that must not open an undo group
    var warnings = [];
    var caches = {};

    /* ===================================================== private JSON
     * Never use the global JSON object: every CEP panel shares this ExtendScript engine and some
     * third-party extensions replace JSON with broken versions or add enumerable properties to
     * Array.prototype. Seen in the wild: JSON.stringify({a:1}) === "{: }". */
    var JESC = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    // line/paragraph separators are built at runtime: as raw characters they would end the source line in ES3
    var LSEP = String.fromCharCode(0x2028), PSEP = String.fromCharCode(0x2029);
    var JSON_ESC_RE = new RegExp("[\\\\\"\\x00-\\x1f\\x7f-\\x9f" + LSEP + PSEP + "]", "g");
    function jq(str) {
        return '"' + String(str).replace(JSON_ESC_RE, function (c) {
            return JESC[c] || "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function jsonStringify(v, depth) {
        depth = depth || 0;
        if (depth > 256) throw new Error("Value is nested too deeply to serialise");
        if (v === null || v === undefined) return "null";
        var t = typeof v, i, out, x;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return jq(v);
        if (t === "function") return "null";
        if (Object.prototype.toString.call(v) === "[object Array]") {
            out = [];
            for (i = 0; i < v.length; i++) { x = v[i]; out.push(x === undefined || typeof x === "function" ? "null" : jsonStringify(x, depth + 1)); }
            return "[" + out.join(",") + "]";
        }
        out = [];
        for (i in v) {
            if (!Object.prototype.hasOwnProperty.call(v, i)) continue;
            x = v[i];
            if (x === undefined || typeof x === "function") continue;
            out.push(jq(i) + ":" + jsonStringify(x, depth + 1));
        }
        return "{" + out.join(",") + "}";
    }
    function jsonParse(text) {
        var src = String(text);
        // json2-style check that the text is pure JSON before evaluating it as a literal
        var probe = src.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
            .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
            .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
        if (!/^[\],:{}\s]*$/.test(probe)) throw new SyntaxError("Invalid JSON");
        // raw U+2028/U+2029 are legal in JSON strings but are line terminators in ES3 source
        src = src.split(LSEP).join("\\u2028").split(PSEP).join("\\u2029");
        return eval("(" + src + ")");
    }

    /* ============================================================ utils */
    function warn(msg) { warnings.push(String(msg)); }
    function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
    function isObj(v) { return v !== null && typeof v === "object" && !isArr(v); }
    function has(o, k) { return o !== null && o !== undefined && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
    function def(v, d) { return (v === undefined || v === null) ? d : v; }
    function keys(o) { var r = [], k; for (k in o) if (has(o, k)) r.push(k); return r; }
    function idxOf(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return i; return -1; }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function norm(s) { return String(s).toLowerCase().replace(/[\s_\-\.]/g, ""); }
    function r4(n) { return typeof n === "number" ? Math.round(n * 10000) / 10000 : n; }
    function rArr(a) { if (!isArr(a)) return r4(a); var o = []; for (var i = 0; i < a.length; i++) o.push(isArr(a[i]) ? rArr(a[i]) : r4(a[i])); return o; }
    function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; return undefined; }
    function pick(o, names) { for (var i = 0; i < names.length; i++) if (has(o, names[i])) return o[names[i]]; return undefined; }
    function hasAny(o, names) { for (var i = 0; i < names.length; i++) if (has(o, names[i])) return true; return false; }
    function fail(msg) { throw new Error(msg); }

    /* ====================================================== time / color */
    function parseTime(v, fps) {
        if (v === undefined || v === null || v === "") return undefined;
        if (typeof v === "number") return v;
        if (isObj(v)) {
            if (has(v, "frames")) return Number(v.frames) / fps;
            if (has(v, "seconds")) return Number(v.seconds);
        }
        var s = String(v).replace(/^\s+|\s+$/g, ""), m;
        if ((m = s.match(/^(-?[\d.]+)\s*(f|fr|frame|frames)$/i))) return parseFloat(m[1]) / fps;
        if ((m = s.match(/^(-?[\d.]+)\s*ms$/i))) return parseFloat(m[1]) / 1000;
        if ((m = s.match(/^(-?[\d.]+)\s*(s|sec|secs|second|seconds)$/i))) return parseFloat(m[1]);
        if (s.indexOf(":") >= 0 || s.indexOf(";") >= 0) {
            var p = s.split(/[:;]/), n = [];
            for (var i = 0; i < p.length; i++) n.push(parseFloat(p[i]));
            if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / fps;      // hh:mm:ss:ff
            if (n.length === 3) return n[0] * 60 + n[1] + n[2] / fps;                    // mm:ss:ff
            if (n.length === 2) return n[0] * 60 + n[1];                                 // mm:ss(.sss)
        }
        var f = parseFloat(s);
        if (!isNaN(f) && /^-?[\d.]+$/.test(s)) return f;
        fail("Invalid time value: " + v + " (use seconds, \"24f\", \"1.5s\", \"500ms\" or \"00:00:01:12\")");
    }

    var NAMED_COLORS = {
        white: "ffffff", black: "000000", red: "ff0000", green: "008000", lime: "00ff00", blue: "0000ff",
        yellow: "ffff00", cyan: "00ffff", magenta: "ff00ff", orange: "ffa500", purple: "800080",
        gray: "808080", grey: "808080", pink: "ffc0cb", transparent: "00000000"
    };
    function parseColor(v) {
        if (v === undefined || v === null) return null;
        var a, i;
        if (isArr(v)) {
            a = [Number(v[0]), Number(v[1]), Number(v[2]), v.length > 3 ? Number(v[3]) : 1];
            var big = a[0] > 1 || a[1] > 1 || a[2] > 1;
            if (big) { for (i = 0; i < 3; i++) a[i] = a[i] / 255; if (a[3] > 1) a[3] = a[3] / 255; }
            return a;
        }
        if (isObj(v) && has(v, "r")) return parseColor([v.r, v.g, v.b, def(v.a, 1)]);
        var s = String(v).replace(/\s/g, "").toLowerCase(), m;
        if (has(NAMED_COLORS, s)) s = "#" + NAMED_COLORS[s];
        if ((m = s.match(/^rgba?\(([^)]+)\)$/))) {
            var parts = m[1].split(",");
            a = [];
            for (i = 0; i < 3; i++) a.push(parts[i].indexOf("%") > 0 ? parseFloat(parts[i]) / 100 : parseFloat(parts[i]) / 255);
            a.push(parts.length > 3 ? parseFloat(parts[3]) : 1);
            return a;
        }
        if (s.charAt(0) === "#") s = s.substr(1);
        if (/^[0-9a-f]{3,4}$/.test(s)) { var e = ""; for (i = 0; i < s.length; i++) e += s.charAt(i) + s.charAt(i); s = e; }
        if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) {
            a = [parseInt(s.substr(0, 2), 16) / 255, parseInt(s.substr(2, 2), 16) / 255, parseInt(s.substr(4, 2), 16) / 255, 1];
            if (s.length === 8) a[3] = parseInt(s.substr(6, 2), 16) / 255;
            return a;
        }
        fail("Invalid color: " + v + " (use \"#rrggbb\", \"rgb(r,g,b)\" or [r,g,b] with 0-1 values)");
    }
    function toHex(c) {
        if (!isArr(c)) return c;
        var s = "#";
        for (var i = 0; i < 3; i++) { var h = Math.round(clamp(c[i], 0, 1) * 255).toString(16); s += h.length < 2 ? "0" + h : h; }
        return s;
    }
    function rgb3(v) { var c = parseColor(v); return [c[0], c[1], c[2]]; }

    /* ========================================================= lookups */
    function itemType(it) {
        if (it instanceof CompItem) return "comp";
        if (it instanceof FolderItem) return "folder";
        if (it instanceof FootageItem) {
            var ms = it.mainSource;
            if (ms instanceof SolidSource) return "solid";
            if (ms instanceof PlaceholderSource) return "placeholder";
            if (ms instanceof FileSource) {
                if (it.hasVideo === false && it.hasAudio) return "audio";
                return ms.isStill ? "image" : "video";
            }
            return "footage";
        }
        return "item";
    }

    function findItem(ref, wantType) {
        if (ref === undefined || ref === null) return null;
        var proj = app.project, i, it;
        if (isObj(ref)) ref = first(ref.id, ref.name);
        if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
            it = null;
            try { it = proj.itemByID(Number(ref)); } catch (e) { it = null; }
            if (it && (!wantType || itemType(it) === wantType)) return it;
        }
        var name = String(ref);
        for (i = 1; i <= proj.numItems; i++) {
            it = proj.item(i);
            if (it.name === name && (!wantType || itemType(it) === wantType)) return it;
        }
        for (i = 1; i <= proj.numItems; i++) {
            it = proj.item(i);
            if (norm(it.name) === norm(name) && (!wantType || itemType(it) === wantType)) return it;
        }
        return null;
    }

    function findComp(ref, quiet) {
        var c;
        if (ref === undefined || ref === null || ref === "" || ref === "active") {
            c = app.project.activeItem;
            if (c instanceof CompItem) return c;
            // fall back to the comp that has a layer selected / the most recent viewer
            if (quiet) return null;
            fail("No active composition. Open a comp in After Effects or pass \"comp\" (name or id).");
        }
        c = findItem(ref, "comp");
        if (!c) { if (quiet) return null; fail("Composition not found: " + ref); }
        return c;
    }

    function findLayer(comp, ref, quiet) {
        var i, l;
        if (ref === undefined || ref === null) { if (quiet) return null; fail("Missing layer reference"); }
        if (isObj(ref)) {
            if (has(ref, "id")) ref = { _id: ref.id };
            else if (has(ref, "index")) ref = Number(ref.index);
            else if (has(ref, "name")) ref = String(ref.name);
        }
        if (isObj(ref) && has(ref, "_id")) {
            for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i).id === Number(ref._id)) return comp.layer(i);
            if (quiet) return null; fail("Layer id not found: " + ref._id);
        }
        if (typeof ref === "number") {
            if (ref >= 1 && ref <= comp.numLayers) return comp.layer(ref);
            if (quiet) return null; fail("Layer index out of range: " + ref + " (comp has " + comp.numLayers + " layers)");
        }
        var s = String(ref);
        if (/^#\d+$/.test(s)) return findLayer(comp, Number(s.substr(1)), quiet);
        if (/^id:\d+$/.test(s)) return findLayer(comp, { id: Number(s.substr(3)) }, quiet);
        for (i = 1; i <= comp.numLayers; i++) { l = comp.layer(i); if (l.name === s) return l; }
        for (i = 1; i <= comp.numLayers; i++) { l = comp.layer(i); if (norm(l.name) === norm(s)) return l; }
        if (/^\d+$/.test(s)) return findLayer(comp, Number(s), quiet);
        if (quiet) return null;
        fail("Layer not found: " + s + " in comp \"" + comp.name + "\"");
    }

    function layerType(l) {
        if (l instanceof TextLayer) return "text";
        if (l instanceof ShapeLayer) return "shape";
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l.nullLayer) return "null";
        if (l.adjustmentLayer) return "adjustment";
        var src = l.source;
        if (src instanceof CompItem) return "precomp";
        if (src) {
            var t = itemType(src);
            if (t === "video" && !l.hasVideo && l.hasAudio) return "audio";
            return t;
        }
        return "layer";
    }

    /* ---------- property paths */
    var LAYER_ALIASES = {
        anchorpoint: ["ADBE Transform Group", "ADBE Anchor Point"], anchor: ["ADBE Transform Group", "ADBE Anchor Point"],
        pointofinterest: ["ADBE Transform Group", "ADBE Anchor Point"],
        position: ["ADBE Transform Group", "ADBE Position"],
        positionx: ["ADBE Transform Group", "ADBE Position_0"], x: ["ADBE Transform Group", "ADBE Position_0"], xposition: ["ADBE Transform Group", "ADBE Position_0"],
        positiony: ["ADBE Transform Group", "ADBE Position_1"], y: ["ADBE Transform Group", "ADBE Position_1"], yposition: ["ADBE Transform Group", "ADBE Position_1"],
        positionz: ["ADBE Transform Group", "ADBE Position_2"], z: ["ADBE Transform Group", "ADBE Position_2"], zposition: ["ADBE Transform Group", "ADBE Position_2"],
        scale: ["ADBE Transform Group", "ADBE Scale"],
        rotation: ["ADBE Transform Group", "ADBE Rotate Z"], rotationz: ["ADBE Transform Group", "ADBE Rotate Z"], zrotation: ["ADBE Transform Group", "ADBE Rotate Z"],
        rotationx: ["ADBE Transform Group", "ADBE Rotate X"], xrotation: ["ADBE Transform Group", "ADBE Rotate X"],
        rotationy: ["ADBE Transform Group", "ADBE Rotate Y"], yrotation: ["ADBE Transform Group", "ADBE Rotate Y"],
        orientation: ["ADBE Transform Group", "ADBE Orientation"],
        opacity: ["ADBE Transform Group", "ADBE Opacity"],
        sourcetext: ["ADBE Text Properties", "ADBE Text Document"],
        timeremap: ["ADBE Time Remapping"],
        audiolevels: ["ADBE Audio Group", "ADBE Audio Levels"],
        zoom: ["ADBE Camera Options Group", "ADBE Camera Zoom"],
        depthoffield: ["ADBE Camera Options Group", "ADBE Camera Depth of Field"],
        focusdistance: ["ADBE Camera Options Group", "ADBE Camera Focus Distance"],
        aperture: ["ADBE Camera Options Group", "ADBE Camera Aperture"],
        blurlevel: ["ADBE Camera Options Group", "ADBE Camera Blur Level"],
        intensity: ["ADBE Light Options Group", "ADBE Light Intensity"],
        lightcolor: ["ADBE Light Options Group", "ADBE Light Color"],
        coneangle: ["ADBE Light Options Group", "ADBE Light Cone Angle"],
        conefeather: ["ADBE Light Options Group", "ADBE Light Cone Feather 2"],
        castsshadows: ["ADBE Light Options Group", "ADBE Casts Shadows"],
        shadowdarkness: ["ADBE Light Options Group", "ADBE Light Shadow Darkness"],
        shadowdiffusion: ["ADBE Light Options Group", "ADBE Light Shadow Diffusion"]
    };
    var GROUP_ALIASES = {
        transform: "ADBE Transform Group", effects: "ADBE Effect Parade", effect: "ADBE Effect Parade",
        masks: "ADBE Mask Parade", mask: "ADBE Mask Parade", contents: "ADBE Root Vectors Group",
        text: "ADBE Text Properties", materialoptions: "ADBE Material Options Group",
        layerstyles: "ADBE Layer Styles", audio: "ADBE Audio Group", markers: "ADBE Marker", marker: "ADBE Marker",
        cameraoptions: "ADBE Camera Options Group", lightoptions: "ADBE Light Options Group",
        animators: "ADBE Text Animators", geometryoptions: "ADBE Plane Options Group"
    };

    function childProp(group, key) {
        if (!group || group.numProperties === undefined) return null;
        var p = null, i, q;
        if (typeof key === "number") { return (key >= 1 && key <= group.numProperties) ? group.property(key) : null; }
        var s = String(key);
        if (/^#\d+$/.test(s)) { i = Number(s.substr(1)); return (i >= 1 && i <= group.numProperties) ? group.property(i) : null; }
        try { p = group.property(s); } catch (e) { p = null; }
        if (p) return p;
        var n = norm(s);
        if (group.propertyDepth === 0 || group.propertyDepth === undefined) {
            if (has(GROUP_ALIASES, n)) { try { p = group.property(GROUP_ALIASES[n]); } catch (e2) { p = null; } if (p) return p; }
        }
        for (i = 1; i <= group.numProperties; i++) {
            q = group.property(i);
            if (norm(q.name) === n || norm(q.matchName) === n) return q;
        }
        return null;
    }

    function splitPath(path) {
        if (isArr(path)) return path;
        return String(path).split("/");
    }

    function resolveProp(layer, path) {
        var segs = splitPath(path), p, i;
        if (segs.length === 1 && typeof segs[0] === "string" && has(LAYER_ALIASES, norm(segs[0]))) segs = LAYER_ALIASES[norm(segs[0])];
        p = layer;
        for (i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var next = childProp(p, seg);
            if (!next && i === 0 && has(LAYER_ALIASES, norm(seg))) {
                var al = LAYER_ALIASES[norm(seg)], tmp = layer;
                for (var j = 0; j < al.length && tmp; j++) tmp = childProp(tmp, al[j]);
                next = tmp;
            }
            if (!next && p.propertyType === PropertyType.NAMED_GROUP && norm(p.matchName) === norm("ADBE Transform Group") && has(LAYER_ALIASES, norm(seg))) {
                next = childProp(p, LAYER_ALIASES[norm(seg)][1]);
            }
            if (!next) fail("Property not found: \"" + seg + "\" in path \"" + segs.join("/") + "\" on layer \"" + layer.name + "\"" + childHint(p));
            p = next;
        }
        return p;
    }
    function childHint(g) {
        try {
            if (!g || !g.numProperties) return "";
            var n = [];
            for (var i = 1; i <= Math.min(g.numProperties, 30); i++) n.push(g.property(i).name);
            return ". Available: " + n.join(", ");
        } catch (e) { return ""; }
    }

    // Path of indices from the layer root — survives the reference invalidation that
    // happens whenever AE adds a property to a group.
    function propPath(p) {
        var path = [];
        while (p && p.propertyDepth > 0) { path.unshift(p.propertyIndex); p = p.parentProperty; }
        return path;
    }
    function byPath(layer, path) { var p = layer; for (var i = 0; i < path.length; i++) p = p.property(path[i]); return p; }
    function displayPath(p) {
        var path = [];
        while (p && p.propertyDepth > 0) { path.unshift(p.name); p = p.parentProperty; }
        return path.join("/");
    }

    /* ============================================== value conversion */
    var PVT = PropertyValueType;
    function easeDims(prop) {
        var t = prop.propertyValueType;
        if (t === PVT.ThreeD) return 3;
        if (t === PVT.TwoD) return 2;
        return 1;
    }
    function isSpatial(prop) {
        var t = prop.propertyValueType;
        return t === PVT.TwoD_SPATIAL || t === PVT.ThreeD_SPATIAL;
    }

    function makeShape(v) {
        if (v instanceof Shape) return v;
        if (!isObj(v)) fail("Path value must be an object with \"vertices\"");
        var verts = first(v.vertices, v.v, v.points);
        if (!isArr(verts) || verts.length < 1) fail("Path needs a \"vertices\" array of [x,y] points");
        var n = verts.length, i, zero = [];
        for (i = 0; i < n; i++) zero.push([0, 0]);
        var s = new Shape();
        s.vertices = verts;
        s.inTangents = first(v.inTangents, v.i, zero);
        s.outTangents = first(v.outTangents, v.o, zero);
        if (s.inTangents.length !== n || s.outTangents.length !== n) fail("Path inTangents/outTangents must have the same length as vertices");
        s.closed = def(first(v.closed, v.c), true) ? true : false;
        return s;
    }

    function toPropValue(prop, v, ctx) {
        var t = prop.propertyValueType, i;
        if (t === PVT.COLOR) return parseColor(v);
        if (t === PVT.TEXT_DOCUMENT) return buildTextDocument(prop.value, isObj(v) ? v : { text: v }, ctx);
        if (t === PVT.SHAPE) return makeShape(v);
        if (t === PVT.LAYER_INDEX) {
            if (v === 0 || v === null || v === "none") return 0;
            var l = resolveLayerRef(v, ctx);
            return l.index;
        }
        if (t === PVT.MASK_INDEX) return Number(v);
        if (t === PVT.NO_VALUE || t === PVT.CUSTOM_VALUE) fail("Property \"" + prop.name + "\" cannot be set by scripting");
        if (t === PVT.OneD) {
            if (typeof v === "boolean") return v ? 1 : 0;
            if (isArr(v)) return Number(v[0]);
            if (typeof v === "string" && isNaN(Number(v))) {
                if (prop.isDropdownEffect) return dropdownIndex(prop, v);
                fail("Expected a number for \"" + prop.name + "\" but got \"" + v + "\"");
            }
            return Number(v);
        }
        // multi-dimensional
        var cur = prop.value, n = cur.length, out = [];
        if (typeof v === "number") { for (i = 0; i < n; i++) out.push(v); return out; }
        if (!isArr(v)) fail("Expected an array for \"" + prop.name + "\" but got " + v);
        for (i = 0; i < n; i++) {
            if (i < v.length) out.push(Number(v[i]));
            else if (t === PVT.ThreeD && norm(prop.matchName).indexOf("scale") >= 0 && v.length === 1) out.push(Number(v[0]));
            else out.push(cur[i]);
        }
        return out;
    }
    function dropdownIndex(prop, label) {
        try {
            var items = prop.propertyParameters;
            for (var i = 0; i < items.length; i++) if (norm(items[i]) === norm(label)) return i + 1;
        } catch (e) { }
        fail("Unknown option \"" + label + "\" for dropdown \"" + prop.name + "\"");
    }

    /* =============================================== easing / keyframes */
    var EASES = {
        linear: "linear", hold: "hold", step: "hold",
        ease: [0.25, 0.1, 0.25, 1], easein: [0.42, 0, 1, 1], easeout: [0, 0, 0.58, 1], easeinout: [0.42, 0, 0.58, 1],
        easyease: [0.333, 0, 0.667, 1], easyeasein: [0.333, 0, 0.667, 1], easyeaseout: [0.333, 0, 0.667, 1], smooth: [0.333, 0, 0.667, 1],
        easeinsine: [0.12, 0, 0.39, 0], easeoutsine: [0.61, 1, 0.88, 1], easeinoutsine: [0.37, 0, 0.63, 1],
        easeinquad: [0.11, 0, 0.5, 0], easeoutquad: [0.5, 1, 0.89, 1], easeinoutquad: [0.45, 0, 0.55, 1],
        easeincubic: [0.32, 0, 0.67, 0], easeoutcubic: [0.33, 1, 0.68, 1], easeinoutcubic: [0.65, 0, 0.35, 1],
        easeinquart: [0.5, 0, 0.75, 0], easeoutquart: [0.25, 1, 0.5, 1], easeinoutquart: [0.76, 0, 0.24, 1],
        easeinquint: [0.64, 0, 0.78, 0], easeoutquint: [0.22, 1, 0.36, 1], easeinoutquint: [0.83, 0, 0.17, 1],
        easeinexpo: [0.7, 0, 0.84, 0], easeoutexpo: [0.16, 1, 0.3, 1], easeinoutexpo: [0.87, 0, 0.13, 1],
        easeincirc: [0.55, 0, 1, 0.45], easeoutcirc: [0, 0.55, 0.45, 1], easeinoutcirc: [0.85, 0, 0.15, 1],
        easeinback: [0.36, 0, 0.66, -0.56], easeoutback: [0.34, 1.56, 0.64, 1], easeinoutback: [0.68, -0.6, 0.32, 1.6],
        // GSAP-style aliases
        power1in: [0.11, 0, 0.5, 0], power1out: [0.5, 1, 0.89, 1], power1inout: [0.45, 0, 0.55, 1],
        power2in: [0.32, 0, 0.67, 0], power2out: [0.33, 1, 0.68, 1], power2inout: [0.65, 0, 0.35, 1],
        power3in: [0.5, 0, 0.75, 0], power3out: [0.25, 1, 0.5, 1], power3inout: [0.76, 0, 0.24, 1],
        power4in: [0.64, 0, 0.78, 0], power4out: [0.22, 1, 0.36, 1], power4inout: [0.83, 0, 0.17, 1],
        expoin: [0.7, 0, 0.84, 0], expoout: [0.16, 1, 0.3, 1], expoinout: [0.87, 0, 0.13, 1],
        backout: [0.34, 1.56, 0.64, 1], backin: [0.36, 0, 0.66, -0.56], backinout: [0.68, -0.6, 0.32, 1.6],
        sinein: [0.12, 0, 0.39, 0], sineout: [0.61, 1, 0.88, 1], sineinout: [0.37, 0, 0.63, 1],
        circin: [0.55, 0, 1, 0.45], circout: [0, 0.55, 0.45, 1], circinout: [0.85, 0, 0.15, 1]
    };
    function parseEase(e) {
        if (e === undefined || e === null) return "linear";
        if (isArr(e)) { if (e.length !== 4) fail("Cubic-bezier ease needs 4 numbers"); return [Number(e[0]), Number(e[1]), Number(e[2]), Number(e[3])]; }
        if (isObj(e)) return e; // explicit {in:{speed,influence}, out:{...}} handled by caller
        var s = String(e), m = s.match(/cubic-bezier\(([^)]+)\)/i);
        if (m) { var p = m[1].split(","); return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]; }
        var n = norm(s);
        if (has(EASES, n)) return EASES[n];
        if (n === "none" || n === "power0" || n === "power0none") return "linear";
        warn("Unknown ease \"" + e + "\" — using linear");
        return "linear";
    }

    function removeAllKeys(prop) { while (prop.numKeys > 0) prop.removeKey(prop.numKeys); }

    function isKeyframeArray(spec) {
        return isArr(spec) && spec.length > 0 && isObj(spec[0]) && hasAny(spec[0], ["t", "time", "frame"]);
    }
    function isAnimSpec(spec) {
        return isObj(spec) && hasAny(spec, ["keyframes", "expression", "value"]) &&
            !hasAny(spec, ["vertices", "v", "font", "content"]);
    }

    function keyTime(k, ctx) {
        if (has(k, "frame")) return Number(k.frame) / ctx.fps + ctx.offset;
        var t = ctx.time(first(k.t, k.time));
        if (t === undefined) fail("Keyframe is missing \"t\" (time)");
        return t;
    }

    function setKeyframes(prop, list, ctx, opts) {
        opts = opts || {};
        if (!prop.canVaryOverTime) fail("Property \"" + prop.name + "\" cannot be animated");
        var n = list.length, i, k, ks = [];
        for (i = 0; i < n; i++) {
            k = list[i];
            if (!isObj(k)) fail("Each keyframe must be an object like {\"t\":0,\"v\":100}");
            if (!hasAny(k, ["v", "value"])) fail("Keyframe at " + first(k.t, k.time) + " is missing \"v\" (value)");
            ks.push({ t: keyTime(k, ctx), raw: k, v: toPropValue(prop, has(k, "v") ? k.v : k.value, ctx) });
        }
        // stable sort by time
        for (i = 1; i < ks.length; i++) { var x = ks[i], j = i - 1; while (j >= 0 && ks[j].t > x.t) { ks[j + 1] = ks[j]; j--; } ks[j + 1] = x; }
        if (opts.replace !== false) removeAllKeys(prop);
        for (i = 0; i < ks.length; i++) prop.setValueAtTime(ks[i].t, ks[i].v);
        if (prop.propertyValueType === PVT.TEXT_DOCUMENT || prop.propertyValueType === PVT.MARKER) return;
        for (i = 0; i < ks.length; i++) ks[i].idx = prop.nearestKeyIndex(ks[i].t);
        for (i = 1; i < ks.length; i++) if (ks[i].idx === ks[i - 1].idx) warn("Two keyframes at the same time " + r4(ks[i].t) + "s on \"" + prop.name + "\" — the later one wins");
        var dims = easeDims(prop), spatial = isSpatial(prop), nk = ks.length;
        var L = KeyframeInterpolationType.LINEAR, B = KeyframeInterpolationType.BEZIER, HOLD = KeyframeInterpolationType.HOLD;

        // 1) spatial path: straight lines unless tangents are given
        if (spatial) {
            var zeroT = []; for (i = 0; i < prop.value.length; i++) zeroT.push(0);
            for (i = 0; i < nk; i++) {
                k = ks[i];
                try {
                    prop.setSpatialAutoBezierAtKey(k.idx, false);
                    prop.setSpatialContinuousAtKey(k.idx, false);
                    var tin = def(first(k.raw.spatialIn, k.raw.inTangent), zeroT), tout = def(first(k.raw.spatialOut, k.raw.outTangent), zeroT);
                    prop.setSpatialTangentsAtKey(k.idx, padArr(tin, zeroT.length), padArr(tout, zeroT.length));
                } catch (e1) { }
            }
        }
        if (nk < 1) return;
        // 2) everything linear first, so AE reports the average segment speed for us
        for (i = 0; i < nk; i++) prop.setInterpolationTypeAtKey(ks[i].idx, L, L);
        if (nk < 2 && !hasAny(ks[0].raw, ["easeIn", "easeOut", "interpolation"])) return;
        // 3) segments
        var segs = [];
        for (i = 0; i < nk - 1; i++) {
            k = ks[i];
            var e = first(k.raw.ease, k.raw.easing, k.raw.e, ctx.defaultEase);
            if (k.raw.interpolation && norm(k.raw.interpolation) === "hold") e = "hold";
            if (k.raw.hold === true) e = "hold";
            var pe = parseEase(e), seg = { type: "linear" };
            if (pe === "hold") seg.type = "hold";
            else if (isArr(pe)) {
                seg.type = "bezier";
                var avg = prop.keyOutTemporalEase(k.idx), dt = ks[i + 1].t - k.t;
                var x1 = clamp(pe[0], 0, 1), y1 = pe[1], x2 = clamp(pe[2], 0, 1), y2 = pe[3];
                var inflOut = Math.max(x1, 0.001), inflIn = Math.max(1 - x2, 0.001);
                seg.out = []; seg["in"] = [];
                for (var d = 0; d < dims; d++) {
                    var s = avg[d] ? avg[d].speed : 0;
                    if (dt <= 0) s = 0;
                    var so = y1 * s / inflOut, si = (1 - y2) * s / inflIn;
                    if (spatial) { so = Math.max(0, so); si = Math.max(0, si); }
                    seg.out.push(new KeyframeEase(so, clamp(inflOut * 100, 0.1, 100)));
                    seg["in"].push(new KeyframeEase(si, clamp(inflIn * 100, 0.1, 100)));
                }
            }
            segs.push(seg);
        }
        // 4) apply per key
        for (i = 0; i < nk; i++) {
            k = ks[i];
            var inType = L, outType = L, inEase = null, outEase = null;
            if (i > 0) { var ps = segs[i - 1]; if (ps.type === "bezier") { inType = B; inEase = ps["in"]; } }
            if (i < nk - 1) { var ns = segs[i]; if (ns.type === "bezier") { outType = B; outEase = ns.out; } else if (ns.type === "hold") outType = HOLD; }
            if (k.raw.easeIn) { inType = B; inEase = explicitEase(k.raw.easeIn, dims); }
            if (k.raw.easeOut) { outType = B; outEase = explicitEase(k.raw.easeOut, dims); }
            if (i === nk - 1 && k.raw.hold === true) outType = HOLD;
            // Setting a temporal ease turns both sides into bezier, so the ease goes first and
            // the interpolation types (which keep the bezier side's ease) are applied after it.
            if (inEase || outEase) {
                var curIn = prop.keyInTemporalEase(k.idx), curOut = prop.keyOutTemporalEase(k.idx);
                prop.setTemporalEaseAtKey(k.idx, inEase || curIn, outEase || curOut);
            }
            prop.setInterpolationTypeAtKey(k.idx, inType, outType);
            if (k.raw.roving === true && spatial && i > 0 && i < nk - 1) { try { prop.setRovingAtKey(k.idx, true); } catch (e2) { } }
        }
    }
    function padArr(a, n) { var o = []; for (var i = 0; i < n; i++) o.push(i < a.length ? Number(a[i]) : 0); return o; }
    function explicitEase(e, dims) {
        var arr = [], i;
        if (isArr(e)) { for (i = 0; i < dims; i++) { var x = e[Math.min(i, e.length - 1)]; arr.push(new KeyframeEase(Number(def(x.speed, 0)), clamp(Number(def(x.influence, 33.333)), 0.1, 100))); } return arr; }
        for (i = 0; i < dims; i++) arr.push(new KeyframeEase(Number(def(e.speed, 0)), clamp(Number(def(e.influence, 33.333)), 0.1, 100)));
        return arr;
    }

    function setExpression(prop, expr) {
        if (!prop.canSetExpression) fail("Property \"" + prop.name + "\" does not accept expressions");
        if (expr === null || expr === "") { prop.expression = ""; return; }
        prop.expression = String(expr);
        prop.expressionEnabled = true;
        try { prop.valueAtTime(0, false); } catch (e) { }
        if (prop.expressionError) warn("Expression error on \"" + displayPath(prop) + "\": " + prop.expressionError);
    }

    /* Apply a value spec to a property:
       - plain value                      → static value (removes existing keys)
       - [{t,v,ease}, ...]                → keyframes
       - {keyframes:[...], expression}    → keyframes and/or expression
       - {value: x, expression: "..."}    → static + expression                  */
    function applyValue(prop, spec, ctx, opts) {
        opts = opts || {};
        if (!prop) fail("applyValue: property is missing");
        if (prop.propertyType !== PropertyType.PROPERTY) fail("\"" + prop.name + "\" is a property group, not a property — add a child name to the path");
        var kf = null, expr, hasVal = false, val;
        if (isKeyframeArray(spec)) kf = spec;
        else if (isAnimSpec(spec)) {
            if (has(spec, "keyframes")) kf = spec.keyframes;
            if (has(spec, "expression")) expr = spec.expression;
            if (has(spec, "value")) { hasVal = true; val = spec.value; }
            if (has(spec, "replace")) opts.replace = spec.replace;
        } else { hasVal = true; val = spec; }

        if (kf && kf.length) setKeyframes(prop, kf, ctx, opts);
        else if (hasVal) {
            var conv = toPropValue(prop, val, ctx);
            if (prop.numKeys > 0) {
                if (opts.replace === false) prop.setValueAtTime(ctx.comp ? ctx.comp.time : 0, conv);
                else { removeAllKeys(prop); prop.setValue(conv); }
            } else prop.setValue(conv);
        }
        if (expr !== undefined) setExpression(prop, expr);
    }

    /* ====================================================== layer refs */
    function resolveLayerRef(ref, ctx) {
        if (ref === undefined || ref === null) fail("Missing layer reference");
        if (ctx && ctx.ids && typeof ref === "string" && has(ctx.ids, ref)) return ctx.ids[ref];
        return findLayer(ctx.comp, ref);
    }

    /* ======================================================= transform */
    var TRANSFORM_KEYS = {
        anchorpoint: "ADBE Anchor Point", anchor: "ADBE Anchor Point", pointofinterest: "ADBE Anchor Point",
        position: "ADBE Position", positionx: "ADBE Position_0", x: "ADBE Position_0",
        positiony: "ADBE Position_1", y: "ADBE Position_1", positionz: "ADBE Position_2", z: "ADBE Position_2",
        scale: "ADBE Scale", rotation: "ADBE Rotate Z", rotationz: "ADBE Rotate Z", zrotation: "ADBE Rotate Z",
        rotationx: "ADBE Rotate X", xrotation: "ADBE Rotate X", rotationy: "ADBE Rotate Y", yrotation: "ADBE Rotate Y",
        orientation: "ADBE Orientation", opacity: "ADBE Opacity"
    };
    function applyTransform(layer, tf, ctx, opts) {
        if (!tf) return;
        var ks = keys(tf), i, sep = false;
        for (i = 0; i < ks.length; i++) { var n = norm(ks[i]); if (n === "positionx" || n === "positiony" || n === "positionz" || n === "x" || n === "y" || n === "z") sep = true; }
        var grp = layer.property("ADBE Transform Group");
        if (sep) {
            var pos = grp.property("ADBE Position");
            if (!pos.dimensionsSeparated) pos.dimensionsSeparated = true;
        } else if (has(tf, "position")) {
            var pos2 = layer.property("ADBE Transform Group").property("ADBE Position");
            if (pos2.dimensionsSeparated) pos2.dimensionsSeparated = false;
        }
        for (i = 0; i < ks.length; i++) {
            var key = ks[i], mn = TRANSFORM_KEYS[norm(key)];
            var prop = mn ? layer.property("ADBE Transform Group").property(mn) : childProp(layer.property("ADBE Transform Group"), key);
            if (!prop) { warn("Unknown transform property \"" + key + "\" on layer \"" + layer.name + "\""); continue; }
            try { applyValue(prop, tf[key], ctx, opts); }
            catch (e) { warn("Transform \"" + key + "\" on \"" + layer.name + "\": " + e.message); }
        }
    }

    /* ========================================================== shapes */
    var PRIMITIVES = { rect: 1, rectangle: 1, ellipse: 1, circle: 1, star: 1, polygon: 1, polystar: 1, path: 1 };
    var SHAPE_KEYS = {
        rect: { size: "ADBE Vector Rect Size", position: "ADBE Vector Rect Position", roundness: "ADBE Vector Rect Roundness", radius: "ADBE Vector Rect Roundness", cornerradius: "ADBE Vector Rect Roundness" },
        ellipse: { size: "ADBE Vector Ellipse Size", position: "ADBE Vector Ellipse Position" },
        star: {
            points: "ADBE Vector Star Points", position: "ADBE Vector Star Position", rotation: "ADBE Vector Star Rotation",
            innerradius: "ADBE Vector Star Inner Radius", outerradius: "ADBE Vector Star Outer Radius", radius: "ADBE Vector Star Outer Radius",
            innerroundness: "ADBE Vector Star Inner Roundess", outerroundness: "ADBE Vector Star Outer Roundess", roundness: "ADBE Vector Star Outer Roundess"
        },
        fill: { color: "ADBE Vector Fill Color", opacity: "ADBE Vector Fill Opacity" },
        stroke: { color: "ADBE Vector Stroke Color", width: "ADBE Vector Stroke Width", opacity: "ADBE Vector Stroke Opacity", miterlimit: "ADBE Vector Stroke Miter Limit" },
        gfill: { start: "ADBE Vector Grad Start Pt", end: "ADBE Vector Grad End Pt", opacity: "ADBE Vector Fill Opacity", highlightlength: "ADBE Vector Grad HiLite Length", highlightangle: "ADBE Vector Grad HiLite Angle" },
        gstroke: { start: "ADBE Vector Grad Start Pt", end: "ADBE Vector Grad End Pt", opacity: "ADBE Vector Stroke Opacity", width: "ADBE Vector Stroke Width" },
        trim: { start: "ADBE Vector Trim Start", end: "ADBE Vector Trim End", offset: "ADBE Vector Trim Offset" },
        repeater: { copies: "ADBE Vector Repeater Copies", offset: "ADBE Vector Repeater Offset" },
        repeaterxf: { anchorpoint: "ADBE Vector Repeater Anchor", anchor: "ADBE Vector Repeater Anchor", position: "ADBE Vector Repeater Position", scale: "ADBE Vector Repeater Scale", rotation: "ADBE Vector Repeater Rotation", startopacity: "ADBE Vector Repeater Opacity 1", endopacity: "ADBE Vector Repeater Opacity 2" },
        roundcorners: { radius: "ADBE Vector RoundCorner Radius" },
        offsetpaths: { amount: "ADBE Vector Offset Amount", copies: "ADBE Vector Offset Copies", copyoffset: "ADBE Vector Offset Copy Offset", miterlimit: "ADBE Vector Offset Miter Limit" },
        zigzag: { size: "ADBE Vector Zigzag Size", ridges: "ADBE Vector Zigzag Detail", detail: "ADBE Vector Zigzag Detail" },
        wigglepaths: { size: "ADBE Vector Roughen Size", detail: "ADBE Vector Roughen Detail", wigglespersecond: "ADBE Vector Temporal Freq", frequency: "ADBE Vector Temporal Freq", correlation: "ADBE Vector Correlation", temporalphase: "ADBE Vector Temporal Phase", spatialphase: "ADBE Vector Spatial Phase", seed: "ADBE Vector Random Seed", randomseed: "ADBE Vector Random Seed" },
        twist: { angle: "ADBE Vector Twist Angle", center: "ADBE Vector Twist Center" },
        puckerbloat: { amount: "ADBE Vector PuckerBloat Amount" },
        grouptf: { anchorpoint: "ADBE Vector Anchor", anchor: "ADBE Vector Anchor", position: "ADBE Vector Position", scale: "ADBE Vector Scale", skew: "ADBE Vector Skew", skewaxis: "ADBE Vector Skew Axis", rotation: "ADBE Vector Rotation", opacity: "ADBE Vector Group Opacity" }
    };
    var OPERATOR_MN = {
        fill: "ADBE Vector Graphic - Fill", stroke: "ADBE Vector Graphic - Stroke",
        gradientfill: "ADBE Vector Graphic - G-Fill", gradientstroke: "ADBE Vector Graphic - G-Stroke",
        trimpaths: "ADBE Vector Filter - Trim", trim: "ADBE Vector Filter - Trim",
        repeater: "ADBE Vector Filter - Repeater", roundcorners: "ADBE Vector Filter - RC",
        offsetpaths: "ADBE Vector Filter - Offset", offset: "ADBE Vector Filter - Offset",
        zigzag: "ADBE Vector Filter - Zigzag", wigglepaths: "ADBE Vector Filter - Roughen", roughen: "ADBE Vector Filter - Roughen",
        twist: "ADBE Vector Filter - Twist", puckerbloat: "ADBE Vector Filter - PB", pucker: "ADBE Vector Filter - PB",
        mergepaths: "ADBE Vector Filter - Merge", merge: "ADBE Vector Filter - Merge", wiggletransform: "ADBE Vector Filter - Wiggler"
    };
    var RESERVED_ITEM_KEYS = { id: 1, comment: 1, type: 1, name: 1, items: 1, shapes: 1, contents: 1, fill: 1, stroke: 1, transform: 1, trimpaths: 1, trim: 1, repeater: 1, roundcorners: 1, gradient: 1, path: 1, paths: 1, vertices: 1, intangents: 1, outtangents: 1, closed: 1, direction: 1, enabled: 1, blendmode: 1, strokebelowfill: 1, wigglepaths: 1, zigzag: 1, offsetpaths: 1, twist: 1, puckerbloat: 1, mergepaths: 1, kind: 1, startype: 1 };

    function setItemProps(item, spec, table, ctx, skip) {
        var ks = keys(spec), i;
        for (i = 0; i < ks.length; i++) {
            var key = ks[i], n = norm(key);
            if (skip && has(skip, n)) continue;
            var prop = null;
            if (table && has(table, n)) prop = item.property(table[n]);
            if (!prop) prop = childProp(item, key);
            if (!prop || prop.propertyType !== PropertyType.PROPERTY) {
                if (!(table && has(RESERVED_ITEM_KEYS, n))) warn("Unknown property \"" + key + "\" on shape item \"" + item.name + "\"");
                continue;
            }
            try { applyValue(prop, spec[key], ctx); } catch (e) { warn("\"" + key + "\" on \"" + item.name + "\": " + e.message); }
        }
    }

    function addShapeItems(layer, contPath, items, ctx) {
        if (!items) return;
        if (!isArr(items)) items = [items];
        for (var i = 0; i < items.length; i++) {
            try { addShapeItem(layer, contPath, items[i], ctx); }
            catch (e) { warn("Shape item " + (items[i] && items[i].name ? "\"" + items[i].name + "\"" : "#" + (i + 1)) + " on \"" + layer.name + "\": " + e.message); }
        }
    }

    function newGroup(layer, contPath, name) {
        var g = byPath(layer, contPath).addProperty("ADBE Vector Group");
        if (name) g.name = name;
        var gPath = propPath(g);
        var cPath = propPath(g.property("ADBE Vectors Group"));
        return { path: gPath, contents: cPath };
    }

    function wantsGroup(it) {
        return hasAny(it, ["fill", "stroke", "transform", "trimPaths", "trim", "repeater", "roundCorners", "gradient", "wigglePaths", "zigzag", "offsetPaths", "twist", "puckerBloat"]);
    }

    function addShapeItem(layer, contPath, it, ctx) {
        if (!isObj(it)) fail("Shape item must be an object");
        var t = norm(first(it.type, it.kind, "group"));
        if (t === "group") {
            var g = newGroup(layer, contPath, it.name);
            addShapeItems(layer, g.contents, first(it.items, it.shapes, it.contents, []), ctx);
            applyShapeTransform(layer, g.path, it.transform, ctx);
            if (it.blendMode) setShapeBlend(byPath(layer, g.path), it.blendMode);
            if (it.enabled === false) byPath(layer, g.path).enabled = false;
            return;
        }
        if (has(PRIMITIVES, t)) {
            if (wantsGroup(it)) {
                var g2 = newGroup(layer, contPath, it.name || defaultShapeName(t));
                addPrimitive(layer, g2.contents, it, t, ctx);
                addModifiers(layer, g2.contents, it, ctx);
                addPaint(layer, g2.contents, it, ctx);
                if (it.repeater) addOperator(layer, g2.contents, "repeater", it.repeater, ctx);
                applyShapeTransform(layer, g2.path, it.transform, ctx);
                if (it.enabled === false) byPath(layer, g2.path).enabled = false;
            } else addPrimitive(layer, contPath, it, t, ctx);
            return;
        }
        if (has(OPERATOR_MN, t)) { addOperator(layer, contPath, t, it, ctx); return; }
        fail("Unknown shape item type \"" + it.type + "\" (use group, rect, ellipse, star, polygon, path, fill, stroke, gradientFill, trimPaths, repeater, roundCorners, ...)");
    }
    function defaultShapeName(t) {
        var m = { rect: "Rectangle", rectangle: "Rectangle", ellipse: "Ellipse", circle: "Ellipse", star: "Star", polygon: "Polygon", polystar: "Polystar", path: "Path" };
        return m[t] || "Shape";
    }

    function addPrimitive(layer, cPath, it, t, ctx) {
        var p, i, skip = { type: 1, name: 1, kind: 1, fill: 1, stroke: 1, transform: 1, trimpaths: 1, trim: 1, repeater: 1, roundcorners: 1, gradient: 1, wigglepaths: 1, zigzag: 1, offsetpaths: 1, twist: 1, puckerbloat: 1, direction: 1, enabled: 1, blendmode: 1, strokebelowfill: 1, startype: 1 };
        if (t === "rect" || t === "rectangle") {
            p = byPath(layer, cPath).addProperty("ADBE Vector Shape - Rect");
            setItemProps(p, it, SHAPE_KEYS.rect, ctx, skip);
        } else if (t === "ellipse" || t === "circle") {
            p = byPath(layer, cPath).addProperty("ADBE Vector Shape - Ellipse");
            var spec = {}, k, ks = keys(it);
            for (i = 0; i < ks.length; i++) { k = ks[i]; spec[k] = it[k]; }
            if (has(spec, "radius") && !has(spec, "size")) { var r = spec.radius; spec.size = typeof r === "number" ? [r * 2, r * 2] : r; delete spec.radius; }
            setItemProps(p, spec, SHAPE_KEYS.ellipse, ctx, skip);
        } else if (t === "star" || t === "polygon" || t === "polystar") {
            p = byPath(layer, cPath).addProperty("ADBE Vector Shape - Star");
            var isPoly = t === "polygon" || norm(def(it.starType, "")) === "polygon";
            p.property("ADBE Vector Star Type").setValue(isPoly ? 2 : 1);
            p = byPath(layer, propPath(p));
            setItemProps(p, it, SHAPE_KEYS.star, ctx, skip);
        } else if (t === "path") {
            var paths = it.paths;
            if (!paths) paths = [has(it, "path") ? it.path : it];
            for (i = 0; i < paths.length; i++) {
                var sp = byPath(layer, cPath).addProperty("ADBE Vector Shape - Group");
                if (it.name && paths.length > 1) sp.name = it.name + " " + (i + 1);
                var pathProp = sp.property("ADBE Vector Shape");
                var pv = paths[i];
                if (isObj(pv) && (has(pv, "d") || has(pv, "svgPath"))) fail("SVG path data must be converted before reaching After Effects (send it through the ClaudeAE bridge)");
                applyValue(pathProp, isObj(pv) && hasAny(pv, ["keyframes", "expression"]) ? pv : { value: pv }, ctx);
                p = byPath(layer, propPath(sp));
            }
        }
        if (p && it.direction) {
            try { var dir = byPath(layer, propPath(p)).property("ADBE Vector Shape Direction"); dir.setValue(norm(it.direction) === "reversed" || it.direction === 3 ? 3 : 2); } catch (e) { }
        }
    }

    function addModifiers(layer, cPath, it, ctx) {
        if (it.roundCorners !== undefined) addOperator(layer, cPath, "roundcorners", typeof it.roundCorners === "number" ? { radius: it.roundCorners } : it.roundCorners, ctx);
        if (it.offsetPaths !== undefined) addOperator(layer, cPath, "offsetpaths", typeof it.offsetPaths === "number" ? { amount: it.offsetPaths } : it.offsetPaths, ctx);
        if (it.puckerBloat !== undefined) addOperator(layer, cPath, "puckerbloat", typeof it.puckerBloat === "number" ? { amount: it.puckerBloat } : it.puckerBloat, ctx);
        if (it.twist !== undefined) addOperator(layer, cPath, "twist", typeof it.twist === "number" ? { angle: it.twist } : it.twist, ctx);
        if (it.zigzag !== undefined) addOperator(layer, cPath, "zigzag", it.zigzag, ctx);
        if (it.wigglePaths !== undefined) addOperator(layer, cPath, "wigglepaths", it.wigglePaths, ctx);
        var trim = first(it.trimPaths, it.trim);
        if (trim !== undefined) addOperator(layer, cPath, "trimpaths", trim, ctx);
    }

    function addPaint(layer, cPath, it, ctx) {
        var fill = it.fill, stroke = it.stroke, grad = it.gradient;
        var fillFirst = it.strokeBelowFill === true;
        function doFill() {
            if (grad) addOperator(layer, cPath, "gradientfill", grad, ctx);
            if (fill !== undefined && fill !== null && fill !== false && fill !== "none") {
                if (isObj(fill) && fill.gradient) addOperator(layer, cPath, "gradientfill", fill.gradient, ctx);
                else addOperator(layer, cPath, "fill", fill, ctx);
            }
        }
        function doStroke() {
            if (stroke !== undefined && stroke !== null && stroke !== false && stroke !== "none") {
                if (isObj(stroke) && stroke.gradient) {
                    var gs = {}, ks = keys(stroke.gradient), i;
                    for (i = 0; i < ks.length; i++) gs[ks[i]] = stroke.gradient[ks[i]];
                    if (has(stroke, "width")) gs.width = stroke.width;
                    addOperator(layer, cPath, "gradientstroke", gs, ctx);
                } else addOperator(layer, cPath, "stroke", stroke, ctx);
            }
        }
        // AE draws items listed first on top: stroke above fill unless asked otherwise.
        if (fillFirst) { doFill(); doStroke(); } else { doStroke(); doFill(); }
    }

    var CAPS = { butt: 1, round: 2, square: 3, projecting: 3 };
    var JOINS = { miter: 1, round: 2, bevel: 3 };
    function addOperator(layer, cPath, t, spec, ctx) {
        t = norm(t);
        var mn = OPERATOR_MN[t];
        if (!mn) fail("Unknown shape operator " + t);
        if (!isObj(spec)) {
            if (t === "fill" || t === "stroke") spec = { color: spec };
            else if (spec === true) spec = {};
            else fail(t + " needs an object");
        }
        var op = byPath(layer, cPath).addProperty(mn), opPath = propPath(op), i;
        if (spec.name) op.name = spec.name;
        var skip = { type: 1, name: 1, kind: 1, linecap: 1, cap: 1, linejoin: 1, join: 1, dashes: 1, dash: 1, dashoffset: 1, rule: 1, fillrule: 1, transform: 1, composite: 1, mode: 1, colors: 1, gradienttype: 1, blendmode: 1, enabled: 1, multiple: 1, trimmultiple: 1 };
        if (t === "fill") {
            setItemProps(op, spec, SHAPE_KEYS.fill, ctx, skip);
            if (spec.rule || spec.fillRule) byPath(layer, opPath).property("ADBE Vector Fill Rule").setValue(norm(first(spec.rule, spec.fillRule)) === "evenodd" ? 2 : 1);
        } else if (t === "stroke" || t === "gradientstroke") {
            setItemProps(op, spec, t === "stroke" ? SHAPE_KEYS.stroke : SHAPE_KEYS.gstroke, ctx, skip);
            op = byPath(layer, opPath);
            var cap = first(spec.lineCap, spec.cap), join = first(spec.lineJoin, spec.join);
            if (cap !== undefined) op.property("ADBE Vector Stroke Line Cap").setValue(typeof cap === "number" ? cap : def(CAPS[norm(cap)], 1));
            if (join !== undefined) op.property("ADBE Vector Stroke Line Join").setValue(typeof join === "number" ? join : def(JOINS[norm(join)], 1));
            var dashes = first(spec.dashes, spec.dash);
            if (dashes) {
                if (!isArr(dashes)) dashes = [dashes];
                var names = ["ADBE Vector Stroke Dash 1", "ADBE Vector Stroke Gap 1", "ADBE Vector Stroke Dash 2", "ADBE Vector Stroke Gap 2", "ADBE Vector Stroke Dash 3", "ADBE Vector Stroke Gap 3"];
                if (dashes.length === 1) dashes = [dashes[0], dashes[0]];
                for (i = 0; i < Math.min(dashes.length, 6); i++) {
                    var dg = byPath(layer, opPath).property("ADBE Vector Stroke Dashes");
                    var dp = dg.addProperty(names[i]);
                    applyValue(dp, dashes[i], ctx);
                }
                if (spec.dashOffset !== undefined) {
                    var og = byPath(layer, opPath).property("ADBE Vector Stroke Dashes");
                    applyValue(og.addProperty("ADBE Vector Stroke Offset"), spec.dashOffset, ctx);
                }
            }
            if (t === "gradientstroke") gradientSetup(layer, opPath, spec, ctx);
        } else if (t === "gradientfill") {
            setItemProps(op, spec, SHAPE_KEYS.gfill, ctx, skip);
            gradientSetup(layer, opPath, spec, ctx);
            if (spec.rule || spec.fillRule) byPath(layer, opPath).property("ADBE Vector Fill Rule").setValue(norm(first(spec.rule, spec.fillRule)) === "evenodd" ? 2 : 1);
        } else if (t === "trimpaths" || t === "trim") {
            if (typeof spec === "number") spec = { end: spec };
            setItemProps(op, spec, SHAPE_KEYS.trim, ctx, skip);
            var mult = first(spec.multiple, spec.trimMultiple);
            if (mult) byPath(layer, opPath).property("ADBE Vector Trim Type").setValue(norm(mult) === "individually" ? 2 : 1);
        } else if (t === "repeater") {
            setItemProps(op, spec, SHAPE_KEYS.repeater, ctx, skip);
            if (spec.composite) byPath(layer, opPath).property("ADBE Vector Repeater Order").setValue(norm(spec.composite) === "above" ? 2 : 1);
            if (spec.transform) setItemProps(byPath(layer, opPath).property("ADBE Vector Repeater Transform"), spec.transform, SHAPE_KEYS.repeaterxf, ctx);
        } else if (t === "mergepaths" || t === "merge") {
            var modes = { merge: 1, add: 2, subtract: 3, intersect: 4, exclude: 5, excludeintersections: 5 };
            var mode = def(spec.mode, "add");
            op.property("ADBE Vector Merge Type").setValue(typeof mode === "number" ? mode : def(modes[norm(mode)], 2));
        } else {
            var table = { roundcorners: SHAPE_KEYS.roundcorners, offsetpaths: SHAPE_KEYS.offsetpaths, offset: SHAPE_KEYS.offsetpaths, zigzag: SHAPE_KEYS.zigzag, wigglepaths: SHAPE_KEYS.wigglepaths, roughen: SHAPE_KEYS.wigglepaths, twist: SHAPE_KEYS.twist, puckerbloat: SHAPE_KEYS.puckerbloat, pucker: SHAPE_KEYS.puckerbloat }[t];
            setItemProps(op, spec, table, ctx, skip);
            if (t === "zigzag" && spec.points) byPath(layer, opPath).property("ADBE Vector Zigzag Points").setValue(norm(spec.points) === "smooth" ? 2 : 1);
        }
        if (spec.blendMode) setShapeBlend(byPath(layer, opPath), spec.blendMode);
        if (spec.enabled === false) byPath(layer, opPath).enabled = false;
    }

    // AE cannot set gradient colour stops from scripts, so two-colour gradients are
    // recreated with a white→black ramp remapped by a Tint effect on the layer.
    function gradientSetup(layer, opPath, spec, ctx) {
        var op = byPath(layer, opPath);
        var gtype = norm(def(first(spec.gradientType, spec.kind, spec.shape), "linear"));
        op.property("ADBE Vector Grad Type").setValue(gtype === "radial" ? 2 : 1);
        var colors = spec.colors;
        if (!colors || colors.length < 2) { warn("Gradient on \"" + layer.name + "\" needs a \"colors\" array of at least 2 colours"); return; }
        var c0 = colors[0], c1 = colors[colors.length - 1];
        if (isObj(c0)) c0 = c0.color; if (isObj(c1)) c1 = c1.color;
        if (colors.length > 2) warn("Gradient on \"" + layer.name + "\": After Effects scripting only supports 2 colour stops — using the first and last colour");
        ctx.gradients = ctx.gradients || {};
        var key = "L" + layer.id;
        if (ctx.gradients[key]) {
            if (ctx.gradients[key].from !== toHex(parseColor(c0)) || ctx.gradients[key].to !== toHex(parseColor(c1))) warn("Layer \"" + layer.name + "\" has several gradients with different colours; only one colour pair can be applied per layer (put each gradient on its own layer)");
            return;
        }
        ctx.gradients[key] = { from: toHex(parseColor(c0)), to: toHex(parseColor(c1)) };
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Tint");
        fx.name = "Gradient Colors";
        fx.property("ADBE Tint-0002").setValue(parseColor(c0)); // Map White To  → start colour
        fx = layer.property("ADBE Effect Parade").property(fx.propertyIndex);
        fx.property("ADBE Tint-0001").setValue(parseColor(c1)); // Map Black To  → end colour
    }

    function setShapeBlend(item, mode) {
        var p = item.property("ADBE Vector Blend Mode");
        if (!p) return;
        var list = ["normal", "", "darken", "multiply", "colorburn", "linearburn", "darkercolor", "", "lighten", "screen", "colordodge", "lineardodge", "lightercolor", "", "overlay", "softlight", "hardlight", "linearlight", "vividlight", "pinlight", "hardmix", "", "difference", "exclusion", "subtract", "divide", "", "hue", "saturation", "color", "luminosity"];
        var i = idxOf(list, norm(mode));
        if (i < 0) { warn("Unknown shape blend mode " + mode); return; }
        try { p.setValue(i + 1); } catch (e) { warn("Could not set shape blend mode " + mode); }
    }

    function applyShapeTransform(layer, gPath, tf, ctx) {
        if (!tf) return;
        var g = byPath(layer, gPath);
        setItemProps(g.property("ADBE Vector Transform Group"), tf, SHAPE_KEYS.grouptf, ctx);
    }

    /* ============================================================ text */
    function fontLookup(font, family, style) {
        // fonts installed while After Effects runs bump the font server revision → forget old lookups
        var rev = -1;
        try { rev = app.fonts.fontServerRevision; } catch (e) { }
        if (caches.fontRev !== rev) { caches.fontRev = rev; caches.fonts = {}; caches.families = {}; }
        caches.fonts = caches.fonts || {};
        var key = [font, family, style].join("|");
        if (has(caches.fonts, key)) return caches.fonts[key];
        var res = resolveFontUncached(font, family, style);
        caches.fonts[key] = res;
        return res;
    }
    function resolveFontUncached(font, family, style) {
        if (!app.fonts || typeof app.fonts.getFontsByPostScriptName !== "function") return font || null;
        var r, i;
        if (font) {
            r = app.fonts.getFontsByPostScriptName(font);
            if (r && r.length) return font;
            // "Inter Bold" / "Inter-Bold" / "Inter" given instead of a PostScript name
            var parts = String(font).replace(/-/g, " ").split(" ");
            if (!family) {
                for (i = parts.length - 1; i >= 1; i--) {
                    var fam = parts.slice(0, i).join(" "), sty = parts.slice(i).join(" ");
                    r = app.fonts.getFontsByFamilyNameAndStyleName(fam, sty);
                    if (r && r.length) return r[0].postScriptName;
                }
                family = font;
            }
        }
        if (family) {
            // 1) exact family + style
            if (style) {
                r = app.fonts.getFontsByFamilyNameAndStyleName(family, style);
                if (r && r.length) return r[0].postScriptName;
            }
            // 2) the family's styles, ignoring case/spaces and accepting common synonyms
            var grp = familyGroup(family), j, w;
            if (grp && style) {
                var wanted = styleKeys(style);
                for (w = 0; w < wanted.length; w++) for (j = 0; j < grp.length; j++) if (norm(grp[j].styleName) === wanted[w]) return grp[j].postScriptName;
            }
            // 3) the nearest installed weight of the family (e.g. Black → ExtraBold)
            if (grp && style) {
                var want = styleWeight(style), wantItalic = /italic|oblique/i.test(style), best = null, bestD = 1e9;
                for (j = 0; j < grp.length; j++) {
                    var sw = styleWeight(grp[j].styleName);
                    if (sw === null) continue;
                    var d = Math.abs(sw - want) + ((/italic|oblique/i.test(grp[j].styleName) === wantItalic) ? 0 : 1000);
                    if (d < bestD) { bestD = d; best = grp[j]; }
                }
                if (best && want !== null) {
                    if (norm(best.styleName) !== norm(style)) warn("Font style \"" + style + "\" of " + family + " is not installed — using " + best.styleName);
                    return best.postScriptName;
                }
            }
            // 4) a regular weight of the family
            var reg = ["Regular", "Book", "Roman", "Normal", "Medium"];
            for (i = 0; i < reg.length; i++) {
                r = app.fonts.getFontsByFamilyNameAndStyleName(family, reg[i]);
                if (r && r.length) { if (style) warn("Font style \"" + style + "\" of " + family + " is not installed — using " + reg[i]); return r[0].postScriptName; }
            }
            if (grp && grp.length) return grp[0].postScriptName;
        }
        return null;
    }
    // numeric weight of a style name ("SemiBold Italic" → 600), null when it names no weight
    function styleWeight(style) {
        var n = norm(style).replace(/italic|oblique/g, "");
        var table = [["thin", 100], ["hairline", 100], ["extralight", 200], ["ultralight", 200], ["light", 300], ["regular", 400], ["normal", 400], ["book", 400], ["roman", 400], ["", 400],
            ["medium", 500], ["semibold", 600], ["demibold", 600], ["extrabold", 800], ["ultrabold", 800], ["bold", 700], ["black", 900], ["heavy", 900], ["extrablack", 950]];
        for (var i = 0; i < table.length; i++) if (n === table[i][0]) return table[i][1];
        return null;
    }
    var STYLE_SYNONYMS = [["semibold", "demibold", "demi", "semi"], ["extrabold", "ultrabold", "heavy"], ["black", "heavy", "ultra", "extrablack"],
        ["extralight", "ultralight"], ["thin", "hairline"], ["regular", "normal", "book", "roman", "plain"], ["bold"], ["medium"], ["light"]];
    function styleKeys(style) {
        var n = norm(style), italic = /italic|oblique/.test(n), base = n.replace(/italic|oblique/g, ""), out = [n], g, k;
        if (!base) return italic ? ["italic", "oblique", "regularitalic"] : out;
        for (g = 0; g < STYLE_SYNONYMS.length; g++) {
            if (idxOf(STYLE_SYNONYMS[g], base) < 0) continue;
            for (k = 0; k < STYLE_SYNONYMS[g].length; k++) {
                out.push(STYLE_SYNONYMS[g][k] + (italic ? "italic" : ""));
                if (italic) out.push(STYLE_SYNONYMS[g][k] + "oblique");
            }
        }
        return out;
    }
    function familyGroup(family) {
        caches.families = caches.families || {};
        var key = norm(family);
        if (has(caches.families, key)) return caches.families[key];
        var all = app.fonts.allFonts, found = null, i, j;
        for (i = 0; i < all.length; i++) if (all[i].length && norm(all[i][0].familyName) === key) { found = all[i]; break; }
        if (!found && key.length >= 3) {
            // static instances of variable fonts are often named "<Family> 96pt ExtraBold", "<Family> Display" …
            var merged = [];
            for (i = 0; i < all.length; i++) if (all[i].length && norm(all[i][0].familyName).indexOf(key) === 0) for (j = 0; j < all[i].length; j++) merged.push(all[i][j]);
            if (merged.length) found = merged;
        }
        caches.families[key] = found;
        return found;
    }
    function resolveFont(t) {
        if (!t.font && !t.fontFamily) return null;
        // NB: ExtendScript mis-parses "a || b && c" — always parenthesise mixed boolean operators.
        var style = t.fontStyle ? t.fontStyle : (t.fontWeight !== undefined ? weightToStyle(t.fontWeight) : undefined);
        var ps = fontLookup(t.font, t.fontFamily, style);
        if (ps) return ps;
        var fallback = fontLookup(null, "Arial", t.fontStyle && /bold/i.test(t.fontStyle) ? "Bold" : "Regular") || "ArialMT";
        warn("Font not installed: \"" + (t.font || t.fontFamily) + "\" — using " + fallback);
        return fallback;
    }
    function weightToStyle(w) {
        var n = Number(w);
        if (isNaN(n)) return String(w);
        if (n >= 900) return "Black"; if (n >= 800) return "ExtraBold"; if (n >= 700) return "Bold"; if (n >= 600) return "SemiBold";
        if (n >= 500) return "Medium"; if (n >= 400) return "Regular"; if (n >= 300) return "Light"; if (n >= 200) return "ExtraLight"; return "Thin";
    }
    var JUST = null;
    function justification(v) {
        if (!JUST) JUST = { left: ParagraphJustification.LEFT_JUSTIFY, center: ParagraphJustification.CENTER_JUSTIFY, centre: ParagraphJustification.CENTER_JUSTIFY, right: ParagraphJustification.RIGHT_JUSTIFY, justify: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT, full: ParagraphJustification.FULL_JUSTIFY_LASTLINE_FULL };
        return def(JUST[norm(v)], ParagraphJustification.LEFT_JUSTIFY);
    }

    function buildTextDocument(td, t, ctx) {
        var text = first(t.text, t.content, t.value);
        if (text !== undefined && text !== null && !isArr(text) && !isObj(text)) td.text = String(text).replace(/\r\n|\n/g, "\r");
        if (t.reset === true && typeof td.resetCharStyle === "function") { td.resetCharStyle(); td.resetParagraphStyle(); }
        var ps = resolveFont(t);
        if (ps) td.font = ps;
        if (t.fontSize !== undefined) td.fontSize = Number(t.fontSize);
        var fc = first(t.color, t.fillColor, t.fill);
        if (fc !== undefined && fc !== null) {
            if (fc === false || fc === "none") td.applyFill = false;
            else { td.applyFill = true; td.fillColor = rgb3(fc); }
        }
        var st = t.stroke, sc = first(t.strokeColor, isObj(st) ? st.color : (st !== undefined && st !== false && st !== "none" ? st : undefined));
        var sw = first(t.strokeWidth, isObj(st) ? st.width : undefined);
        if (sc !== undefined) { td.applyStroke = true; td.strokeColor = rgb3(sc); if (sw === undefined) sw = 2; }
        if (sw !== undefined) td.strokeWidth = Number(sw);
        if (st === false || st === "none") td.applyStroke = false;
        if (t.strokeOverFill !== undefined) td.strokeOverFill = !!t.strokeOverFill;
        var j = first(t.justification, t.align, t.textAlign);
        if (j !== undefined) td.justification = justification(j);
        // After Effects only accepts whole-number tracking
        if (t.tracking !== undefined) td.tracking = Math.round(Number(t.tracking));
        else if (t.letterSpacing !== undefined && t.fontSize) td.tracking = Math.round(Number(t.letterSpacing) / Number(t.fontSize) * 1000);
        var lead = first(t.leading, t.lineHeight);
        if (lead !== undefined) {
            if (lead === "auto") td.autoLeading = true;
            else { td.autoLeading = false; td.leading = (t.lineHeight !== undefined && Number(lead) < 4 && td.fontSize) ? Number(lead) * td.fontSize : Number(lead); }
        }
        if (t.baselineShift !== undefined) td.baselineShift = Number(t.baselineShift);
        if (t.allCaps !== undefined) td.allCaps = !!t.allCaps;
        if (t.smallCaps !== undefined) td.smallCaps = !!t.smallCaps;
        if (t.fauxBold !== undefined) td.fauxBold = !!t.fauxBold;
        if (t.fauxItalic !== undefined) td.fauxItalic = !!t.fauxItalic;
        if (t.horizontalScale !== undefined) td.horizontalScale = Number(t.horizontalScale) / (Number(t.horizontalScale) > 4 ? 100 : 1);
        if (t.verticalScale !== undefined) td.verticalScale = Number(t.verticalScale) / (Number(t.verticalScale) > 4 ? 100 : 1);
        if (t.box && td.boxText) { try { td.boxTextSize = t.box; } catch (e) { } }
        return td;
    }

    function applyText(layer, t, ctx, opts) {
        var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
        var content = first(t.content, t.text);
        if (isKeyframeArray(content) || (isObj(content) && has(content, "keyframes"))) {
            var list = isArr(content) ? content : content.keyframes;
            var base = {}, ks = keys(t), i;
            for (i = 0; i < ks.length; i++) if (ks[i] !== "content" && ks[i] !== "text") base[ks[i]] = t[ks[i]];
            prop.setValue(buildTextDocument(prop.value, base, ctx));
            removeAllKeys(prop);
            for (i = 0; i < list.length; i++) {
                var kk = list[i], doc = buildTextDocument(prop.value, base, ctx);
                doc.text = String(first(kk.v, kk.value, "")).replace(/\r\n|\n/g, "\r");
                prop.setValueAtTime(keyTime(kk, ctx), doc);
            }
        } else {
            prop.setValue(buildTextDocument(prop.value, t, ctx));
        }
        if (t.expression) setExpression(layer.property("ADBE Text Properties").property("ADBE Text Document"), t.expression);
        if (t.animators && !(opts && opts.skipAnimators)) addTextAnimators(layer, t.animators, ctx);
        if (t.path && isObj(t.path) && t.path.mask !== undefined) {
            try { layer.property("ADBE Text Properties").property("ADBE Text Path Options").property("ADBE Text Path").setValue(Number(t.path.mask)); } catch (e) { warn("Text path: " + e.message); }
        }
    }

    function anchorText(layer, mode, at) {
        mode = norm(def(mode, "center"));
        if (mode === "baseline" || mode === "none") return;
        var r = layer.sourceRectAtTime(at, false);
        var x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (mode.indexOf("left") >= 0) x = r.left;
        if (mode.indexOf("right") >= 0) x = r.left + r.width;
        if (mode.indexOf("top") >= 0) y = r.top;
        if (mode.indexOf("bottom") >= 0) y = r.top + r.height;
        var ap = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
        if (ap.numKeys > 0) return;
        var cur = ap.value;
        ap.setValue(cur.length > 2 ? [x, y, cur[2]] : [x, y]);
    }

    var ANIM_PROPS = {
        anchorpoint: "ADBE Text Anchor Point 3D", anchor: "ADBE Text Anchor Point 3D", position: "ADBE Text Position 3D",
        scale: "ADBE Text Scale 3D", skew: "ADBE Text Skew", skewaxis: "ADBE Text Skew Axis",
        rotation: "ADBE Text Rotation", rotationx: "ADBE Text Rotation X", rotationy: "ADBE Text Rotation Y",
        opacity: "ADBE Text Opacity", fillcolor: "ADBE Text Fill Color", color: "ADBE Text Fill Color",
        strokecolor: "ADBE Text Stroke Color", fillopacity: "ADBE Text Fill Opacity", strokewidth: "ADBE Text Stroke Width",
        tracking: "ADBE Text Tracking Amount", linespacing: "ADBE Text Line Spacing", characteroffset: "ADBE Text Character Offset",
        blur: "ADBE Text Blur", fillhue: "ADBE Text Fill Hue"
    };
    var SELECTOR_PROPS = { start: "ADBE Text Percent Start", end: "ADBE Text Percent End", offset: "ADBE Text Percent Offset" };
    var ADV_PROPS = { amount: "ADBE Text Selector Max Amount", smoothness: "ADBE Text Selector Smoothness", easehigh: "ADBE Text Levels Max Ease", easelow: "ADBE Text Levels Min Ease", randomseed: "ADBE Text Random Seed", seed: "ADBE Text Random Seed" };

    function addTextAnimators(layer, list, ctx) {
        if (!isArr(list)) list = [list];
        for (var a = 0; a < list.length; a++) {
            var spec = list[a];
            try {
                var anim = layer.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
                if (spec.name) anim.name = spec.name;
                var animPath = propPath(anim);
                var props = def(spec.properties, {}), ks = keys(props), i;
                for (i = 0; i < ks.length; i++) {
                    var mn = ANIM_PROPS[norm(ks[i])];
                    if (!mn) { warn("Unknown text animator property \"" + ks[i] + "\" (use opacity, position, scale, rotation, tracking, blur, fillColor, ...)"); continue; }
                    var p = byPath(layer, animPath).property("ADBE Text Animator Properties").addProperty(mn);
                    var v = props[ks[i]];
                    if (mn === "ADBE Text Position 3D" || mn === "ADBE Text Anchor Point 3D") v = pad3(v, 0);
                    if (mn === "ADBE Text Scale 3D") v = typeof v === "number" ? [v, v, 100] : pad3(v, 100);
                    applyValue(p, v, ctx);
                }
                var sel = first(spec.selector, spec.range, {});
                var s = byPath(layer, animPath).property("ADBE Text Selectors").addProperty("ADBE Text Selector");
                var sPath = propPath(s);
                var sk = keys(sel);
                var adv = byPath(layer, sPath).property("ADBE Text Range Advanced");
                var bo = first(sel.basedOn, sel.based);
                if (bo !== undefined) {
                    var bmap = { characters: 1, chars: 1, charactersexcludingspaces: 2, charsexcludingspaces: 2, words: 3, lines: 4 };
                    adv.property("ADBE Text Range Type2").setValue(typeof bo === "number" ? bo : def(bmap[norm(bo)], 1));
                }
                if (sel.shape !== undefined) {
                    var smap = { square: 1, rampup: 2, rampdown: 3, triangle: 4, round: 5, smooth: 6 };
                    byPath(layer, sPath).property("ADBE Text Range Advanced").property("ADBE Text Range Shape").setValue(typeof sel.shape === "number" ? sel.shape : def(smap[norm(sel.shape)], 1));
                }
                if (sel.mode !== undefined) {
                    var mmap = { add: 1, subtract: 2, intersect: 3, min: 4, max: 5, difference: 6 };
                    byPath(layer, sPath).property("ADBE Text Range Advanced").property("ADBE Text Selector Mode").setValue(typeof sel.mode === "number" ? sel.mode : def(mmap[norm(sel.mode)], 1));
                }
                if (sel.randomize !== undefined) byPath(layer, sPath).property("ADBE Text Range Advanced").property("ADBE Text Randomize Order").setValue(sel.randomize ? 1 : 0);
                if (sel.units !== undefined) byPath(layer, sPath).property("ADBE Text Range Advanced").property("ADBE Text Range Units").setValue(norm(sel.units) === "index" ? 2 : 1);
                for (i = 0; i < sk.length; i++) {
                    var n = norm(sk[i]);
                    if (has(SELECTOR_PROPS, n)) applyValue(byPath(layer, sPath).property(SELECTOR_PROPS[n]), sel[sk[i]], ctx);
                    else if (has(ADV_PROPS, n)) applyValue(byPath(layer, sPath).property("ADBE Text Range Advanced").property(ADV_PROPS[n]), sel[sk[i]], ctx);
                }
            } catch (e) { warn("Text animator " + (a + 1) + " on \"" + layer.name + "\": " + e.message); }
        }
    }
    function pad3(v, z) { if (!isArr(v)) return v; return [v[0], def(v[1], 0), def(v[2], z)]; }

    /* =========================================================== masks */
    var MASK_MODES = null;
    function maskMode(m) {
        if (!MASK_MODES) MASK_MODES = { none: MaskMode.NONE, add: MaskMode.ADD, subtract: MaskMode.SUBTRACT, intersect: MaskMode.INTERSECT, lighten: MaskMode.LIGHTEN, darken: MaskMode.DARKEN, difference: MaskMode.DIFFERENCE };
        return def(MASK_MODES[norm(m)], MaskMode.ADD);
    }
    function rectShape(x, y, w, h, r) {
        if (!r) return { vertices: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true };
        r = Math.min(r, w / 2, h / 2);
        var k = r * 0.5523;
        return {
            vertices: [[x + r, y], [x + w - r, y], [x + w, y + r], [x + w, y + h - r], [x + w - r, y + h], [x + r, y + h], [x, y + h - r], [x, y + r]],
            inTangents: [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]],
            outTangents: [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]],
            closed: true
        };
    }
    function ellipseShape(cx, cy, rx, ry) {
        var kx = rx * 0.5523, ky = ry * 0.5523;
        return {
            vertices: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
            inTangents: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
            outTangents: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]],
            closed: true
        };
    }
    function maskPathValue(m) {
        if (m.rect) { var r = m.rect; return rectShape(r[0], r[1], r[2], r[3], def(m.roundness, 0)); }
        if (m.ellipse) { var e = m.ellipse; return ellipseShape(e[0], e[1], e[2], def(e[3], e[2])); }
        return first(m.path, m);
    }
    function addMasks(layer, masks, ctx) {
        if (!isArr(masks)) masks = [masks];
        for (var i = 0; i < masks.length; i++) {
            var m = masks[i];
            try {
                var atom = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
                if (m.name) atom.name = m.name;
                atom.maskMode = maskMode(def(m.mode, "add"));
                if (m.inverted) atom.inverted = true;
                var aPath = propPath(atom);
                var pv = maskPathValue(m);
                applyValue(byPath(layer, aPath).property("ADBE Mask Shape"), isObj(pv) && hasAny(pv, ["keyframes"]) ? pv : { value: pv }, ctx);
                if (m.feather !== undefined) applyValue(byPath(layer, aPath).property("ADBE Mask Feather"), typeof m.feather === "number" ? [m.feather, m.feather] : m.feather, ctx);
                if (m.opacity !== undefined) applyValue(byPath(layer, aPath).property("ADBE Mask Opacity"), m.opacity, ctx);
                var ex = first(m.expansion, m.offset);
                if (ex !== undefined) applyValue(byPath(layer, aPath).property("ADBE Mask Offset"), ex, ctx);
            } catch (e) { warn("Mask " + (i + 1) + " on \"" + layer.name + "\": " + e.message); }
        }
    }

    /* ========================================================= effects */
    var EFFECT_ALIASES = {
        blur: "ADBE Gaussian Blur 2", gaussianblur: "ADBE Gaussian Blur 2", fastblur: "ADBE Gaussian Blur 2",
        dropshadow: "ADBE Drop Shadow", shadow: "ADBE Drop Shadow", glow: "ADBE Glo2",
        fill: "ADBE Fill", tint: "ADBE Tint", gradientramp: "ADBE Ramp", ramp: "ADBE Ramp",
        fractalnoise: "ADBE Fractal Noise", directionalblur: "ADBE Motion Blur", radialblur: "ADBE Radial Blur",
        turbulentdisplace: "ADBE Turbulent Displace", curves: "ADBE CurvesCustom", levels: "ADBE Easy Levels2",
        huesaturation: "ADBE HUE SATURATION", exposure: "ADBE Exposure2", linearwipe: "ADBE Linear Wipe",
        radialwipe: "ADBE Radial Wipe", motiontile: "ADBE Tile", echo: "ADBE Echo", invert: "ADBE Invert",
        brightnesscontrast: "ADBE Brightness & Contrast 2", stroke: "ADBE Stroke", noise: "ADBE Noise",
        venetianblinds: "ADBE Venetian Blinds", wave: "ADBE Wave Warp", wavewarp: "ADBE Wave Warp",
        cornerpin: "ADBE Corner Pin", bulge: "ADBE Bulge", transform: "ADBE Geometry2", sliderControl: "ADBE Slider Control",
        slider: "ADBE Slider Control", checkbox: "ADBE Checkbox Control", colorcontrol: "ADBE Color Control",
        pointcontrol: "ADBE Point Control", anglecontrol: "ADBE Angle Control", layercontrol: "ADBE Layer Control",
        setmatte: "ADBE Set Matte3", simplechoker: "ADBE Simple Choker", fourcolorgradient: "ADBE 4ColorGradient",
        lensflare: "ADBE Lens Flare", cellpattern: "ADBE Cell Pattern", gridfx: "ADBE Grid", vignette: "ADBE Vignette"
    };
    function effectMatchName(spec) {
        var mn = first(spec.matchName, spec.effect, spec.type, spec.name);
        if (!mn) fail("Effect needs \"matchName\" or \"name\"");
        var n = norm(mn);
        if (has(EFFECT_ALIASES, n)) return EFFECT_ALIASES[n];
        var list = effectList(), i;
        for (i = 0; i < list.length; i++) if (list[i].matchName === mn) return mn;
        for (i = 0; i < list.length; i++) if (norm(list[i].displayName) === n) return list[i].matchName;
        for (i = 0; i < list.length; i++) if (norm(list[i].matchName) === n) return list[i].matchName;
        return mn;
    }
    function effectList() {
        if (!caches.effects) {
            // app.effects rebuilds the whole list on every access, so read it exactly once
            var all = app.effects, l = [], i, e;
            for (i = 0; i < all.length; i++) { e = all[i]; l.push({ displayName: e.displayName, matchName: e.matchName, category: e.category }); }
            caches.effects = l;
        }
        return caches.effects;
    }
    function applyEffectProps(layer, fxPath, props, ctx) {
        var ks = keys(props), i;
        for (i = 0; i < ks.length; i++) {
            var fx = byPath(layer, fxPath), key = ks[i], p;
            try {
                if (String(key).indexOf("/") > 0) { p = fx; var segs = key.split("/"); for (var j = 0; j < segs.length && p; j++) p = childProp(p, segs[j]); }
                else p = childProp(fx, key);
                if (!p) { warn("Effect \"" + fx.name + "\" has no property \"" + key + "\"" + childHint(fx)); continue; }
                applyValue(p, props[key], ctx);
            } catch (e) { warn("Effect \"" + fx.name + "\" / \"" + key + "\": " + e.message); }
        }
    }
    function addEffect(layer, spec, ctx) {
        if (typeof spec === "string") spec = { name: spec };
        var mn = effectMatchName(spec);
        var parade = layer.property("ADBE Effect Parade");
        if (!parade.canAddProperty(mn)) fail("Effect not available: \"" + first(spec.matchName, spec.name) + "\" (use list_effects to find the match name)");
        var fx = parade.addProperty(mn);
        if (spec.name && spec.matchName && spec.name !== fx.name) fx.name = spec.name;
        else if (spec.label) fx.name = spec.label;
        var fxPath = propPath(fx);
        if (spec.properties) applyEffectProps(layer, fxPath, spec.properties, ctx);
        if (spec.enabled === false) byPath(layer, fxPath).enabled = false;
        return byPath(layer, fxPath);
    }
    function addEffects(layer, list, ctx) {
        if (!isArr(list)) list = [list];
        for (var i = 0; i < list.length; i++) {
            try { addEffect(layer, list[i], ctx); }
            catch (e) { warn("Effect " + (i + 1) + " on \"" + layer.name + "\": " + e.message); }
        }
    }

    /* ========================================================= markers */
    function addMarkers(target, list, ctx) {
        if (!isArr(list)) list = [list];
        var mp = target.markerProperty || target.property("ADBE Marker");
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (typeof m === "number" || typeof m === "string") m = { time: m };
            var mv = new MarkerValue(String(def(first(m.comment, m.name, m.label_text), "")));
            if (m.duration !== undefined) mv.duration = ctx.dur(m.duration);
            if (m.chapter) mv.chapter = String(m.chapter);
            if (m.url) mv.url = String(m.url);
            if (m.label !== undefined) { try { mv.label = Number(m.label); } catch (e) { } }
            mp.setValueAtTime(keyTime(m, ctx), mv);
        }
    }

    /* ============================================================ misc */
    function blendMode(name) {
        var key = String(name).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s\-]/g, "_").toUpperCase();
        var alts = [key, key.replace("SILHOUETTE", "SILHOUETE"), key.replace("_", "")];
        for (var i = 0; i < alts.length; i++) if (BlendingMode[alts[i]] !== undefined) return BlendingMode[alts[i]];
        warn("Unknown blend mode \"" + name + "\" — using normal");
        return BlendingMode.NORMAL;
    }
    function blendName(v) {
        for (var k in BlendingMode) { try { if (BlendingMode[k] === v) return k.toLowerCase().replace(/_([a-z])/g, function (a, b) { return b.toUpperCase(); }); } catch (e) { } }
        return String(v);
    }
    function matteType(name) {
        var n = norm(def(name, "alpha"));
        if (n === "alpha") return TrackMatteType.ALPHA;
        if (n === "alphainverted" || n === "alphainvert" || n === "invertedalpha") return TrackMatteType.ALPHA_INVERTED;
        if (n === "luma") return TrackMatteType.LUMA;
        if (n === "lumainverted" || n === "lumainvert" || n === "invertedluma") return TrackMatteType.LUMA_INVERTED;
        if (n === "none") return TrackMatteType.NO_TRACK_MATTE;
        fail("Unknown track matte type \"" + name + "\" (alpha, alphaInverted, luma, lumaInverted, none)");
    }
    function matteName(v) {
        if (v === TrackMatteType.ALPHA) return "alpha"; if (v === TrackMatteType.ALPHA_INVERTED) return "alphaInverted";
        if (v === TrackMatteType.LUMA) return "luma"; if (v === TrackMatteType.LUMA_INVERTED) return "lumaInverted";
        return "none";
    }

    function setInOut(layer, ip, op) {
        try {
            if (ip !== undefined && op !== undefined) {
                if (ip >= layer.outPoint) { layer.outPoint = op; layer.inPoint = ip; }
                else { layer.inPoint = ip; layer.outPoint = op; }
            } else if (ip !== undefined) layer.inPoint = ip;
            else if (op !== undefined) layer.outPoint = op;
        } catch (e) {
            warn("Timing on \"" + layer.name + "\": " + e.message + " (in=" + r4(ip) + ", out=" + r4(op) + "). Footage cannot extend past its source duration unless time remapping is enabled.");
        }
    }

    function applyTiming(layer, spec, ctx, isNew) {
        var src = layer.source, timed = src && (src instanceof CompItem || (src instanceof FootageItem && !(src.mainSource instanceof SolidSource) && !src.mainSource.isStill));
        if (spec.timeStretch !== undefined || spec.stretch !== undefined) layer.stretch = Number(first(spec.timeStretch, spec.stretch));
        var ip = ctx.time(first(spec.inPoint, spec["in"], spec.start));
        var op = ctx.time(first(spec.outPoint, spec.out, spec.end));
        var dur = ctx.dur(spec.duration);
        if (spec.startTime !== undefined) layer.startTime = ctx.time(spec.startTime);
        else if (timed && ip !== undefined) layer.startTime = ip - (spec.sourceIn !== undefined ? ctx.dur(spec.sourceIn) : 0);
        else if (isNew && ip === undefined && ctx.offset) layer.startTime = ctx.offset;
        if (ip === undefined && isNew && ctx.defaultIn !== undefined && !timed) ip = ctx.defaultIn;
        if (op === undefined && dur !== undefined) op = (ip !== undefined ? ip : layer.inPoint) + dur;
        if (op === undefined && isNew && ctx.defaultOut !== undefined && !timed) op = ctx.defaultOut;
        if (spec.timeRemap !== undefined) {
            layer.timeRemapEnabled = true;
            if (spec.timeRemap !== true) applyValue(layer.property("ADBE Time Remapping"), spec.timeRemap, ctx);
        }
        if (ip !== undefined || op !== undefined) setInOut(layer, ip, op);
    }

    function applySwitches(layer, s) {
        function sw(name, fn) { try { fn(); } catch (e) { warn("\"" + name + "\" on \"" + layer.name + "\": " + e.message); } }
        if (s.name !== undefined) layer.name = String(s.name);
        if (s.threeD !== undefined || s["3d"] !== undefined) sw("threeD", function () { layer.threeDLayer = !!first(s.threeD, s["3d"]); });
        if (s.blendMode !== undefined) sw("blendMode", function () { layer.blendingMode = blendMode(s.blendMode); });
        if (s.motionBlur !== undefined) sw("motionBlur", function () { layer.motionBlur = !!s.motionBlur; });
        if (s.enabled !== undefined) sw("enabled", function () { layer.enabled = !!s.enabled; });
        if (s.visible !== undefined) sw("visible", function () { layer.enabled = !!s.visible; });
        if (s.audioEnabled !== undefined) sw("audioEnabled", function () { layer.audioEnabled = !!s.audioEnabled; });
        if (s.solo !== undefined) sw("solo", function () { layer.solo = !!s.solo; });
        if (s.shy !== undefined) sw("shy", function () { layer.shy = !!s.shy; });
        if (s.guide !== undefined) sw("guide", function () { layer.guideLayer = !!s.guide; });
        if (s.label !== undefined) sw("label", function () { layer.label = Number(s.label); });
        if (s.comment !== undefined) sw("comment", function () { layer.comment = String(s.comment); });
        if (s.adjustment !== undefined) sw("adjustment", function () { layer.adjustmentLayer = !!s.adjustment; });
        if (s.preserveTransparency !== undefined) sw("preserveTransparency", function () { layer.preserveTransparency = !!s.preserveTransparency; });
        if (s.collapseTransformation !== undefined || s.continuousRasterize !== undefined) sw("collapseTransformation", function () { layer.collapseTransformation = !!first(s.collapseTransformation, s.continuousRasterize); });
        if (s.autoOrient !== undefined) sw("autoOrient", function () { layer.autoOrient = s.autoOrient === "path" || s.autoOrient === true ? AutoOrientType.ALONG_PATH : (s.autoOrient === "camera" ? AutoOrientType.CAMERA_OR_POINT_OF_INTEREST : AutoOrientType.NO_AUTO_ORIENT); });
        if (s.quality !== undefined) sw("quality", function () { var q = norm(s.quality); layer.quality = q === "draft" ? LayerQuality.DRAFT : (q === "wireframe" ? LayerQuality.WIREFRAME : LayerQuality.BEST); });
    }

    function applyGenericProps(layer, map, ctx) {
        var ks = keys(map), i;
        for (i = 0; i < ks.length; i++) {
            try { applyValue(resolveProp(layer, ks[i]), map[ks[i]], ctx); }
            catch (e) { warn("Property \"" + ks[i] + "\" on \"" + layer.name + "\": " + e.message); }
        }
    }
    function applyExpressions(layer, map) {
        var ks = keys(map), i;
        for (i = 0; i < ks.length; i++) {
            try { setExpression(resolveProp(layer, ks[i]), map[ks[i]]); }
            catch (e) { warn("Expression on \"" + ks[i] + "\" of \"" + layer.name + "\": " + e.message); }
        }
    }

    /* ======================================================= footage */
    function findFootageByPath(fsName) {
        var p = app.project, i, it;
        for (i = 1; i <= p.numItems; i++) {
            it = p.item(i);
            if (it instanceof FootageItem && it.file && it.file.fsName === fsName) return it;
        }
        return null;
    }
    function importFootage(path, o) {
        o = o || {};
        var f = new File(path);
        if (!f.exists) fail("File not found: " + path);
        if (o.reuse !== false && !o.sequence) { var ex = findFootageByPath(f.fsName); if (ex) return ex; }
        var io = new ImportOptions(f);
        if (o.sequence) { io.sequence = true; if (o.forceAlphabetical) io.forceAlphabetical = true; }
        if (o.as) {
            var a = norm(o.as), t = a === "comp" ? ImportAsType.COMP : (a === "compcroppedlayers" || a === "layers" ? ImportAsType.COMP_CROPPED_LAYERS : ImportAsType.FOOTAGE);
            if (io.canImportAs(t)) io.importAs = t; else warn("Cannot import " + f.name + " as " + o.as);
        }
        var item = app.project.importFile(io);
        if (o.name) item.name = String(o.name);
        if (o.folder) item.parentFolder = o.folder;
        if (o.fps && item.mainSource) { try { item.mainSource.conformFrameRate = Number(o.fps); } catch (e) { } }
        if (o.loop && item.mainSource) { try { item.mainSource.loop = Number(o.loop); } catch (e2) { } }
        return item;
    }

    function fitLayer(layer, mode, comp) {
        if (!mode) return;
        var src = layer.source;
        if (!src || !src.width) return;
        var sx = comp.width / src.width, sy = comp.height / src.height, s;
        var m = norm(mode), sc = layer.property("ADBE Transform Group").property("ADBE Scale");
        var z = sc.value.length > 2 ? [100] : [];
        if (m === "contain" || m === "fit") s = Math.min(sx, sy);
        else if (m === "cover" || m === "fill") s = Math.max(sx, sy);
        else if (m === "width") s = sx;
        else if (m === "height") s = sy;
        else if (m === "stretch") { sc.setValue([sx * 100, sy * 100].concat(z)); return; }
        else { warn("Unknown fit mode " + mode); return; }
        sc.setValue([s * 100, s * 100].concat(z));
    }

    /* ======================================================== builder */
    function makeCtx(comp, o) {
        o = o || {};
        return {
            comp: comp, fps: comp.frameRate, offset: def(o.offset, 0), ids: def(o.ids, {}), defaultEase: def(o.defaultEase, "linear"),
            defaultIn: o.defaultIn, defaultOut: o.defaultOut, assets: def(o.assets, {}), comps: def(o.comps, {}), folder: o.folder,
            time: function (v) { var t = parseTime(v, this.fps); return t === undefined ? undefined : t + this.offset; },
            dur: function (v) { return parseTime(v, this.fps); }
        };
    }

    function guessType(s) {
        if (s.type) return norm(s.type);
        if (s.text !== undefined) return "text";
        if (s.shapes || s.contents) return "shape";
        if (s.comp !== undefined) return "precomp";
        if (s.asset !== undefined || s.path !== undefined || s.file !== undefined || s.item !== undefined) return "footage";
        if (s.color !== undefined) return "solid";
        return "null";
    }

    function resolveSource(spec, ctx) {
        var it;
        if (spec.asset !== undefined) {
            it = ctx.assets[spec.asset];
            if (!it) fail("Unknown asset \"" + spec.asset + "\" (declare it in the top-level \"assets\" list)");
            return it;
        }
        if (spec.item !== undefined) { it = findItem(spec.item); if (!it) fail("Project item not found: " + spec.item); return it; }
        var p = first(spec.path, spec.file);
        if (p !== undefined) return importFootage(p, { sequence: spec.sequence, as: spec.importAs, folder: ctx.folder, fps: spec.fps, reuse: spec.reuse });
        fail("Footage layer needs \"asset\", \"path\" or \"item\"");
    }

    // pass 1: create the layer and its type-specific content
    function createLayer(comp, spec, ctx) {
        var type = guessType(spec), layer, name = spec.name;
        var w = Number(def(spec.width, comp.width)), h = Number(def(spec.height, comp.height));
        if (type === "solid" || type === "adjustment" || type === "colorsolid") {
            var c = rgb3(def(spec.color, type === "adjustment" ? "#ffffff" : "#808080"));
            layer = comp.layers.addSolid(c, name || (type === "adjustment" ? "Adjustment Layer" : "Solid"), Math.round(w), Math.round(h), comp.pixelAspect, comp.duration);
            if (type === "adjustment") layer.adjustmentLayer = true;
        } else if (type === "shape" || type === "shapes" || type === "vector") {
            layer = comp.layers.addShape();
            if (name) layer.name = name;
            addShapeItems(layer, propPath(layer.property("ADBE Root Vectors Group")), first(spec.shapes, spec.contents, []), ctx);
        } else if (type === "text") {
            var t = isObj(spec.text) ? spec.text : { content: def(spec.text, "Text") };
            var initial = first(t.content, t.text, "");
            if (isArr(initial) || isObj(initial)) initial = " ";
            if (t.box) layer = comp.layers.addBoxText(t.box, String(initial).replace(/\r\n|\n/g, "\r"));
            else layer = comp.layers.addText(String(initial).replace(/\r\n|\n/g, "\r"));
            applyText(layer, t, ctx, { skipAnimators: true }); // animators are added after the anchor is measured
            if (name) layer.name = name;
        } else if (type === "null") {
            layer = comp.layers.addNull(comp.duration);
            if (name) layer.name = name;
        } else if (type === "camera") {
            layer = comp.layers.addCamera(name || "Camera", [comp.width / 2, comp.height / 2]);
            if (spec.zoom !== undefined) applyValue(layer.property("ADBE Camera Options Group").property("ADBE Camera Zoom"), spec.zoom, ctx);
        } else if (type === "light") {
            layer = comp.layers.addLight(name || "Light", [comp.width / 2, comp.height / 2]);
            var lt = norm(def(spec.lightType, "point"));
            var lmap = { parallel: LightType.PARALLEL, spot: LightType.SPOT, point: LightType.POINT, ambient: LightType.AMBIENT };
            if (has(lmap, lt)) layer.lightType = lmap[lt];
            var lo = layer.property("ADBE Light Options Group");
            if (spec.color !== undefined) applyValue(lo.property("ADBE Light Color"), spec.color, ctx);
            if (spec.intensity !== undefined) applyValue(layer.property("ADBE Light Options Group").property("ADBE Light Intensity"), spec.intensity, ctx);
            if (spec.castsShadows !== undefined) layer.property("ADBE Light Options Group").property("ADBE Casts Shadows").setValue(spec.castsShadows ? 1 : 0);
        } else if (type === "precomp" || type === "comp" || type === "composition") {
            var cref = spec.comp, ci = (typeof cref === "string" && has(ctx.comps, cref)) ? ctx.comps[cref] : findItem(cref, "comp");
            if (!ci) fail("Precomp layer: composition not found \"" + cref + "\"");
            if (ci === comp) fail("A composition cannot contain itself");
            layer = comp.layers.add(ci);
            if (name) layer.name = name;
        } else if (type === "footage" || type === "image" || type === "video" || type === "audio" || type === "file" || type === "svg" || type === "sequence") {
            var src = resolveSource(spec, ctx);
            layer = comp.layers.add(src);
            if (name) layer.name = name;
        } else fail("Unknown layer type \"" + spec.type + "\" (solid, adjustment, shape, text, null, camera, light, footage, precomp)");
        return layer;
    }

    // pass 3: everything that depends on the layer existing (and on parenting being set)
    function decorateLayer(layer, spec, ctx, isNew) {
        var type = guessType(spec);
        applyTiming(layer, spec, ctx, isNew);
        applySwitches(layer, spec);
        if (spec.fit) fitLayer(layer, spec.fit, ctx.comp);
        if (type === "text" && isNew) {
            var t = isObj(spec.text) ? spec.text : {};
            try { anchorText(layer, def(t.anchor, spec.anchor), Math.max(layer.inPoint, 0)); } catch (e) { warn("Text anchor on \"" + layer.name + "\": " + e.message); }
            if (t.animators) addTextAnimators(layer, t.animators, ctx);
        }
        if (spec.transform) applyTransform(layer, spec.transform, ctx);
        if (spec.masks) addMasks(layer, spec.masks, ctx);
        if (spec.effects) addEffects(layer, spec.effects, ctx);
        if (spec.properties) applyGenericProps(layer, spec.properties, ctx);
        if (spec.expressions) applyExpressions(layer, spec.expressions);
        if (spec.markers) { try { addMarkers(layer, spec.markers, ctx); } catch (e2) { warn("Markers on \"" + layer.name + "\": " + e2.message); } }
    }

    function setParent(layer, ref, ctx, jump) {
        if (ref === null || ref === "none" || ref === false) { layer.parent = null; return; }
        var p = resolveLayerRef(ref, ctx);
        if (p === layer) fail("A layer cannot be its own parent");
        if (jump && typeof layer.setParentWithJump === "function") layer.setParentWithJump(p);
        else layer.parent = p;
    }

    function setMatte(layer, m, ctx) {
        if (m === null || m === false || m === "none") {
            if (typeof layer.setTrackMatte === "function") layer.setTrackMatte(null, TrackMatteType.NO_TRACK_MATTE);
            else layer.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
            return;
        }
        if (!isObj(m)) m = { layer: m };
        var ml = resolveLayerRef(m.layer, ctx), mt = matteType(def(m.type, "alpha"));
        if (ml === layer) fail("A layer cannot be its own track matte");
        if (typeof layer.setTrackMatte === "function") {
            layer.setTrackMatte(ml, mt);
        } else {
            ml.moveBefore(layer);
            layer.trackMatteType = mt;
        }
        if (m.hideMatte !== false) ml.enabled = false;
    }

    // Builds an array of layer specs into a comp. specs[0] ends up on top.
    function buildLayers(comp, specs, ctx, placement) {
        var created = [], i, s;
        // create bottom-up so the first spec is the top layer
        for (i = specs.length - 1; i >= 0; i--) {
            s = specs[i];
            if (!isObj(s)) { warn("Layer " + (i + 1) + " is not an object — skipped"); continue; }
            try {
                var l = createLayer(comp, s, ctx);
                created.unshift({ layer: l, spec: s });
                var id = first(s.id, s.name);
                if (id !== undefined) {
                    if (has(ctx.ids, String(id)) && s.id !== undefined) warn("Duplicate layer id \"" + id + "\"");
                    ctx.ids[String(id)] = l;
                }
            } catch (e) { warn("Layer " + (i + 1) + (s.name ? " \"" + s.name + "\"" : "") + " was not created: " + e.message); }
        }
        // place the whole block relative to an existing layer if asked
        if (placement && created.length) placeBlock(comp, created, placement, ctx);
        // parenting first, so transforms are interpreted in parent space
        for (i = 0; i < created.length; i++) {
            s = created[i].spec;
            if (s.parent !== undefined && s.parent !== null) {
                try { setParent(created[i].layer, s.parent, ctx, s.parentJump !== false); }
                catch (e1) { warn("Parent of \"" + created[i].layer.name + "\": " + e1.message); }
            }
        }
        for (i = 0; i < created.length; i++) {
            try { decorateLayer(created[i].layer, created[i].spec, ctx, true); }
            catch (e2) { warn("Layer \"" + created[i].layer.name + "\": " + e2.message); }
        }
        for (i = 0; i < created.length; i++) {
            s = created[i].spec;
            var m = first(s.trackMatte, s.matte);
            if (m !== undefined) { try { setMatte(created[i].layer, m, ctx); } catch (e3) { warn("Track matte on \"" + created[i].layer.name + "\": " + e3.message); } }
        }
        for (i = 0; i < created.length; i++) if (created[i].spec.locked) { try { created[i].layer.locked = true; } catch (e4) { } }
        var out = [];
        for (i = 0; i < created.length; i++) out.push(layerSummary(created[i].layer));
        return out;
    }

    function placeBlock(comp, created, p, ctx) {
        var i, ref;
        if (p.index !== undefined) {
            var target = Number(p.index);
            for (i = created.length - 1; i >= 0; i--) {
                if (target > comp.numLayers) created[i].layer.moveToEnd();
                else if (comp.layer(target) !== created[i].layer) created[i].layer.moveBefore(comp.layer(target));
            }
            return;
        }
        if (p.above !== undefined) {
            ref = findLayer(comp, p.above);
            for (i = 0; i < created.length; i++) created[i].layer.moveBefore(ref);
            return;
        }
        if (p.below !== undefined) {
            ref = findLayer(comp, p.below);
            for (i = created.length - 1; i >= 0; i--) created[i].layer.moveAfter(ref);
            return;
        }
        if (p.bottom) for (i = 0; i < created.length; i++) created[i].layer.moveToEnd();
    }

    function compSettings(c) {
        return {
            name: c.name, width: c.width, height: c.height, fps: r4(c.frameRate), duration: r4(c.duration),
            pixelAspect: c.pixelAspect, bgColor: toHex(c.bgColor)
        };
    }

    function applyCompSettings(comp, s, ctx) {
        if (s.name !== undefined) comp.name = String(s.name);
        if (s.width !== undefined) comp.width = Math.round(Number(s.width));
        if (s.height !== undefined) comp.height = Math.round(Number(s.height));
        var fps = first(s.fps, s.frameRate);
        if (fps !== undefined) comp.frameRate = Number(fps);
        if (s.duration !== undefined) comp.duration = parseTime(s.duration, comp.frameRate);
        if (s.pixelAspect !== undefined) comp.pixelAspect = Number(s.pixelAspect);
        var bg = first(s.bgColor, s.backgroundColor, s.background);
        if (bg !== undefined) comp.bgColor = rgb3(bg);
        if (s.workAreaStart !== undefined) comp.workAreaStart = parseTime(s.workAreaStart, comp.frameRate);
        if (s.workAreaDuration !== undefined) comp.workAreaDuration = parseTime(s.workAreaDuration, comp.frameRate);
        if (s.displayStartTime !== undefined) comp.displayStartTime = parseTime(s.displayStartTime, comp.frameRate);
        if (s.motionBlur !== undefined) comp.motionBlur = !!s.motionBlur;
        if (s.shutterAngle !== undefined) comp.shutterAngle = Number(s.shutterAngle);
        if (s.shutterPhase !== undefined) comp.shutterPhase = Number(s.shutterPhase);
        if (s.frameBlending !== undefined) comp.frameBlending = !!s.frameBlending;
        if (s.renderer !== undefined) { try { comp.renderer = String(s.renderer); } catch (e) { warn("Renderer: " + e.message); } }
        if (s.hideShyLayers !== undefined) comp.hideShyLayers = !!s.hideShyLayers;
        if (s.markers) addMarkers(comp, s.markers, ctx || makeCtx(comp));
        if (s.time !== undefined) comp.time = parseTime(s.time, comp.frameRate);
    }

    function newComp(s, folder) {
        var fps = Number(def(first(s.fps, s.frameRate), 30));
        var dur = parseTime(def(s.duration, 10), fps);
        var w = Math.round(Number(def(s.width, 1920))), h = Math.round(Number(def(s.height, 1080)));
        if (w < 4 || h < 4 || w > 30000 || h > 30000) fail("Comp size must be between 4 and 30000 px");
        if (!(dur > 0)) fail("Comp duration must be > 0");
        var c = app.project.items.addComp(String(def(s.name, "Claude Comp")), w, h, Number(def(s.pixelAspect, 1)), dur, fps);
        if (folder) c.parentFolder = folder;
        var bg = first(s.bgColor, s.backgroundColor, s.background);
        if (bg !== undefined) c.bgColor = rgb3(bg);
        return c;
    }

    function getFolder(name, parent) {
        if (!name) return null;
        if (name instanceof FolderItem) return name;
        var p = app.project, i;
        for (i = 1; i <= p.numItems; i++) {
            var it = p.item(i);
            if (it instanceof FolderItem && it.name === name && (!parent || it.parentFolder === parent)) return it;
        }
        var f = p.items.addFolder(String(name));
        if (parent) f.parentFolder = parent;
        return f;
    }
    function uniqueFolder(name) {
        var base = String(name), n = base, k = 2, p = app.project, clash = true;
        while (clash) {
            clash = false;
            for (var i = 1; i <= p.numItems; i++) { var it = p.item(i); if (it instanceof FolderItem && it.name === n) { clash = true; break; } }
            if (clash) n = base + " " + (k++);
        }
        return p.items.addFolder(n);
    }

    /* ====================================================== serialize */
    function layerSummary(l) {
        var o = {
            index: l.index, id: l.id, name: l.name, type: layerType(l),
            inPoint: r4(l.inPoint), outPoint: r4(l.outPoint), startTime: r4(l.startTime)
        };
        if (l.parent) o.parent = { index: l.parent.index, name: l.parent.name };
        if (!l.enabled) o.enabled = false;
        if (l.solo) o.solo = true;
        if (l.locked) o.locked = true;
        if (l.shy) o.shy = true;
        if (l.threeDLayer) o.threeD = true;
        if (l.adjustmentLayer && o.type !== "adjustment") o.adjustment = true;
        if (l.guideLayer) o.guide = true;
        if (l.selected) o.selected = true;
        try { if (l.blendingMode !== BlendingMode.NORMAL) o.blendMode = blendName(l.blendingMode); } catch (e) { }
        try {
            if (l.hasTrackMatte) {
                o.trackMatte = { type: matteName(l.trackMatteType) };
                if (l.trackMatteLayer) o.trackMatte.layer = l.trackMatteLayer.name;
            }
            if (l.isTrackMatte) o.isTrackMatte = true;
        } catch (e2) { }
        if (l.stretch !== 100) o.stretch = l.stretch;
        if (l.source) o.source = { id: l.source.id, name: l.source.name };
        if (o.type === "text") {
            try { o.text = l.property("ADBE Text Properties").property("ADBE Text Document").value.text; } catch (e3) { }
        }
        if (o.type === "solid" || o.type === "adjustment") { try { o.color = toHex(l.source.mainSource.color); o.size = [l.source.width, l.source.height]; } catch (e4) { } }
        var fx = l.property("ADBE Effect Parade");
        if (fx && fx.numProperties) { o.effects = []; for (var i = 1; i <= fx.numProperties; i++) o.effects.push(fx.property(i).name); }
        var mk = l.property("ADBE Mask Parade");
        if (mk && mk.numProperties) o.masks = mk.numProperties;
        return o;
    }

    function textDocInfo(td) {
        var o = { text: td.text };
        try { o.font = td.font; o.fontSize = r4(td.fontSize); } catch (e) { }
        try { o.applyFill = td.applyFill; if (td.applyFill) o.fillColor = toHex(td.fillColor); } catch (e2) { }
        try { o.applyStroke = td.applyStroke; if (td.applyStroke) { o.strokeColor = toHex(td.strokeColor); o.strokeWidth = td.strokeWidth; } } catch (e3) { }
        try {
            var j = td.justification;
            o.justification = j === ParagraphJustification.CENTER_JUSTIFY ? "center" : (j === ParagraphJustification.RIGHT_JUSTIFY ? "right" : (j === ParagraphJustification.LEFT_JUSTIFY ? "left" : "justify"));
        } catch (e4) { }
        try { o.tracking = td.tracking; if (!td.autoLeading) o.leading = r4(td.leading); } catch (e5) { }
        try { if (td.boxText) o.box = rArr(td.boxTextSize); } catch (e6) { }
        return o;
    }

    function valueInfo(prop, v) {
        var t = prop.propertyValueType;
        if (v === undefined || v === null) return v;
        if (t === PVT.COLOR) return toHex(v);
        if (t === PVT.TEXT_DOCUMENT) return textDocInfo(v);
        if (t === PVT.SHAPE) return { vertices: rArr(v.vertices), inTangents: rArr(v.inTangents), outTangents: rArr(v.outTangents), closed: v.closed };
        if (t === PVT.MARKER) return { comment: v.comment, duration: r4(v.duration) };
        return rArr(v);
    }
    function interpName(v) {
        if (v === KeyframeInterpolationType.LINEAR) return "linear";
        if (v === KeyframeInterpolationType.BEZIER) return "bezier";
        if (v === KeyframeInterpolationType.HOLD) return "hold";
        return String(v);
    }
    function easeInfo(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push({ speed: r4(arr[i].speed), influence: r4(arr[i].influence) }); return o.length === 1 ? o[0] : o; }

    function propInfo(prop, withKeys) {
        var o = { path: displayPath(prop), matchName: prop.matchName };
        var t = prop.propertyValueType;
        if (t !== PVT.NO_VALUE && t !== PVT.CUSTOM_VALUE) {
            try { o.value = valueInfo(prop, prop.value); } catch (e) { }
        } else o.value = null;
        if (prop.numKeys > 0) {
            o.numKeys = prop.numKeys;
            if (withKeys !== false) {
                o.keyframes = [];
                for (var k = 1; k <= Math.min(prop.numKeys, 200); k++) {
                    var kf = { t: r4(prop.keyTime(k)), v: valueInfo(prop, prop.keyValue(k)) };
                    try {
                        var it = prop.keyInInterpolationType(k), ot = prop.keyOutInterpolationType(k);
                        kf["in"] = interpName(it); kf.out = interpName(ot);
                        if (it === KeyframeInterpolationType.BEZIER) kf.easeIn = easeInfo(prop.keyInTemporalEase(k));
                        if (ot === KeyframeInterpolationType.BEZIER) kf.easeOut = easeInfo(prop.keyOutTemporalEase(k));
                    } catch (e2) { }
                    o.keyframes.push(kf);
                }
            }
        }
        try { if (prop.expressionEnabled && prop.expression) { o.expression = prop.expression; if (prop.expressionError) o.expressionError = prop.expressionError; } } catch (e3) { }
        return o;
    }

    function walkProps(group, depth, maxDepth, all, out, withKeys) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p.name) continue; // hidden internal properties
            if (p.propertyType === PropertyType.PROPERTY) {
                var interesting = all;
                try { interesting = interesting || p.numKeys > 0 || (p.canSetExpression && p.expressionEnabled) || p.isModified; } catch (e) { }
                if (interesting && p.propertyValueType !== PVT.NO_VALUE) out.push(propInfo(p, withKeys));
            } else if (depth < maxDepth) {
                walkProps(p, depth + 1, maxDepth, all, out, withKeys);
            }
        }
    }

    function serializeAny(v, depth) {
        depth = depth || 0;
        if (v === undefined) return null;
        if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
        if (depth > 4) return String(v);
        try { if (v instanceof CompItem) return { _type: "CompItem", id: v.id, name: v.name }; } catch (e) { }
        try { if (v instanceof FootageItem || v instanceof FolderItem) return { _type: v.typeName, id: v.id, name: v.name }; } catch (e1) { }
        try { if (v.containingComp && v.index !== undefined && v.containingComp instanceof CompItem) return { _type: "Layer", index: v.index, name: v.name, comp: v.containingComp.name }; } catch (e2) { }
        try { if (v instanceof Property) return propInfo(v, false); } catch (e3) { }
        try { if (v instanceof PropertyGroup) return { _type: "PropertyGroup", name: v.name, matchName: v.matchName }; } catch (e4) { }
        try { if (v instanceof Shape) return { vertices: rArr(v.vertices), inTangents: rArr(v.inTangents), outTangents: rArr(v.outTangents), closed: v.closed }; } catch (e5) { }
        try { if (v instanceof TextDocument) return textDocInfo(v); } catch (e6) { }
        if (isArr(v)) { var a = []; for (var i = 0; i < Math.min(v.length, 1000); i++) a.push(serializeAny(v[i], depth + 1)); return a; }
        if (typeof v === "object") {
            if (v.reflect && typeof v.toSource !== "function") return String(v);
            var o = {}, k, n = 0;
            for (k in v) { if (n++ > 200) break; try { if (typeof v[k] !== "function") o[k] = serializeAny(v[k], depth + 1); } catch (e2) { } }
            return o;
        }
        return String(v);
    }

    function compInfo(c, detail) {
        var o = compSettings(c);
        o.id = c.id;
        o.time = r4(c.time);
        o.workAreaStart = r4(c.workAreaStart);
        o.workAreaDuration = r4(c.workAreaDuration);
        if (c.displayStartTime) o.displayStartTime = r4(c.displayStartTime);
        o.motionBlur = c.motionBlur;
        o.numLayers = c.numLayers;
        var mp = c.markerProperty;
        if (mp && mp.numKeys) { o.markers = []; for (var k = 1; k <= mp.numKeys; k++) o.markers.push({ time: r4(mp.keyTime(k)), comment: mp.keyValue(k).comment }); }
        o.layers = [];
        for (var i = 1; i <= c.numLayers; i++) {
            var s = layerSummary(c.layer(i));
            if (detail) {
                var anim = [];
                walkProps(c.layer(i), 0, 6, false, anim, false);
                var names = [];
                for (var j = 0; j < anim.length; j++) if (anim[j].numKeys || anim[j].expression) names.push(anim[j].path + (anim[j].numKeys ? " (" + anim[j].numKeys + " keys)" : " (expression)"));
                if (names.length) s.animated = names;
            }
            o.layers.push(s);
        }
        return o;
    }

    /* ======================================================= handlers */
    H.ping = function () {
        var ac = app.project.activeItem;
        return {
            engine: VERSION, app: "After Effects", version: app.version, build: app.buildName,
            project: { name: app.project.file ? app.project.file.name : "Untitled Project", path: app.project.file ? app.project.file.fsName : null, numItems: app.project.numItems, dirty: app.project.dirty },
            activeComp: ac instanceof CompItem ? { id: ac.id, name: ac.name } : null
        };
    };
    NO_UNDO.ping = 1;

    H.get_project = function (p) {
        var out = [], proj = app.project, lim = Number(def(p.limit, 500)), i;
        var filter = p.type ? norm(p.type) : null, q = p.query ? norm(p.query) : null;
        for (i = 1; i <= proj.numItems && out.length < lim; i++) {
            var it = proj.item(i), t = itemType(it);
            if (filter && t !== filter) continue;
            if (q && norm(it.name).indexOf(q) < 0) continue;
            var o = { id: it.id, name: it.name, type: t };
            if (it.parentFolder && it.parentFolder !== proj.rootFolder) o.folder = it.parentFolder.name;
            if (t === "comp") { o.width = it.width; o.height = it.height; o.fps = r4(it.frameRate); o.duration = r4(it.duration); o.numLayers = it.numLayers; }
            else if (t !== "folder") {
                try { if (it.width) { o.width = it.width; o.height = it.height; } } catch (e) { }
                try { if (it.duration) o.duration = r4(it.duration); } catch (e2) { }
                try { if (it.file) o.file = it.file.fsName; } catch (e3) { }
            }
            out.push(o);
        }
        var ac = proj.activeItem;
        return {
            project: proj.file ? proj.file.fsName : null, numItems: proj.numItems, items: out,
            activeComp: ac instanceof CompItem ? { id: ac.id, name: ac.name } : null
        };
    };
    NO_UNDO.get_project = 1;

    H.get_comp = function (p) { return compInfo(findComp(p.comp), p.detail !== false); };
    NO_UNDO.get_comp = 1;

    H.get_layer = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer);
        var o = layerSummary(l), props = [];
        walkProps(l, 0, Number(def(p.depth, 8)), p.all === true, props, p.keyframes !== false);
        o.properties = props;
        try { var r = l.sourceRectAtTime(comp.time, false); o.sourceRect = { left: r4(r.left), top: r4(r.top), width: r4(r.width), height: r4(r.height) }; } catch (e) { }
        if (layerType(l) === "text") { try { o.textDocument = textDocInfo(l.property("ADBE Text Properties").property("ADBE Text Document").value); } catch (e2) { } }
        return o;
    };
    NO_UNDO.get_layer = 1;

    H.get_property = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer), prop = resolveProp(l, p.path);
        if (prop.propertyType !== PropertyType.PROPERTY) {
            var list = [];
            walkProps(prop, 0, Number(def(p.depth, 3)), true, list, true);
            return { path: displayPath(prop), matchName: prop.matchName, group: true, properties: list };
        }
        var o = propInfo(prop, true);
        if (p.time !== undefined) o.valueAtTime = valueInfo(prop, prop.valueAtTime(parseTime(p.time, comp.frameRate), false));
        return o;
    };
    NO_UNDO.get_property = 1;

    H.list_effects = function (p) {
        var list = effectList(), out = [], q = p.query ? norm(p.query) : null, cat = p.category ? norm(p.category) : null, lim = Number(def(p.limit, 100));
        for (var i = 0; i < list.length && out.length < lim; i++) {
            var e = list[i];
            if (q && norm(e.displayName).indexOf(q) < 0 && norm(e.matchName).indexOf(q) < 0) continue;
            if (cat && norm(e.category).indexOf(cat) < 0) continue;
            out.push(e);
        }
        return { total: list.length, effects: out };
    };
    NO_UNDO.list_effects = 1;

    H.list_fonts = function (p) {
        if (!app.fonts) fail("Font listing needs After Effects 2024 or newer");
        var all = app.fonts.allFonts, out = [], q = p.query ? norm(p.query) : null, lim = Number(def(p.limit, 100));
        for (var i = 0; i < all.length && out.length < lim; i++) {
            var grp = all[i];
            if (!grp.length) continue;
            if (q && norm(grp[0].familyName).indexOf(q) < 0) continue;
            var styles = [];
            for (var j = 0; j < grp.length; j++) styles.push({ style: grp[j].styleName, postScriptName: grp[j].postScriptName });
            out.push({ family: grp[0].familyName, styles: styles });
        }
        return { families: out };
    };
    NO_UNDO.list_fonts = 1;

    H.create_comp = function (p) {
        var folder = p.folder ? getFolder(p.folder) : null;
        var comp = newComp(p, folder);
        var ctx = makeCtx(comp, { defaultEase: p.defaultEase, folder: folder });
        applyCompSettings(comp, { workAreaStart: p.workAreaStart, workAreaDuration: p.workAreaDuration, motionBlur: p.motionBlur, shutterAngle: p.shutterAngle, displayStartTime: p.displayStartTime, markers: p.markers, renderer: p.renderer }, ctx);
        var layers = [];
        if (p.layers && p.layers.length) layers = buildLayers(comp, p.layers, ctx);
        if (p.open !== false) { try { comp.openInViewer(); } catch (e) { } }
        return { comp: { id: comp.id, name: comp.name }, layers: layers };
    };

    H.update_comp = function (p) {
        var comp = findComp(p.comp);
        applyCompSettings(comp, p, makeCtx(comp));
        if (p.open) { try { comp.openInViewer(); } catch (e) { } }
        return compSettings(comp);
    };

    H.add_layers = function (p) {
        var comp = findComp(p.comp);
        var list = p.layers || (p.layer ? [p.layer] : null);
        if (!list || !list.length) fail("add_layers needs a \"layers\" array");
        var ctx = makeCtx(comp, { defaultEase: p.defaultEase, offset: p.timeOffset ? parseTime(p.timeOffset, comp.frameRate) : 0, folder: p.folder ? getFolder(p.folder) : null });
        var res = buildLayers(comp, list, ctx, { index: p.index, above: p.above, below: p.below, bottom: p.bottom });
        return { comp: { id: comp.id, name: comp.name }, layers: res };
    };

    H.update_layer = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer);
        var ctx = makeCtx(comp, { defaultEase: p.defaultEase });
        var s = p.set || p.changes || p;
        if (s.parent !== undefined) setParent(l, s.parent, ctx, s.parentJump === true);
        applyTiming(l, s, ctx, false);
        applySwitches(l, s);
        if (s.fit) fitLayer(l, s.fit, comp);
        if (s.text !== undefined && layerType(l) === "text") applyText(l, isObj(s.text) ? s.text : { content: s.text }, ctx);
        if (s.shapes) {
            if (layerType(l) !== "shape") fail("\"shapes\" can only be used on shape layers");
            if (s.replaceShapes) { var root = l.property("ADBE Root Vectors Group"); while (root.numProperties > 0) { root.property(root.numProperties).remove(); root = l.property("ADBE Root Vectors Group"); } }
            addShapeItems(l, propPath(l.property("ADBE Root Vectors Group")), s.shapes, ctx);
        }
        if (s.solidColor !== undefined || (s.color !== undefined && (layerType(l) === "solid" || layerType(l) === "adjustment"))) l.source.mainSource.color = rgb3(first(s.solidColor, s.color));
        if (s.transform) applyTransform(l, s.transform, ctx);
        if (s.masks) { if (s.replaceMasks) { var mp = l.property("ADBE Mask Parade"); while (mp.numProperties) { mp.property(1).remove(); mp = l.property("ADBE Mask Parade"); } } addMasks(l, s.masks, ctx); }
        if (s.effects) {
            var list = isArr(s.effects) ? s.effects : [s.effects];
            for (var i = 0; i < list.length; i++) {
                var e = list[i], parade = l.property("ADBE Effect Parade"), ex = null;
                if (isObj(e) && (e.name || e.label)) ex = childProp(parade, e.label || e.name);
                if (isObj(e) && e.remove) { if (ex) ex.remove(); else warn("Effect to remove not found: " + (e.label || e.name)); continue; }
                if (ex && !e.add) { if (e.properties) applyEffectProps(l, propPath(ex), e.properties, ctx); if (e.enabled !== undefined) byPath(l, propPath(ex)).enabled = !!e.enabled; }
                else { try { addEffect(l, e, ctx); } catch (er) { warn("Effect: " + er.message); } }
            }
        }
        if (s.properties) applyGenericProps(l, s.properties, ctx);
        if (s.expressions) applyExpressions(l, s.expressions);
        if (s.markers) addMarkers(l, s.markers, ctx);
        var m = first(s.trackMatte, s.matte);
        if (m !== undefined) setMatte(l, m, ctx);
        if (s.locked !== undefined) l.locked = !!s.locked;
        return layerSummary(l);
    };

    H.set_property = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer), prop = resolveProp(l, p.path);
        var ctx = makeCtx(comp, { defaultEase: p.defaultEase });
        var spec = {};
        if (p.keyframes !== undefined) spec.keyframes = p.keyframes;
        if (p.value !== undefined) spec.value = p.value;
        if (p.expression !== undefined) spec.expression = p.expression;
        if (!hasAny(spec, ["keyframes", "value", "expression"])) fail("set_property needs \"value\", \"keyframes\" or \"expression\"");
        if (prop.propertyType !== PropertyType.PROPERTY) fail("\"" + prop.name + "\" is a group" + childHint(prop));
        if (p.separate !== undefined && prop.dimensionsSeparated !== undefined) { prop.dimensionsSeparated = !!p.separate; prop = resolveProp(l, p.path); }
        applyValue(prop, spec, ctx, { replace: p.replace });
        return propInfo(resolveProp(l, p.path), true);
    };

    H.add_effect = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer);
        var specs = p.effects || [p.effect || p];
        var out = [];
        for (var i = 0; i < specs.length; i++) {
            var s = specs[i];
            if (s === p) s = { matchName: p.matchName, name: p.name, properties: p.properties, enabled: p.enabled, label: p.label };
            var fx = addEffect(l, s, makeCtx(comp));
            out.push({ name: fx.name, matchName: fx.matchName, index: fx.propertyIndex });
        }
        return { layer: l.name, effects: out };
    };

    H.delete_layers = function (p) {
        var comp = findComp(p.comp), refs = p.layers || [p.layer], ls = [], i;
        for (i = 0; i < refs.length; i++) ls.push(findLayer(comp, refs[i]));
        var names = [];
        for (i = 0; i < ls.length; i++) { names.push(ls[i].name); if (ls[i].locked) ls[i].locked = false; ls[i].remove(); }
        return { deleted: names };
    };

    H.duplicate_layer = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer), n = Number(def(p.count, 1)), out = [];
        for (var i = 0; i < n; i++) {
            var d = l.duplicate();
            if (p.name) d.name = n > 1 ? p.name + " " + (i + 1) : p.name;
            if (p.offset !== undefined) {
                var off = parseTime(p.offset, comp.frameRate) * (i + 1);
                d.startTime = l.startTime + off;
            }
            out.push(layerSummary(d));
        }
        return { layers: out };
    };

    H.move_layer = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer);
        if (p.to === "top" || p.top) l.moveToBeginning();
        else if (p.to === "bottom" || p.bottom) l.moveToEnd();
        else if (p.index !== undefined) {
            var idx = Number(p.index);
            if (idx <= 1) l.moveToBeginning();
            else if (idx >= comp.numLayers) l.moveToEnd();
            else if (idx < l.index) l.moveBefore(comp.layer(idx));
            else if (idx > l.index) l.moveAfter(comp.layer(idx));
        }
        else if (p.above !== undefined) l.moveBefore(findLayer(comp, p.above));
        else if (p.below !== undefined) l.moveAfter(findLayer(comp, p.below));
        else fail("move_layer needs index, above, below, or to:\"top\"/\"bottom\"");
        return layerSummary(l);
    };

    H.import_file = function (p) {
        var path = first(p.path, p.file);
        if (!path) fail("import_file needs \"path\"");
        var folder = p.folder ? getFolder(p.folder) : null;
        var item = importFootage(path, { sequence: p.sequence, as: p.as, name: p.name, folder: folder, fps: p.fps, reuse: p.reuse, loop: p.loop });
        var out = { item: { id: item.id, name: item.name, type: itemType(item) } };
        try { if (item.width) { out.item.width = item.width; out.item.height = item.height; } if (item.duration) out.item.duration = r4(item.duration); } catch (e) { }
        if (p.comp !== undefined || p.addToComp || p.time !== undefined || p.inPoint !== undefined) {
            var comp = findComp(p.comp);
            var spec = { type: "footage", item: item.id, name: p.layerName, inPoint: first(p.inPoint, p.time), outPoint: p.outPoint, duration: p.duration, startTime: p.startTime, sourceIn: p.sourceIn, transform: p.transform, fit: p.fit, blendMode: p.blendMode, effects: p.effects, parent: p.parent, threeD: p.threeD, timeStretch: p.timeStretch, masks: p.masks, trackMatte: p.trackMatte };
            var ctx = makeCtx(comp, {});
            var r = buildLayers(comp, [spec], ctx, { index: p.index, above: p.above, below: p.below });
            out.layer = r[0];
            out.comp = { id: comp.id, name: comp.name };
        }
        return out;
    };

    /* ------------------------------------------------ project assets */
    var IMAGE_EXT = /\.(png|jpe?g|gif|bmp|tiff?|tga|exr|dpx|hdr|webp|heic|avif|psd|ai|eps|pdf|svg)$/i;
    function folderPath(it) {
        var parts = [], f = it.parentFolder, root = app.project.rootFolder;
        while (f && f !== root) { parts.unshift(f.name); f = f.parentFolder; }
        return parts.join("/");
    }
    // what a project item is, for humans: image, sequence, video, audio, solid, comp, precomp, folder …
    function mediaKind(it) {
        if (it instanceof FolderItem) return "folder";
        if (it instanceof CompItem) return it.usedIn && it.usedIn.length ? "precomp" : "comp";
        if (!(it instanceof FootageItem)) return "item";
        var ms = it.mainSource;
        if (ms instanceof SolidSource) return "solid";
        if (ms instanceof PlaceholderSource) return "placeholder";
        var name = it.file ? it.file.name : it.name;
        if (it.hasVideo === false && it.hasAudio) return "audio";
        if (ms.isStill) return /\.(psd|ai|eps|pdf|svg)$/i.test(name) ? "graphic" : "image";
        if (IMAGE_EXT.test(name)) return "sequence";
        return "video";
    }
    // music / voice-over / sfx guess from the name and length (audio only)
    function audioRole(it) {
        // plain word tests: ExtendScript's regex engine mis-handles alternations that contain ^ / $ groups
        var n = String(it.file ? it.file.name : it.name).toLowerCase().replace(/\.[a-z0-9]+$/, "");
        var words = " " + n.replace(/[^a-z0-9]+/g, " ") + " ";
        var hasWord = function (list) { for (var i = 0; i < list.length; i++) if (words.indexOf(" " + list[i] + " ") >= 0) return true; return false; };
        var hasPart = function (list) { for (var i = 0; i < list.length; i++) if (n.indexOf(list[i]) >= 0) return true; return false; };
        if (hasWord(["vo", "v o", "voiceover"]) || hasPart(["voice", "narrat", "speech", "dialog", "interview", "spoken"])) return "voiceover";
        if (hasWord(["fx", "hit", "pop", "tap", "ding", "beep", "boom"]) || hasPart(["sfx", "whoosh", "swoosh", "swish", "click", "riser", "impact", "transition", "chime", "swipe", "glitch", "blink", "marker"])) return "sfx";
        if (hasPart(["music", "song", "track", "beat", "bgm", "score", "instrumental", "theme", "loop", "mix"])) return "music";
        if (it.duration && it.duration < 4) return "sfx";
        return it.duration && it.duration > 45 ? "music" : "audio";
    }
    function itemDetail(it) {
        var o = { id: it.id, name: it.name, kind: mediaKind(it) };
        var fp = folderPath(it);
        if (fp) o.folder = fp;
        if (it.comment) o.comment = it.comment;
        if (it.label) o.label = it.label;
        if (it instanceof FolderItem) { o.numItems = it.numItems; return o; }
        try { if (it.width) { o.width = it.width; o.height = it.height; } } catch (e) { }
        if (it instanceof CompItem) {
            o.fps = r4(it.frameRate); o.duration = r4(it.duration); o.numLayers = it.numLayers;
            if (it.usedIn && it.usedIn.length) { o.usedIn = []; for (var u = 0; u < it.usedIn.length && u < 10; u++) o.usedIn.push(it.usedIn[u].name); }
            return o;
        }
        if (it instanceof FootageItem) {
            var ms = it.mainSource;
            try { if (it.file) o.file = it.file.fsName; } catch (e2) { }
            if (it.footageMissing) o.missing = true;
            if (ms instanceof SolidSource) { try { o.color = toHex(ms.color); } catch (e3) { } }
            else if (!(ms && ms.isStill)) {
                try { o.duration = r4(it.duration); } catch (e4) { }
                try { if (it.hasVideo) o.fps = r4(it.frameRate); } catch (e5) { }
            }
            o.hasVideo = !!it.hasVideo; o.hasAudio = !!it.hasAudio;
            if (o.kind === "audio") o.role = audioRole(it);
            try { if (ms && ms.hasAlpha) o.alpha = true; } catch (e6) { }
            o.usedIn = it.usedIn ? it.usedIn.length : 0;
        }
        return o;
    }

    H.project_items = function (p) {
        var proj = app.project, out = [], lim = Number(def(p.limit, 400)), i, counts = {}, unused = 0, missing = 0;
        var kinds = p.kind ? (isArr(p.kind) ? p.kind : [p.kind]) : null, q = p.query ? norm(p.query) : null;
        for (i = 1; i <= proj.numItems; i++) {
            var it = proj.item(i), d = itemDetail(it);
            counts[d.kind] = (counts[d.kind] || 0) + 1;
            if (d.usedIn === 0 && d.kind !== "folder") unused++;
            if (d.missing) missing++;
            if (kinds && idxOf(kinds, d.kind) < 0 && !(d.role && idxOf(kinds, d.role) >= 0)) continue;
            if (q && norm(it.name).indexOf(q) < 0 && !(d.file && norm(d.file).indexOf(q) >= 0)) continue;
            if (p.folder !== undefined && norm(d.folder || "") !== norm(p.folder)) continue;
            if (p.unused && !(d.usedIn === 0)) continue;
            if (out.length < lim) out.push(d);
        }
        var ac = proj.activeItem;
        return {
            project: proj.file ? proj.file.fsName : null, numItems: proj.numItems, counts: counts, unusedFootage: unused, missingFootage: missing,
            items: out, truncated: out.length >= lim, activeComp: ac instanceof CompItem ? { id: ac.id, name: ac.name } : null
        };
    };
    NO_UNDO.project_items = 1;

    function folderByPath(pathStr) {
        var parts = String(pathStr).split("/"), parent = app.project.rootFolder, i, j;
        for (i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            var found = null;
            for (j = 1; j <= parent.numItems; j++) { var it = parent.item(j); if (it instanceof FolderItem && it.name === parts[i]) { found = it; break; } }
            if (!found) { found = app.project.items.addFolder(parts[i]); found.parentFolder = parent; }
            parent = found;
        }
        return parent;
    }

    var ORGANIZE_FOLDERS = { comp: "Comps", precomp: "Comps/Precomps", video: "Footage/Video", sequence: "Footage/Sequences", image: "Footage/Images", graphic: "Footage/Graphics", music: "Audio/Music", voiceover: "Audio/Voice-over", sfx: "Audio/SFX", audio: "Audio", solid: "Solids", placeholder: "Footage/Placeholders" };
    H.organize_project = function (p) {
        var proj = app.project, i, k, plan = [], items = [];
        var scope = norm(def(p.scope, "root")); // root: only loose items · all: every item
        var custom = p.folders || {}; // { kind/role: "Folder/Path" }
        var rules = p.rules || [];    // [{ match: "regex on name", folder: "Path" }]
        for (i = 1; i <= proj.numItems; i++) items.push(proj.item(i));
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof FolderItem) continue;
            if (scope === "root" && it.parentFolder !== proj.rootFolder) continue;
            var target = null;
            for (k = 0; k < rules.length && !target; k++) { try { if (new RegExp(rules[k].match, "i").test(it.name)) target = rules[k].folder; } catch (e) { warn("Bad rule regex " + rules[k].match); } }
            if (!target) {
                var kind = mediaKind(it), key = kind === "audio" ? audioRole(it) : kind;
                target = has(custom, key) ? custom[key] : (has(custom, kind) ? custom[kind] : ORGANIZE_FOLDERS[key] || ORGANIZE_FOLDERS[kind]);
            }
            if (!target || folderPath(it) === target) continue;
            plan.push({ id: it.id, name: it.name, from: folderPath(it) || "(root)", to: target, item: it });
        }
        var out = { moved: [], dryRun: !!p.dryRun };
        for (i = 0; i < plan.length; i++) {
            if (!p.dryRun) { try { plan[i].item.parentFolder = folderByPath(plan[i].to); } catch (e2) { warn("Could not move " + plan[i].name + ": " + e2.message); continue; } }
            out.moved.push({ id: plan[i].id, name: plan[i].name, from: plan[i].from, to: plan[i].to });
        }
        if (!p.dryRun) {
            if (p.consolidate) { try { out.consolidated = proj.consolidateFootage(); } catch (e3) { warn("consolidate: " + e3.message); } }
            if (p.removeUnused) { try { out.removedUnused = proj.removeUnusedFootage(); } catch (e4) { warn("removeUnused: " + e4.message); } }
            if (p.removeEmptyFolders !== false) {
                var removed = 0, again = true;
                while (again) {
                    again = false;
                    for (i = proj.numItems; i >= 1; i--) { var f = proj.item(i); if (f instanceof FolderItem && f.numItems === 0) { f.remove(); removed++; again = true; } }
                }
                if (removed) out.removedEmptyFolders = removed;
            }
        }
        return out;
    };

    H.update_item = function (p) {
        var it = findItem(first(p.item, p.id, p.name));
        if (!it) fail("Project item not found: " + first(p.item, p.id, p.name));
        if (p.newName !== undefined || p.rename !== undefined) it.name = String(first(p.newName, p.rename));
        if (p.folder !== undefined) it.parentFolder = p.folder ? folderByPath(p.folder) : app.project.rootFolder;
        if (p.label !== undefined) it.label = Number(p.label);
        if (p.comment !== undefined) it.comment = String(p.comment);
        if (it instanceof FootageItem) {
            if (p.replace) { var f = new File(p.replace); if (!f.exists) fail("File not found: " + p.replace); it.replace(f); }
            var ms = it.mainSource;
            if (p.fps !== undefined && ms) ms.conformFrameRate = Number(p.fps);
            if (p.loop !== undefined && ms) ms.loop = Number(p.loop);
            if (p.alpha !== undefined && ms) { var a = norm(p.alpha); ms.alphaMode = a === "premultiplied" ? AlphaMode.PREMULTIPLIED : (a === "ignore" ? AlphaMode.IGNORE : AlphaMode.STRAIGHT); }
        }
        if (it instanceof CompItem && p.comp) applyCompSettings(it, p.comp, makeCtx(it));
        return itemDetail(it);
    };

    var MEDIA_EXT = /\.(png|jpe?g|gif|bmp|tiff?|tga|exr|dpx|hdr|webp|heic|avif|psd|ai|eps|pdf|svg|mp4|m4v|mov|avi|mkv|mxf|wmv|mpe?g|mts|m2ts|3gp|r3d|braw|wav|wave|mp3|aac|m4a|aiff?|aifc)$/i;
    var KIND_FOLDERS = { image: "Images", graphic: "Graphics", video: "Video", sequence: "Sequences", music: "Music", voiceover: "Voice-over", sfx: "SFX", audio: "Audio" };
    function collectMedia(folder, out, depth) {
        var list = folder.getFiles(), i;
        for (i = 0; i < list.length; i++) {
            if (list[i] instanceof Folder) { if (depth > 0 && !/^\./.test(list[i].name)) collectMedia(list[i], out, depth - 1); }
            else if (MEDIA_EXT.test(list[i].name)) out.push(list[i].fsName);
        }
    }
    // Imports files and whole folders, filing each item under <folder>/<Images|Video|Music|Voice-over|SFX…>
    H.import_files = function (p) {
        var list = p.paths || (p.path ? [p.path] : []), files = [], i;
        if (!list.length) fail("import_files needs \"paths\" (files or folders)");
        for (i = 0; i < list.length; i++) {
            var x = File(list[i]);
            if (x instanceof Folder) { if (!x.exists) { warn("Folder not found: " + list[i]); continue; } collectMedia(x, files, p.recursive === false ? 0 : 6); }
            else files.push(list[i]);
        }
        if (files.length > Number(def(p.maxFiles, 300))) fail(files.length + " files found — pass a smaller folder or raise maxFiles");
        var base = def(p.folder, "Footage"), out = { imported: [], failed: [] };
        for (i = 0; i < files.length; i++) {
            try {
                var it = importFootage(files[i], { reuse: p.reuse !== false });
                var kind = mediaKind(it), key = kind === "audio" ? audioRole(it) : kind;
                // items that were already filed somewhere (re-used) stay where the user put them
                if (it.parentFolder !== app.project.rootFolder) { /* keep */ }
                else if (p.byKind !== false && base) it.parentFolder = folderByPath(base + "/" + (KIND_FOLDERS[key] || "Other"));
                else if (base) it.parentFolder = folderByPath(base);
                out.imported.push(itemDetail(it));
            } catch (e) { out.failed.push({ file: files[i], error: e.message }); }
        }
        return out;
    };

    function footageFor(p) {
        var ref = first(p.item, p.id), it = ref !== undefined ? findItem(ref) : null;
        if (!it && (p.path || p.file)) it = importFootage(first(p.path, p.file), { folder: p.folder ? folderByPath(p.folder) : null });
        if (!it) fail("Footage not found: " + (ref !== undefined ? ref : "(pass item or path)"));
        return it;
    }

    // Amplitude envelope of an audio source (or a comp's mix) via "Convert Audio to Keyframes".
    H.analyze_audio = function (p) {
        var it = footageFor(p);
        if (!(it instanceof CompItem) && !it.hasAudio) fail("\"" + it.name + "\" has no audio");
        var fps = Math.min(120, Math.max(10, Number(def(p.fps, 50))));
        var start = Number(def(p.start, 0)), len = it.duration - start;
        if (p.duration !== undefined) len = Math.min(len, Number(p.duration));
        len = Math.min(len, Number(def(p.maxDuration, 900)));
        if (!(len > 0)) fail("Nothing to analyse (duration " + r4(it.duration) + " s)");
        var prev = app.project.activeItem;
        var tmp = app.project.items.addComp("ClaudeAE audio analysis", 64, 64, 1, len, fps);
        var out;
        try {
            var l = tmp.layers.add(it);
            l.startTime = -start;
            tmp.openInViewer();
            for (var i = 1; i <= tmp.numLayers; i++) tmp.layer(i).selected = false;
            l.selected = true;
            var cmd = app.findMenuCommandId("Convert Audio to Keyframes");
            if (!cmd) fail("After Effects' \"Convert Audio to Keyframes\" command was not found (non-English After Effects?)");
            app.executeCommand(cmd);
            var amp = null;
            for (i = 1; i <= tmp.numLayers; i++) if (tmp.layer(i) !== l && tmp.layer(i).property("ADBE Effect Parade").numProperties >= 3) { amp = tmp.layer(i); break; }
            if (!amp) fail("Convert Audio to Keyframes produced no amplitude layer");
            var fx = amp.property("ADBE Effect Parade");
            var series = function (idx) {
                var s = fx.property(idx).property(1), v = [], k;
                if (s.numKeys) for (k = 1; k <= s.numKeys; k++) v.push(Math.round(s.keyValue(k) * 100) / 100);
                return v;
            };
            out = { name: it.name, id: it.id, file: (it instanceof FootageItem && it.file) ? it.file.fsName : null, role: (it instanceof FootageItem && !it.hasVideo) ? audioRole(it) : null, start: start, duration: r4(len), fps: fps, both: series(fx.numProperties) };
            if (p.stereo) { out.left = series(1); out.right = series(2); }
        } finally {
            try { tmp.remove(); } catch (e) { }
            try { if (prev && prev instanceof CompItem) prev.openInViewer(); } catch (e2) { }
        }
        return out;
    };
    NO_UNDO.analyze_audio = 1;

    // A frame of footage (or a comp) as PNG, at most maxSize px on the long side.
    H.footage_frame = function (p) {
        var it = footageFor(p);
        if (!p.output) fail("footage_frame needs \"output\" (PNG path)");
        if (!(it instanceof CompItem) && !it.hasVideo) fail("\"" + it.name + "\" has no picture (audio only)");
        var w = it.width, h = it.height, max = Number(def(p.maxSize, 1280)), k = Math.min(1, max / Math.max(w, h));
        var cw = Math.max(4, Math.round(w * k)), ch = Math.max(4, Math.round(h * k));
        var dur = it.duration > 0 ? it.duration : 1;
        var fr = it.frameRate > 0 ? it.frameRate : 30;
        var tmp = app.project.items.addComp("ClaudeAE preview", cw, ch, 1, Math.max(dur, 1 / fr), fr);
        try {
            var l = tmp.layers.add(it);
            l.property("ADBE Transform Group").property("ADBE Scale").setValue([k * 100, k * 100]);
            var t = Math.max(0, Math.min(Number(def(p.time, 0)), dur - 1 / fr));
            var f = new File(p.output);
            if (f.exists) f.remove();
            tmp.saveFrameToPng(t, f);
            return { path: f.fsName, time: r4(t), width: cw, height: ch, source: itemDetail(it) };
        } finally { try { tmp.remove(); } catch (e) { } }
    };
    NO_UNDO.footage_frame = 1;

    H.import_motion = function (p) {
        var spec = p.spec;
        if (typeof spec === "string") spec = jsonParse(spec);
        if (!isObj(spec)) fail("import_motion needs \"spec\" (a Claude Motion JSON object)");
        var comps = spec.compositions || spec.comps;
        if (!comps && spec.layers) { comps = [{ id: "main", name: def(spec.name, "Claude Motion"), width: spec.width, height: spec.height, fps: first(spec.fps, spec.frameRate), duration: spec.duration, backgroundColor: first(spec.backgroundColor, spec.bgColor), layers: spec.layers, markers: spec.markers }]; }
        if (!comps || !comps.length) fail("Motion spec has no \"compositions\"");
        var mode = norm(def(p.mode, p.comp !== undefined || p.target !== undefined ? "precomp" : "new"));
        var target = (mode === "precomp" || mode === "flatten") ? findComp(first(p.target, p.comp)) : null;
        var rootName = def(first(p.folderName, spec.name), "Claude Motion");
        var folder = p.folder === false ? null : uniqueFolder(rootName);
        var assetFolder = null;
        var assets = {}, i;
        var defaultEase = first(p.defaultEase, spec.defaultEase);
        if (spec.assets) {
            for (i = 0; i < spec.assets.length; i++) {
                var a = spec.assets[i];
                try {
                    if (!a.path) fail("asset \"" + a.id + "\" has no local path (url/data assets are resolved by the bridge)");
                    if (folder && !assetFolder) { assetFolder = app.project.items.addFolder("Assets"); assetFolder.parentFolder = folder; }
                    assets[a.id] = importFootage(a.path, { sequence: a.sequence, as: a.importAs, name: a.name, folder: assetFolder, fps: a.fps });
                } catch (e) { warn("Asset \"" + a.id + "\": " + e.message); }
            }
        }
        var compIds = [];
        for (i = 0; i < comps.length; i++) compIds.push(String(def(comps[i].id, comps[i].name || ("comp" + i))));
        var mainId = String(def(spec.main, compIds[0]));
        var compItems = {}, created = [];
        // pass 1: create every comp up front so precomp layers can reference any of them
        for (i = 0; i < comps.length; i++) {
            var cs = comps[i], cid = compIds[i];
            if (mode === "flatten" && cid === String(mainId)) { compItems[cid] = target; continue; }
            var c = newComp(cs, folder);
            compItems[cid] = c;
            created.push({ id: cid, comp: c, spec: cs });
        }
        // pass 2: fill layers (children first is not required since comps already exist)
        var total = 0;
        for (i = 0; i < comps.length; i++) {
            var s2 = comps[i], id2 = compIds[i], comp = compItems[id2];
            var flat = mode === "flatten" && id2 === String(mainId);
            var offset = flat ? parseTime(def(first(p.time, p.at), comp.time), comp.frameRate) : 0;
            var dur = parseTime(def(s2.duration, 10), Number(def(first(s2.fps, s2.frameRate), comp.frameRate)));
            var ctx = makeCtx(comp, { comps: compItems, assets: assets, defaultEase: first(s2.defaultEase, defaultEase), offset: offset, defaultIn: flat ? offset : undefined, defaultOut: flat ? offset + dur : undefined, folder: assetFolder || folder });
            if (!flat) applyCompSettings(comp, { workAreaStart: s2.workAreaStart, workAreaDuration: s2.workAreaDuration, motionBlur: s2.motionBlur, shutterAngle: s2.shutterAngle, displayStartTime: s2.displayStartTime, markers: s2.markers, renderer: s2.renderer }, ctx);
            else if (s2.markers) addMarkers(comp, s2.markers, ctx);
            var res = buildLayers(comp, def(s2.layers, []), ctx, flat ? { index: p.index, above: p.above, below: p.below } : null);
            total += res.length;
        }
        var out = { folder: folder ? folder.name : null, comps: [], layersCreated: total, mode: mode };
        for (i = 0; i < created.length; i++) out.comps.push({ id: created[i].id, itemId: created[i].comp.id, name: created[i].comp.name });
        var main = compItems[String(mainId)];
        if (!main) fail("Main composition \"" + mainId + "\" not found in spec");
        out.main = { itemId: main.id, name: main.name };
        if (mode === "precomp") {
            var pctx = makeCtx(target, {});
            var t0 = def(first(p.time, p.at), target.time);
            var lr = buildLayers(target, [{ type: "precomp", comp: main.id, name: def(p.layerName, main.name), inPoint: t0 }], pctx, { index: p.index, above: p.above, below: p.below });
            out.layer = lr[0];
            out.target = { id: target.id, name: target.name };
        }
        if (p.open !== false) { try { (mode === "new" ? main : (target || main)).openInViewer(); } catch (e2) { } }
        return out;
    };

    H.add_markers = function (p) {
        var comp = findComp(p.comp), ctx = makeCtx(comp);
        var target = p.layer !== undefined ? findLayer(comp, p.layer) : comp;
        addMarkers(target, p.markers || [p], ctx);
        return { target: p.layer !== undefined ? target.name : comp.name, count: (p.markers || [p]).length };
    };

    H.precompose = function (p) {
        var comp = findComp(p.comp), refs = p.layers, idx = [], i;
        if (!refs || !refs.length) fail("precompose needs \"layers\"");
        for (i = 0; i < refs.length; i++) idx.push(findLayer(comp, refs[i]).index);
        var nc = comp.layers.precompose(idx, String(def(p.name, "Pre-comp")), p.moveAllAttributes !== false);
        if (p.open) { try { nc.openInViewer(); } catch (e) { } }
        return { comp: { id: nc.id, name: nc.name, numLayers: nc.numLayers } };
    };

    H.render_frame = function (p) {
        var comp = findComp(p.comp);
        var t = p.time !== undefined ? parseTime(p.time, comp.frameRate) : comp.time;
        if (!p.path) fail("render_frame needs \"path\"");
        var f = new File(p.path);
        if (f.exists) f.remove();
        comp.saveFrameToPng(t, f);
        return { path: f.fsName, time: r4(t), width: comp.width, height: comp.height, comp: comp.name, bgColor: toHex(comp.bgColor) };
    };
    NO_UNDO.render_frame = 1;

    H.render = function (p) {
        var comp = findComp(p.comp);
        if (!p.output) fail("render needs \"output\" (file path)");
        var rq = app.project.renderQueue, item = rq.items.add(comp);
        var om = item.outputModule(1);
        if (p.template) { try { om.applyTemplate(String(p.template)); } catch (e) { warn("Output module template \"" + p.template + "\" not found"); } }
        if (p.renderTemplate) { try { item.applyTemplate(String(p.renderTemplate)); } catch (e2) { warn("Render settings template \"" + p.renderTemplate + "\" not found"); } }
        om.file = new File(p.output);
        if (p.workAreaOnly === false) { try { item.timeSpanStart = 0; item.timeSpanDuration = comp.duration; } catch (e3) { } }
        var out = { queued: true, index: item.index, output: om.file.fsName, templates: [] };
        try { out.templates = om.templates; } catch (e4) { }
        if (p.start) { rq.render(); out.rendered = true; }
        return out;
    };
    NO_UNDO.render = 1;

    H.save_project = function (p) {
        if (p.path) app.project.save(new File(p.path));
        else if (app.project.file) app.project.save();
        else fail("Project has never been saved — pass \"path\" (e.g. C:/Projects/my.aep)");
        return { path: app.project.file ? app.project.file.fsName : null };
    };
    NO_UNDO.save_project = 1;

    H.select_layers = function (p) {
        var comp = findComp(p.comp), i;
        if (p.only !== false) for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        var refs = p.layers || [];
        for (i = 0; i < refs.length; i++) findLayer(comp, refs[i]).selected = true;
        return { selected: refs.length };
    };
    NO_UNDO.select_layers = 1;

    H.apply_preset = function (p) {
        var comp = findComp(p.comp), l = findLayer(comp, p.layer), f = new File(p.path);
        if (!f.exists) fail("Preset not found: " + p.path);
        l.applyPreset(f);
        return layerSummary(l);
    };

    H.run_script = function (p) {
        if (!p.code) fail("run_script needs \"code\"");
        var __result = eval(String(p.code));
        return serializeAny(__result, 0);
    };

    H.undo = function (p) {
        var n = Number(def(p.steps, 1));
        for (var i = 0; i < n; i++) app.executeCommand(16);
        return { undone: n };
    };
    NO_UNDO.undo = 1;

    H.batch = function (p) {
        var cmds = p.commands || [], out = [], i;
        for (i = 0; i < cmds.length; i++) {
            var c = cmds[i], h = H[c.method];
            if (!h || c.method === "batch") { out.push({ ok: false, error: "Unknown method " + c.method }); if (p.stopOnError !== false) break; continue; }
            try { out.push({ ok: true, result: h(c.params || {}) }); }
            catch (e) { out.push({ ok: false, error: e.message }); if (p.stopOnError !== false) break; }
        }
        return { results: out };
    };

    H.context = function () {
        var ac = app.project.activeItem, o = { project: app.project.file ? app.project.file.name : "Untitled Project", numItems: app.project.numItems };
        if (ac instanceof CompItem) {
            o.activeComp = { id: ac.id, name: ac.name, width: ac.width, height: ac.height, fps: r4(ac.frameRate), duration: r4(ac.duration), time: r4(ac.time), numLayers: ac.numLayers };
            var sel = ac.selectedLayers, i;
            if (sel.length) { o.selectedLayers = []; for (i = 0; i < sel.length && i < 20; i++) o.selectedLayers.push({ index: sel[i].index, name: sel[i].name, type: layerType(sel[i]) }); }
            var sp = ac.selectedProperties;
            if (sp && sp.length) { o.selectedProperties = []; for (i = 0; i < sp.length && i < 20; i++) { try { if (sp[i].propertyType === PropertyType.PROPERTY) o.selectedProperties.push({ layer: sp[i].propertyGroup(sp[i].propertyDepth).name, path: displayPath(sp[i]) }); } catch (e) { } } if (!o.selectedProperties.length) delete o.selectedProperties; }
        } else if (ac) o.activeItem = { id: ac.id, name: ac.name, type: itemType(ac) };
        return o;
    };
    NO_UNDO.context = 1;

    H.describe = function () { var m = []; for (var k in H) if (has(H, k)) m.push(k); return { version: VERSION, methods: m }; };
    NO_UNDO.describe = 1;

    /* ===================================================== dispatcher */
    function call(method, params) {
        warnings = [];
        caches.fonts = null;
        var h = H[method];
        if (!h) fail("Unknown method \"" + method + "\"");
        var undo = !NO_UNDO[method];
        var suppressed = false;
        try { app.beginSuppressDialogs(); suppressed = true; } catch (e0) { }
        if (undo) app.beginUndoGroup("Claude: " + method);
        try { return h(params || {}); }
        finally {
            if (undo) { try { app.endUndoGroup(); } catch (e1) { } }
            if (suppressed) { try { app.endSuppressDialogs(false); } catch (e2) { } }
        }
    }

    function run(json) {
        var req;
        try { req = typeof json === "string" ? jsonParse(json) : json; }
        catch (e) { return jsonStringify({ ok: false, error: { message: "Invalid request JSON: " + e.message }, warnings: [] }); }
        try {
            var result = call(req.method, req.params);
            return jsonStringify({ ok: true, result: result === undefined ? null : result, warnings: warnings });
        } catch (err) {
            return jsonStringify({ ok: false, error: { message: err && err.message ? err.message : String(err), line: err && err.line, method: req && req.method }, warnings: warnings });
        }
    }

    // Large requests are passed through a UTF-8 file instead of an evalScript string literal.
    function runFile(path) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("r")) return jsonStringify({ ok: false, error: { message: "Cannot read request file " + path }, warnings: [] });
        var s = f.read();
        f.close();
        return run(s);
    }

    return {
        version: VERSION, run: run, runFile: runFile, call: call, handlers: H, json: { stringify: jsonStringify, parse: jsonParse },
        util: {
            findComp: findComp, findLayer: findLayer, resolveProp: resolveProp, applyValue: applyValue,
            parseColor: parseColor, parseTime: parseTime, makeCtx: makeCtx, buildLayers: buildLayers, layerSummary: layerSummary, resolveFont: resolveFont
        }
    };
})();

// Value of the last expression is returned to evalScript callers.
"ClaudeAE " + ClaudeAE.version + " loaded";
