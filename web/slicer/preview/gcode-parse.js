/**
 * G-code toolpath parser for the slice preview: which lines the nozzle draws on
 * each layer, by feature (outer wall, infill, ...), and the travel moves between.
 *
 * Ported from the CraftBot-2-slicer project's src/lib/gcode-parse.ts (itself
 * from OrcaWeb, AGPL-3.0). Changes for this site:
 *   - coordinates stay in bed millimetres (no re-centring), so the preview can
 *     draw the real bed under the paths;
 *   - only what's printed on the plate is kept: everything before the first
 *     layer marker (heating, levelling, purge line, nozzle wipe) and after the
 *     engine's "; filament end gcode" marker (end routine) is skipped, as Bambu
 *     Studio's own preview does;
 *   - each layer also records its first-move index, for "show one layer".
 *
 * Understands OrcaSlicer's two dialects: ";LAYER_CHANGE"/";Z:"/";TYPE:" and
 * Bambu's "; CHANGE_LAYER"/"; Z_HEIGHT:"/"; FEATURE:"; absolute and relative
 * extrusion (M82/M83), G92 resets and G2/G3 arcs.
 *
 * @typedef {{ type: string, segments: Float32Array }} Feature   x0,y0,z0,x1,y1,z1 per segment
 * @typedef {{ z: number, features: Feature[], travels: Float32Array }} Layer
 * @typedef {{ layers: Layer[], bounds: number[], hasFeatureTypes: boolean, types: string[] }} ParseResult
 */

/**
 * A G2/G3 arc as straight waypoints (flat x,y,z triples, excluding the start,
 * ending exactly on the target). I/J (centre offset) and R (radius) forms; the
 * R-form centre follows GRBL's plan_arc. Z is interpolated (helical moves).
 */
export function tessellateArc(sx, sy, sz, ex, ey, ez, i, j, r, clockwise) {
  let ox, oy;
  if (i !== null || j !== null) {
    ox = sx + (i ?? 0);
    oy = sy + (j ?? 0);
  } else if (r !== null && r !== 0) {
    const dx = ex - sx, dy = ey - sy;
    const dSq = dx * dx + dy * dy;
    const hFactorSq = 4 * r * r - dSq;
    if (dSq === 0 || hFactorSq < 0) return [ex, ey, ez];      // degenerate: a chord
    let h = -Math.sqrt(hFactorSq) / Math.sqrt(dSq);
    if (!clockwise) h = -h;
    if (r < 0) h = -h;
    ox = sx + 0.5 * (dx - dy * h);
    oy = sy + 0.5 * (dy + dx * h);
  } else {
    return [ex, ey, ez];
  }
  const radius = Math.hypot(sx - ox, sy - oy);
  if (radius < 1e-9) return [ex, ey, ez];
  const a0 = Math.atan2(sy - oy, sx - ox);
  const a1 = Math.atan2(ey - oy, ex - ox);
  let sweep = a1 - a0;
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;
  if (Math.abs(sweep) < 1e-9 && Math.hypot(ex - sx, ey - sy) < 1e-9) sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
  // ~0.5 mm chords, at most 64
  const steps = Math.min(64, Math.max(2, Math.ceil((Math.abs(sweep) * radius) / 0.5)));
  const out = [];
  for (let s = 1; s < steps; s++) {
    const a = a0 + sweep * (s / steps);
    out.push(ox + radius * Math.cos(a), oy + radius * Math.sin(a), sz + (ez - sz) * (s / steps));
  }
  out.push(ex, ey, ez);
  return out;
}

const LAYER_RE = /^;\s*(LAYER_CHANGE|CHANGE_LAYER)\b/i;
const END_RE = /^;\s*filament end gcode/i;

