/**
 * Slice: the plate as it stands -- every model with its fins -- through the
 * OrcaSlicer engine (worker.js) for a chosen printer, quality and filament, then
 * a file for the USB stick.
 *
 * Everything the slicer adds to Support Fins lives in web/slicer/. Upstream
 * files are touched in two places only: app.js imports this module, and
 * ui/export.js exports two helpers it already had (placed, plateGeometryLive).
 *
 * The fins and the slice must agree: the grip tines are one layer tall and the
 * walls are sized in nozzle lines. So choosing a printer sets the site's build
 * volume and nozzle, and choosing a quality sets its layer height -- the fins
 * rebuild -- and Slice waits for that rebuild before it reads the plate.
 */
import { el } from '../ui/dom.js';
import { t } from '../ui/i18n.js';
import { writeBinarySTL, download } from '../stl.js';
import { buildExportGeometry, plateGeometry, plateGeometryLive, placed } from '../ui/export.js';
import { currentPlate, locked, activePlate, plateCount } from '../ui/plates.js';
import { parkedSettled } from '../ui/parkedbuild.js';
import { buildPending, activeAdded } from '../ui/finbuild.js';
import { liveXY, parkedFins } from '../ui/models.js';
import { part, topology, lastResult } from '../ui/part.js';
import { overlapping, arrange } from '../ui/arrange.js';
import { gcodeStats, gcodeObjects, writeGcode3mf } from './package.js';
import { plateThumbnail } from './thumb.js';

const BASE = new URL('./', import.meta.url);
const STORE = 'sfs.slicer';
const BED_TYPES = [
  { value: 'Textured PEI Plate', label: 'Textured PEI plate' },
  { value: 'High Temp Plate', label: 'Smooth PEI plate' },
];

let printers = [];        // index.json entries
let printer = null;       // the chosen printer's file (printers/<id>.json)
let worker = null;
let engineReady = false;
let slicing = false;
let result = null;        // { gcode: Uint8Array, stats, name, objects, models, config, filament }
let jobId = 0;

// ---------------------------------------------------------------- markup
document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('slicer.css', BASE).href }));

const openBtn = Object.assign(document.createElement('button'), { className: 'btn primary', id: 'slice-open', type: 'button' });
openBtn.textContent = t('Slice');
openBtn.title = t('Slice the plate for a printer and save the file for its USB stick.');
el('export').closest('.menu-wrap').after(openBtn);

const dlg = document.createElement('dialog');
dlg.id = 'slice-dialog';
dlg.innerHTML = `
  <form method="dialog" class="sl-head">
    <h2>${t('Slice for printing')}</h2>
    <button class="sl-x" value="close" aria-label="${t('Close')}">×</button>
  </form>
  <div class="sl-body">
    <p class="sl-note" id="sl-plate"></p>
    <label class="sl-row"><span>${t('Printer')}</span><select id="sl-printer"></select></label>
    <label class="sl-row"><span>${t('Quality')}</span><select id="sl-quality"></select></label>
    <label class="sl-row"><span>${t('Filament')}</span><select id="sl-filament"></select></label>
    <label class="sl-row"><span>${t('Build plate')}</span><select id="sl-bed"></select></label>
    <p class="sl-note" id="sl-sync" hidden></p>
    <p class="sl-note warn" id="sl-nofins" hidden>${t('No fins on this plate: the parts print without supports.')}
      <button type="button" class="sl-link" id="sl-addfins">${t('Add fins')}</button></p>
    <p class="sl-note warn" id="sl-clash" hidden>${t('Models overlap: they would print into each other.')}
      <button type="button" class="sl-link" id="sl-arrange">${t('Arrange')}</button></p>
    <p class="sl-note warn" id="sl-outside" hidden>${t('Part of the plate is outside this printer’s bed. Move or scale it first.')}</p>
    <div class="sl-actions">
      <button type="button" class="btn primary" id="sl-go">${t('Slice')}</button>
      <button type="button" class="btn" id="sl-cancel" hidden>${t('Cancel')}</button>
    </div>
    <div class="sl-progress" id="sl-progress" hidden>
      <div class="sl-bar"><div id="sl-bar"></div></div>
      <p id="sl-stage" class="sl-stage"></p>
    </div>
    <p class="sl-note err" id="sl-error" hidden></p>
    <div class="sl-result" id="sl-result" hidden>
      <p class="sl-stats" id="sl-stats"></p>
      <button type="button" class="btn primary" id="sl-save">${t('Save for USB stick')}</button>
      <button type="button" class="sl-link" id="sl-save-plain">${t('Plain .gcode instead')}</button>
      <p class="sl-help">${t('Copy the file to a USB stick, plug it into the printer and start the print from its screen. Watch the first layer of every new kind of print.')}</p>
    </div>
  </div>`;
