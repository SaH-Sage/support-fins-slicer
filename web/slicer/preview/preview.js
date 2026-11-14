/**
 * Slice preview: the sliced toolpaths layer by layer, on the printer's bed,
 * coloured by what each line is (outer wall, infill, ...). Opens over the Slice
 * dialog when a slice finishes, like Bambu Studio's Preview tab.
 *
 *   openPreview({ gcode, bed: [x, y], title, stats, onSave, onSavePlain })
 *
 * Its own three.js renderer in its own <dialog>, so it never touches the site's
 * 3D view. The G-code is parsed in a worker (parse-worker.js).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from './lines/LineMaterial.js';
import { LineSegments2 } from './lines/LineSegments2.js';
import { LineSegmentsGeometry } from './lines/LineSegmentsGeometry.js';
import { t } from '../../ui/i18n.js';

// Feature colours, close to the ones slicers usually use. Unknown types get DEFAULT.
const COLORS = {
  'Outer wall': 0xff8a3d,
  'Inner wall': 0xffd166,
  'Overhang wall': 0x3b82f6,
  'Sparse infill': 0xb83280,
  'Internal solid infill': 0xa855f7,
  'Top surface': 0xef4444,
  'Bottom surface': 0x84cc16,
  'Bridge': 0x22d3ee,
  'Internal Bridge': 0x22d3ee,
  'Bridge infill': 0x22d3ee,
  'Gap infill': 0xf8fafc,
  'Floating vertical shell': 0x94a3b8,
  'Ironing': 0xfb7185,
  'Support': 0x22c55e,
  'Support interface': 0x16a34a,
  'Skirt': 0x14b8a6, 'Brim': 0x14b8a6, 'Skirt/Brim': 0x14b8a6,
  'Prime tower': 0xe2e8f0,
};
const DEFAULT = 0x818cf8;
// legend order
const ORDER = ['Outer wall', 'Inner wall', 'Overhang wall', 'Top surface', 'Bottom surface', 'Internal solid infill',
  'Sparse infill', 'Bridge', 'Internal Bridge', 'Bridge infill', 'Gap infill', 'Floating vertical shell', 'Ironing',
  'Support', 'Support interface', 'Skirt', 'Brim', 'Skirt/Brim', 'Prime tower'];

let dlg = null;
let parseWorker = null;
let parseId = 0;
let cache = { gcode: null, result: null };   // the last parse, so reopening is instant
let view = null;                             // the live scene, while open

function markup() {
  if (dlg) return;
  dlg = document.createElement('dialog');
  dlg.id = 'slice-preview';
  dlg.innerHTML = `
    <div class="pv-bar">
      <h2>${t('Preview')}</h2>
      <span class="pv-stats" id="pv-stats"></span>
      <span class="pv-grow"></span>
      <button type="button" class="btn primary" id="pv-save">${t('Save for USB stick')}</button>
      <button type="button" class="btn" id="pv-plain" title="${t('Plain .gcode instead')}">.gcode</button>
      <button type="button" class="pv-x" id="pv-close" aria-label="${t('Close')}">×</button>
    </div>
    <div class="pv-main">
      <div class="pv-canvas" id="pv-canvas"><p class="pv-msg" id="pv-msg"></p></div>
      <div class="pv-side">
        <span class="pv-layer" id="pv-layer"></span>
        <input type="range" id="pv-slider" min="1" max="1" value="1" aria-label="${t('Layer')}">
      </div>
      <details class="pv-legend" id="pv-legend">
        <summary>${t('Legend')}</summary>
        <div id="pv-types"></div>
        <label><input type="checkbox" id="pv-only"> ${t('Only this layer')}</label>
        <label><input type="checkbox" id="pv-travel"> ${t('Travel moves')}</label>
      </details>
    </div>`;
  document.body.append(dlg);
  dlg.querySelector('#pv-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', teardown);
  const slider = dlg.querySelector('#pv-slider');
  slider.addEventListener('input', () => view && show(Number(slider.value)));
  dlg.querySelector('#pv-only').addEventListener('change', () => view && show(view.top));
  dlg.querySelector('#pv-travel').addEventListener('change', () => view && show(view.top));
  dlg.addEventListener('keydown', (e) => {
    if (!view) return;
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (step && e.target !== slider) { e.preventDefault(); show(view.top + step); }
    else if (e.key === 'Home') { e.preventDefault(); show(1); }
    else if (e.key === 'End') { e.preventDefault(); show(view.layers.length); }
  });
}

function parse(gcode) {
  if (cache.gcode === gcode && cache.result) return Promise.resolve(cache.result);
  parseWorker ??= new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
  const id = ++parseId;
  return new Promise((resolve, reject) => {
    parseWorker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.error) { reject(new Error(data.error)); return; }
      cache = { gcode, result: data.result };
      resolve(data.result);
    };
    parseWorker.onerror = (e) => reject(new Error(e.message || 'G-code could not be read'));
    const copy = gcode.slice();               // the slice result keeps its own bytes
    parseWorker.postMessage({ id, gcode: copy.buffer }, [copy.buffer]);
  });
}

/**
 * @param {{ gcode: Uint8Array, bed: number[], stats: string, onSave: () => void, onSavePlain: () => void }} o
 */