/** @returns {ParseResult} */
export function parseGcode(gcode) {
  // With layer markers, the slicer says where each layer starts (authoritative
  // even in vase mode). Without, moves are bucketed by their starting Z.
  // (the first marker comes after the header and start routine, well inside 1 MB)
  const hasLayerMarkers = /^;\s*(LAYER_CHANGE|CHANGE_LAYER)\b/im.test(gcode.slice(0, 1 << 20));
  const markerLayers = [];
  const layerMap = new Map();
  let cur = null;
  let started = !hasLayerMarkers;        // skip the start routine when markers say where printing begins
  let cx = 0, cy = 0, cz = 0, ce = 0;
  let relative = false, extrusionRelative = false;
  let feature = '';
  let hasFeatureTypes = false;
  const types = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = 0;

  const layerFor = (z0) => {
    if (hasLayerMarkers) return cur;
    const key = Math.round(z0 * 1000) / 1000;
    let acc = layerMap.get(key);
    if (!acc) { acc = { z: key, features: new Map(), travels: [] }; layerMap.set(key, acc); }
    return acc;
  };

  const addSegment = (travel, x0, y0, z0, x1, y1, z1) => {
    if (!started) return;
    if (!hasLayerMarkers && z0 !== z1) return;   // z-hops/spirals have no layer to belong to
    const ld = layerFor(z0);
    if (!ld) return;
    if (travel) { ld.travels.push(x0, y0, z0, x1, y1, z1); return; }
    const ft = feature || 'Extrusion';
    if (ft === 'Custom') return;                 // start/end routine extrusions (purge, wipe)
    let arr = ld.features.get(ft);
    if (!arr) { arr = []; ld.features.set(ft, arr); types.add(ft); }
    arr.push(x0, y0, z0, x1, y1, z1);
    if (x0 < minX) minX = x0; if (x1 < minX) minX = x1; if (x0 > maxX) maxX = x0; if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0; if (y1 < minY) minY = y1; if (y0 > maxY) maxY = y0; if (y1 > maxY) maxY = y1;
    if (z1 > maxZ) maxZ = z1;
  };

  // indexOf/slice, not split('\n'): a multi-MB file as millions of strings at once
  // costs a lot of memory in the worker.
  let pos = 0;
  while (pos < gcode.length) {
    let nl = gcode.indexOf('\n', pos);
    if (nl === -1) nl = gcode.length;
    let raw = gcode.slice(pos, nl);
    pos = nl + 1;
    if (raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);   // CRLF

    if (raw.charCodeAt(0) === 59 /* ; */) {
      const tm = raw.match(/^;\s*(?:TYPE|FEATURE):\s*(.+)/i);
      if (tm) { feature = tm[1].trim(); hasFeatureTypes = true; continue; }
      if (hasLayerMarkers) {
        if (LAYER_RE.test(raw)) {
          started = true;
          cur = { z: NaN, features: new Map(), travels: [] };
          markerLayers.push(cur);
          continue;
        }
        if (END_RE.test(raw)) break;
        if (cur && Number.isNaN(cur.z)) {
          const zm = raw.match(/^;\s*Z(?:_HEIGHT)?:\s*([\d.]+)/i);
          if (zm) cur.z = parseFloat(zm[1]);
        }
      }
      continue;
    }

    const semi = raw.indexOf(';');
    const line = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
    if (!line) continue;
    const cmd = line.split(/\s+/);
    const g = cmd[0].toUpperCase();
    if (g === 'G91') { relative = true; continue; }
    if (g === 'G90') { relative = false; continue; }
    if (g === 'M83') { extrusionRelative = true; continue; }
    if (g === 'M82') { extrusionRelative = false; continue; }
    if (g === 'G92') {
      for (let k = 1; k < cmd.length; k++) {
        const c = cmd[k][0]?.toUpperCase(), v = parseFloat(cmd[k].slice(1));
        if (Number.isNaN(v)) continue;
        if (c === 'X') cx = v; else if (c === 'Y') cy = v; else if (c === 'Z') cz = v; else if (c === 'E') ce = v;
      }
      continue;
    }
    const linear = g === 'G0' || g === 'G1';
    const arc = g === 'G2' || g === 'G3';
    if (!linear && !arc) continue;

    let nx = cx, ny = cy, nz = cz, hasXY = false, hasE = false, e = 0, ai = null, aj = null, ar = null;
    for (let k = 1; k < cmd.length; k++) {
      const c = cmd[k][0]?.toUpperCase(), v = parseFloat(cmd[k].slice(1));
      if (Number.isNaN(v)) continue;
      if (c === 'X') { nx = relative ? cx + v : v; hasXY = true; }
      else if (c === 'Y') { ny = relative ? cy + v : v; hasXY = true; }
      else if (c === 'Z') nz = relative ? cz + v : v;
      else if (c === 'E') { e = v; hasE = true; }
      else if (c === 'I') ai = v;            // arc centre offsets: always relative to the start
      else if (c === 'J') aj = v;
      else if (c === 'R') ar = v;
    }
    const nextE = hasE ? (extrusionRelative ? ce + e : e) : ce;
    const delta = hasE ? (extrusionRelative ? e : nextE - ce) : 0;
    const travel = g === 'G0' || delta <= 0;

    if (linear) {
      if (hasXY) addSegment(travel, cx, cy, cz, nx, ny, nz);
    } else if (hasXY || ai !== null || aj !== null) {
      const w = tessellateArc(cx, cy, cz, nx, ny, nz, ai, aj, ar, g === 'G2');
      let px = cx, py = cy, pz = cz;
      for (let k = 0; k < w.length; k += 3) {
        addSegment(travel, px, py, pz, w[k], w[k + 1], w[k + 2]);
        px = w[k]; py = w[k + 1]; pz = w[k + 2];
      }
    }
    cx = nx; cy = ny; cz = nz; ce = nextE;
  }

  const accs = hasLayerMarkers
    ? markerLayers.filter((l) => l.features.size > 0)
    : [...layerMap.values()].filter((l) => l.features.size > 0).sort((a, b) => a.z - b.z);
  const layers = accs.map((d) => {
    const features = [...d.features.entries()].map(([type, pts]) => ({ type, segments: new Float32Array(pts) }));
    const travels = new Float32Array(d.travels);
    const z = Number.isNaN(d.z) ? (features[0]?.segments[2] ?? 0) : d.z;
    return { z, features, travels };
  });
  const bounds = Number.isFinite(minX) ? [minX, minY, 0, maxX, maxY, maxZ] : [0, 0, 0, 0, 0, 0];
  return { layers, bounds, hasFeatureTypes, types: [...types] };
}