document.body.append(dlg);

const sel = { printer: el('sl-printer'), quality: el('sl-quality'), filament: el('sl-filament'), bed: el('sl-bed') };
for (const b of BED_TYPES) sel.bed.add(new Option(t(b.label), b.value));

// ---------------------------------------------------------------- remembered choices
function saved() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}
function remember() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ printer: sel.printer.value, quality: sel.quality.value,
      filament: sel.filament.value, bed: sel.bed.value }));
  } catch { /* storage off: the page just forgets */ }
}

// ---------------------------------------------------------------- printers
async function loadPrinters() {
  if (printers.length) return;
  const res = await fetch(new URL('printers/index.json', BASE));
  printers = (await res.json()).printers;
  for (const p of printers) sel.printer.add(new Option(p.label, p.id));
  const s = saved();
  if (printers.some((p) => p.id === s.printer)) sel.printer.value = s.printer;
  if (s.bed && BED_TYPES.some((b) => b.value === s.bed)) sel.bed.value = s.bed;
  await choosePrinter(s);
}

async function choosePrinter(s = {}) {
  const entry = printers.find((p) => p.id === sel.printer.value) ?? printers[0];
  const res = await fetch(new URL(`printers/${entry.file}`, BASE));
  printer = await res.json();
  fill(sel.quality, printer.processes, s.quality);
  fill(sel.filament, printer.filaments, s.filament);
  syncSite();
}

function fill(select, items, want) {
  select.length = 0;
  for (const it of items) select.add(new Option(it.label, it.id));
  select.value = items.some((i) => i.id === want) ? want : (items.find((i) => i.default) ?? items[0]).id;
}

const quality = () => printer.processes.find((p) => p.id === sel.quality.value);
const filament = () => printer.filaments.find((f) => f.id === sel.filament.value);
const num = (v) => Number(Array.isArray(v) ? v[0] : v);

/**
 * Make the site build fins for this printer and quality: build volume, nozzle,
 * layer height. Each change goes through the control's own event, so the site
 * reacts (and remembers) exactly as if it had been set by hand.
 */
function syncSite() {
  const changed = [];
  const [bx, by, bz] = printer.printer.bed;
  const vx = el('vx'), vy = el('vy'), vz = el('vz'), vol = el('volume');
  if (Number(vx.value) !== bx || Number(vy.value) !== by || Number(vz.value) !== bz || vol.value !== 'custom') {
    const preset = [...vol.options].find((o) => o.value === `${bx} × ${by} × ${bz} mm`);
    if (preset) {
      vol.value = preset.value;
      vol.dispatchEvent(new Event('change'));
    } else {
      vol.value = 'custom';
      vx.value = String(bx); vy.value = String(by); vz.value = String(bz);
      vx.dispatchEvent(new Event('input'));
    }
    changed.push(`${t('build volume')} ${bx} × ${by} × ${bz} mm`);
  }
  const noz = el('nozzle'), n = String(printer.printer.nozzle);
  const nOpt = [...noz.options].find((o) => Number(o.value) === Number(n));
  if (nOpt && noz.value !== nOpt.value) {
    noz.value = nOpt.value;
    noz.dispatchEvent(new Event('change'));
    changed.push(`${t('nozzle')} ${n} mm`);
  }
  const lh = el('layer-height'), h = num(quality().config.layer_height);
  if (Math.abs(lh.valueAsNumber - h) > 1e-6) {
    lh.value = String(h);
    lh.dispatchEvent(new Event('input'));
    changed.push(`${t('layer height')} ${h} mm`);
  }
  const note = el('sl-sync');
  note.hidden = !changed.length;
  if (changed.length) note.textContent = `${t('Fins rebuilt to match:')} ${changed.join(', ')}.`;
  invalidate();
  checkPlate();
}