export async function openPreview({ gcode, bed, stats, onSave, onSavePlain }) {
  markup();
  teardown();
  dlg.querySelector('#pv-stats').textContent = stats;
  dlg.querySelector('#pv-save').onclick = onSave;
  dlg.querySelector('#pv-plain').onclick = onSavePlain;
  const msg = dlg.querySelector('#pv-msg');
  msg.hidden = false;
  msg.textContent = t('Reading the toolpaths…');
  // the legend starts open where there's room for it beside the print
  dlg.querySelector('#pv-legend').open = window.matchMedia('(min-width: 641px)').matches;
  if (!dlg.open) dlg.showModal();
  let result;
  try {
    result = await parse(gcode);
  } catch (err) {
    msg.textContent = `${t('The preview could not read the G-code.')} ${err.message}`;
    return;
  }
  if (!dlg.open) return;
  if (!result.layers.length) { msg.textContent = t('Nothing to show: the G-code has no printed layers.'); return; }
  try {
    build(result, bed);
    msg.hidden = true;
  } catch (err) {
    msg.textContent = `${t('This browser can’t show the 3D preview.')} (${err.message})`;
  }
}

function build(result, [bx, by]) {
  const host = dlg.querySelector('#pv-canvas');
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);          // drawing buffer only: CSS sizes the canvas
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.5, 5000);
  camera.up.set(0, 0, 1);
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };

  // the bed: plate, 10 mm grid, edge
  const plate = new THREE.Mesh(keep(new THREE.PlaneGeometry(bx, by)), keep(new THREE.MeshBasicMaterial({ color: 0x23272f })));
  plate.position.set(bx / 2, by / 2, -0.05);
  scene.add(plate);
  const grid = [];
  for (let x = 0; x <= bx + 1e-6; x += 10) grid.push(x, 0, 0, x, by, 0);
  for (let y = 0; y <= by + 1e-6; y += 10) grid.push(0, y, 0, bx, y, 0);
  const gridGeo = keep(new THREE.BufferGeometry());
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  scene.add(new THREE.LineSegments(gridGeo, keep(new THREE.LineBasicMaterial({ color: 0x323844 }))));

  // toolpaths: one thick-line object per feature type, segments in layer order,
  // ends[type][i] = segments through layer i -> draw layers 1..top with instanceCount
  const layers = result.layers;
  const types = [...new Set(layers.flatMap((l) => l.features.map((f) => f.type)))]
    .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const mat = keep(new LineMaterial({ linewidth: 2, worldUnits: false, vertexColors: true,
    resolution: new THREE.Vector2(w, h) }));
  const byType = new Map();
  for (const type of types) {
    let n = 0;
    for (const l of layers) for (const f of l.features) if (f.type === type) n += f.segments.length;
    const pos = new Float32Array(n);
    const ends = [];
    let at = 0;
    for (const l of layers) {
      for (const f of l.features) if (f.type === type) { pos.set(f.segments, at); at += f.segments.length; }
      ends.push(at / 6);
    }
    const geo = keep(new LineSegmentsGeometry());
    geo.setPositions(pos);
    geo.setColors(shaded(pos, COLORS[type] ?? DEFAULT));
    const m = keep(mat.clone());
    const obj = new LineSegments2(geo, m);
    obj.frustumCulled = false;
    scene.add(obj);
    byType.set(type, { obj, ends, mat: m, shown: true });
  }

  // travel moves: thin lines, with per-layer ends for draw ranges
  let tn = 0;
  for (const l of layers) tn += l.travels.length;
  const tpos = new Float32Array(tn);
  const tends = [];
  let ta = 0;
  for (const l of layers) { tpos.set(l.travels, ta); ta += l.travels.length; tends.push(ta / 3); }
  const tgeo = keep(new THREE.BufferGeometry());
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  const travel = new THREE.LineSegments(tgeo, keep(new THREE.LineBasicMaterial({ color: 0x7c8799, transparent: true, opacity: 0.45 })));
  travel.frustumCulled = false;
  scene.add(travel);

  // the current layer's height, as a faint plane
  const [x0, y0, , x1, y1, z1] = result.bounds;
  const cursor = new THREE.Mesh(keep(new THREE.PlaneGeometry(x1 - x0 + 10, y1 - y0 + 10)),
    keep(new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide })));
  cursor.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
  scene.add(cursor);

  // camera: from the front-right, looking at the print
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.max(30, Math.hypot(x1 - x0, y1 - y0, z1) * 0.9);
  controls.target.set(cx, cy, z1 / 3);
  camera.position.set(cx + r * 0.9, cy - r * 1.5, z1 / 3 + r * 1.1);
  controls.update();

  // legend: one switch per feature type
  const box = dlg.querySelector('#pv-types');
  box.textContent = '';
  for (const type of types) {
    const label = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    const sw = document.createElement('span');
    sw.className = 'pv-chip';
    sw.style.background = `#${(COLORS[type] ?? DEFAULT).toString(16).padStart(6, '0')}`;
    label.append(cb, sw, document.createTextNode(` ${t(type)}`));
    cb.addEventListener('change', () => { byType.get(type).shown = cb.checked; show(view.top); });
    box.append(label);
  }

  let raf = 0;
  const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
  loop();
  const ro = new ResizeObserver(() => {
    const rw = Math.max(1, host.clientWidth), rh = Math.max(1, host.clientHeight);
    camera.aspect = rw / rh;
    camera.updateProjectionMatrix();
    renderer.setSize(rw, rh, false);
    for (const v of byType.values()) v.mat.resolution.set(rw, rh);
    view?.oneMat.resolution.set(rw, rh);
  });
  ro.observe(host);

  // "only this layer": the one layer as its own small object, rebuilt as it changes
  const oneMat = keep(new LineMaterial({ linewidth: 2, worldUnits: false, vertexColors: true,
    resolution: new THREE.Vector2(w, h) }));
  view = { layers, byType, travel, tends, cursor, top: layers.length, renderer, controls, ro, scene,
    oneMat, one: null, stop: () => cancelAnimationFrame(raf), disposables };
  const slider = dlg.querySelector('#pv-slider');
  slider.max = String(layers.length);
  show(layers.length);
  slider.focus();
}