// ---------------------------------------------------------------- plate checks
function checkPlate() {
  const ready = !!(part && topology && lastResult);
  const n = currentPlate().models.length;
  el('sl-plate').textContent = !ready ? t('Import a model first.')
    : `${plateCount() > 1 ? `${t('Plate')} ${activePlate() + 1}: ` : ''}${n} ${n === 1 ? t('model') : t('models')}`
      + (plateCount() > 1 ? ` · ${t('each plate is sliced on its own')}` : '');
  el('sl-go').disabled = !ready || slicing;
  el('sl-nofins').hidden = !ready || activeAdded().length > 0 || parkedFins();
  el('sl-clash').hidden = !ready || !overlapping();
  return ready;
}

function outsideBed(models) {
  const [bx, by] = printer.printer.bed;
  const hx = bx / 2 + 0.01, hy = by / 2 + 0.01;
  return models.some((m) => [...m.tris, ...m.fins].some((p) => Math.abs(p[0]) > hx || Math.abs(p[1]) > hy));
}

/** Wait for the fins to catch up with the settings, then read the plate. */
async function plateModels() {
  await new Promise((r) => setTimeout(r, 300));          // the settings' debounce
  const t0 = Date.now();
  while (buildPending() && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 100));
  let gs;
  if (currentPlate().models.length === 1) {
    const g = buildExportGeometry();
    gs = g ? [placed(g, liveXY())] : [];
  } else {
    const settled = await parkedSettled();
    gs = settled ? plateGeometry() : await locked(plateGeometryLive);
  }
  return (gs ?? []).filter(Boolean).map((g) => ({ name: g.base, tris: g.partTris, fins: g.finTris }));
}

// ---------------------------------------------------------------- engine
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('worker.js', BASE));
  engineReady = false;
  worker.onmessage = (e) => onWorker(e.data);
  worker.onerror = (e) => fail(e.message || t('The slicer engine could not start.'));
  worker.postMessage({ type: 'load' });
  return worker;
}

let pending = null;   // { id, resolve, reject }

function onWorker(m) {
  if (m.type === 'download') {
    if (!engineReady && slicing) {
      const mb = (b) => (b / 1048576).toFixed(0);
      progress(m.total ? (m.loaded / m.total) * 100 : 0,
        `${t('Downloading the slicer engine')} ${mb(m.loaded)}${m.total ? ` / ${mb(m.total)}` : ''} MB`);
    }
  } else if (m.type === 'ready') {
    engineReady = true;
  } else if (m.type === 'SLICE_PROGRESS') {
    progress(m.percent, m.stage);
  } else if (m.type === 'done' && pending && m.id === pending.id) {
    pending.resolve(new Uint8Array(m.gcode));
    pending = null;
  } else if (m.type === 'error') {
    if (pending && (m.id === pending.id || m.id === null)) { pending.reject(new Error(m.message)); pending = null; }
    else if (m.id === null) { worker?.terminate(); worker = null; }
  }
}

function runSlice(job) {
  ensureWorker();
  return new Promise((resolve, reject) => {
    pending = { id: job.id, resolve, reject };
    worker.postMessage(job, job.stls);
  });
}

// ---------------------------------------------------------------- slicing
function progress(pct, stage) {
  el('sl-progress').hidden = false;
  el('sl-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el('sl-stage').textContent = stage ?? '';
}

function fail(message) {
  el('sl-error').hidden = false;
  el('sl-error').textContent = message;
}

function invalidate() {
  result = null;
  el('sl-result').hidden = true;
  el('sl-error').hidden = true;
}

function setSlicing(on) {
  slicing = on;
  el('sl-go').hidden = on;
  el('sl-cancel').hidden = !on;
  for (const s of Object.values(sel)) s.disabled = on;
  if (!on) checkPlate();
}

/** One binary STL per model (part + fins), and where its centre goes on the bed. */
async function engineInput(models) {
  const stls = [], transforms = [];
  for (const m of models) {
    const all = [...m.tris, ...m.fins];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of all) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    stls.push(await writeBinarySTL(all, m.name).arrayBuffer());
    // The engine centres each object on its bounding box, then moves it this far
    // from the bed's centre: the model's own centre on the plate (plate centre = bed centre).
    transforms.push([1, 1, 1, 0, 0, 0, 1, 1, 1, (x0 + x1) / 2, (y0 + y1) / 2]);
  }
  return { stls, transforms };
}

function engineConfig() {
  const p = printer, q = quality(), f = filament();
  return {
    ...p.machine, ...q.config, ...f.config,
    curr_bed_type: sel.bed.value,
    // not engine settings: the bridge reads these to find the bed's centre
    bed_size_x: p.printer.bed[0], bed_size_y: p.printer.bed[1],
  };
}

async function slice() {
  if (slicing || !checkPlate()) return;
  invalidate();
  setSlicing(true);
  const id = ++jobId;
  try {
    progress(0, t('Waiting for the fins to finish…'));
    const models = await plateModels();
    if (id !== jobId) return;
    if (!models.length) throw new Error(t('There is nothing on the plate to slice.'));
    if (outsideBed(models)) { el('sl-outside').hidden = false; throw new Error(t('Part of the plate is outside the bed.')); }
    el('sl-outside').hidden = true;
    progress(0, engineReady ? t('Starting…') : t('Starting the slicer engine…'));
    const config = engineConfig();
    const { stls, transforms } = await engineInput(models);
    const gcode = await runSlice({ type: 'slice', id, config, stls, transforms });
    if (id !== jobId) return;
    const stats = gcodeStats(gcode);
    const text = new TextDecoder().decode(gcode);
    const labels = gcodeObjects(text);
    // the G-code prints objects in its own order; names follow the labels it gives
    // them (object_<n> is the n-th STL handed over)
    const names = [...text.matchAll(/; printing object object_(\d+)/g)].map((m) => models[Number(m[1])]?.name ?? `object_${m[1]}`);
    const objects = labels.map((lid, i) => ({ id: lid, name: names[i] ?? `object_${i}` }));
    result = { gcode, stats, objects, models, config, filament: filament(),
               name: safeName(models.length === 1 ? models[0].name : `${models[0].name}-and-${models.length - 1}-more`) };
    showResult();
  } catch (err) {
    if (id === jobId) fail(err.message || String(err));
  } finally {
    if (id === jobId) { setSlicing(false); el('sl-progress').hidden = true; }
  }
}

function cancel() {
  jobId++;
  if (pending) { pending.reject(new Error(t('Cancelled.'))); pending = null; }
  worker?.terminate();
  worker = null;
  engineReady = false;
  setSlicing(false);
  el('sl-progress').hidden = true;
}

const safeName = (s) => (s.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'print').slice(0, 60);

function hm(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function showResult() {
  const s = result.stats;
  const ft = result.filament.config.filament_type;
  const type = (Array.isArray(ft) ? ft[0] : ft) ?? '';
  el('sl-stats').textContent = [
    hm(s.seconds),
    `${s.filamentG.toFixed(1)} g ${type}`.trim(),
    `${s.layers} ${t('layers')}`,
  ].join(' · ');
  el('sl-result').hidden = false;
}

async function save() {
  if (!result) return;
  const thumbnail = await plateThumbnail(result.models).catch(() => null);
  const blob = writeGcode3mf({
    gcode: result.gcode, thumbnail, printer: printer.printer, filament: result.filament, config: result.config,
    stats: result.stats, objects: result.objects, title: result.name,
  });
  download(blob, `${result.name}.gcode.3mf`);
}

function savePlain() {
  if (!result) return;
  download(new Blob([result.gcode], { type: 'text/x.gcode' }), `${result.name}.gcode`);
}

// ---------------------------------------------------------------- wiring
openBtn.addEventListener('click', async () => {
  dlg.showModal();
  ensureWorker();                       // start the 29 MB download while settings are chosen
  try { await loadPrinters(); } catch (err) { fail(`${t('Could not load the printer list.')} ${err.message}`); }
  if (printer) syncSite();
});
sel.printer.addEventListener('change', async () => { remember(); await choosePrinter(saved()); });
sel.quality.addEventListener('change', () => { remember(); syncSite(); });
sel.filament.addEventListener('change', () => { remember(); invalidate(); });
sel.bed.addEventListener('change', () => { remember(); invalidate(); });
el('sl-go').addEventListener('click', slice);
el('sl-cancel').addEventListener('click', cancel);
el('sl-save').addEventListener('click', save);
el('sl-save-plain').addEventListener('click', savePlain);
el('sl-addfins').addEventListener('click', () => { el('fins-toggle').click(); setTimeout(checkPlate, 400); });
el('sl-arrange').addEventListener('click', async () => { await arrange(); invalidate(); checkPlate(); });
dlg.addEventListener('close', () => { if (slicing) cancel(); });

// for tests and the curious: window.__sfSlicer
window.__sfSlicer = { slice, save, savePlain, get result() { return result; }, get printer() { return printer; } };