/** Show layers 1..top (or only `top`), with the hidden feature types left out. */
function show(top) {
  const v = view;
  const n = v.layers.length;
  top = Math.max(1, Math.min(n, Math.round(top)));
  v.top = top;
  const only = dlg.querySelector('#pv-only').checked;
  for (const it of v.byType.values()) {
    it.obj.geometry.instanceCount = it.ends[top - 1];
    it.obj.visible = it.shown && !only;
  }
  if (v.one) { v.scene.remove(v.one); v.one.geometry.dispose(); v.one = null; }
  if (only) v.one = layerObject(v, top - 1);
  const tFrom = only && top > 1 ? v.tends[top - 2] : 0;
  v.travel.visible = dlg.querySelector('#pv-travel').checked;
  v.travel.geometry.setDrawRange(tFrom, v.tends[top - 1] - tFrom);
  const z = v.layers[top - 1].z;
  v.cursor.position.z = z + 0.01;
  v.cursor.visible = top < n;
  dlg.querySelector('#pv-slider').value = String(top);
  const label = dlg.querySelector('#pv-layer');
  label.replaceChildren(Object.assign(document.createElement('b'), { textContent: `${top} / ${n}` }),
    document.createElement('br'), `${z.toFixed(2)} mm`);
  label.title = `${t('Layer')} ${top} / ${n}`;
}

/**
 * Per-vertex colours for segments of one colour, lit by which way each line
 * faces: a wall's lines run along its surface, so the line's sideways normal in
 * XY is the wall's normal. Lit from the front-left, as the camera sees it.
 * Without this every wall is one flat colour and the shape is hard to read.
 */
const LIGHT = (() => { const x = -0.55, y = -0.83, l = Math.hypot(x, y); return [x / l, y / l]; })();
function shaded(seg, hex) {
  const c = new THREE.Color(hex);
  const out = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i += 6) {
    const dx = seg[i + 3] - seg[i], dy = seg[i + 4] - seg[i + 1];
    const len = Math.hypot(dx, dy);
    // outward normal of a counter-clockwise loop is (dy, -dx)
    const d = len > 1e-9 ? (dy * LIGHT[0] - dx * LIGHT[1]) / len : 0;
    const k = 0.5 + 0.5 * (0.5 + 0.5 * d);           // 0.5 .. 1.0
    for (let v = 0; v < 6; v += 3) { out[i + v] = c.r * k; out[i + v + 1] = c.g * k; out[i + v + 2] = c.b * k; }
  }
  return out;
}

/** One layer's shown feature types as a single vertex-coloured object. */
function layerObject(v, li) {
  const feats = v.layers[li].features.filter((f) => v.byType.get(f.type)?.shown);
  const n = feats.reduce((k, f) => k + f.segments.length, 0);
  if (!n) return null;
  const pos = new Float32Array(n), col = new Float32Array(n);
  let at = 0;
  for (const f of feats) {
    pos.set(f.segments, at);
    col.set(shaded(f.segments, COLORS[f.type] ?? DEFAULT), at);
    at += f.segments.length;
  }
  const geo = new LineSegmentsGeometry();
  geo.setPositions(pos);
  geo.setColors(col);
  const obj = new LineSegments2(geo, v.oneMat);
  obj.frustumCulled = false;
  v.scene.add(obj);
  return obj;
}

function teardown() {
  if (!view) return;
  view.one?.geometry.dispose();
  view.stop();
  view.ro.disconnect();
  view.controls.dispose();
  for (const d of view.disposables) d.dispose?.();
  view.renderer.dispose();
  view.renderer.domElement.remove();
  view = null;
}
