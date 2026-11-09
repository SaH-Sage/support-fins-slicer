/**
 * Slicer worker: runs the OrcaSlicer 2.4.2 engine (WebAssembly, single-threaded
 * build from OrcaWeb, pinned in slicer/engine.json) off the main thread.
 *
 * Messages in:
 *   { type: 'load' }                                   fetch + start the engine
 *   { type: 'slice', id, config, stls, transforms }    stls: ArrayBuffer[] (binary STL,
 *        one per object), transforms: 11 numbers per object (scale xyz, rotation xyz,
 *        mirror xyz, X/Y offset from the bed centre in mm)
 * Messages out:
 *   { type: 'download', loaded, total }                engine download progress (bytes)
 *   { type: 'ready' }
 *   SLICE_PROGRESS { percent, stage }                  posted by the engine itself
 *   { type: 'done', id, gcode: ArrayBuffer }           (transferred)
 *   { type: 'error', id, message, code }
 *
 * A classic worker on purpose: the engine's glue (slicer.js) is an Emscripten
 * script that defines a global `OrcaModule`, which importScripts loads as is.
 */
/* global importScripts, OrcaModule */
const BASE = new URL('engine/', self.location.href).href;

let M = null;          // the engine module
let session = 0;       // its slicing session
let loading = null;    // the load in flight

const ERRORS = {
  '-1': 'The slicer engine was not ready.',
  '-2': 'The printer settings could not be read.',
  '-3': 'The model could not be handed to the slicer.',
  '-4': 'The slicer could not read the model.',
  '-5': 'There is nothing on the plate to slice.',
  '-6': 'The print settings or the plate are not valid for this printer.',
  '-7': 'Slicing failed.',
  '-8': 'The G-code could not be written.',
  '-9': 'The slicer engine hit an internal error.',
};

async function fetchWasm() {
  const res = await fetch(BASE + 'slicer.wasm');
  if (!res.ok) throw new Error(`Could not download the slicer engine (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastPost > 150) { lastPost = now; self.postMessage({ type: 'download', loaded, total }); }
  }
  self.postMessage({ type: 'download', loaded, total: total || loaded });
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return bytes;
}

function load() {
  if (M) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    importScripts(BASE + 'slicer.js');
    const wasmBinary = await fetchWasm();
    M = await OrcaModule({
      wasmBinary,
      print: () => {},
      printErr: () => {},
      onAbort: (what) => {
        // A crashed engine can't be trusted again: drop it, the next slice reloads.
        M = null; session = 0; loading = null;
        self.postMessage({ type: 'error', id: null, message: `The slicer engine crashed (${what}). Try again.` });
      },
    });
    session = M._orc_session_create();
    if (!session) throw new Error('The slicer engine could not start (out of memory?).');
  })();
  loading.catch(() => { loading = null; M = null; });
  return loading;
}

function engineError(code) {
  let detail = '';
  try {
    const p = M._orc_decode_exception(session);
    if (p) detail = M.UTF8ToString(p);
  } catch { /* the message is a bonus */ }
  return { message: detail || ERRORS[String(code)] || `Slicing failed (code ${code}).`, code };
}

function slice({ config, stls, transforms }) {
  const enc = new TextEncoder();
  const cfg = enc.encode(JSON.stringify(config));
  const ptrs = [];
  const alloc = (n) => { const p = M._malloc(n); ptrs.push(p); return p; };
  try {
    const cp = alloc(cfg.length);
    M.HEAPU8.set(cfg, cp);
    let r = M._orc_init(session, cp, cfg.length);
    if (r !== 0) throw engineError(r);

    const total = stls.reduce((n, b) => n + b.byteLength, 0);
    const ap = alloc(total);
    const offsets = new Int32Array(stls.length * 2);
    let at = 0;
    stls.forEach((b, i) => {
      M.HEAPU8.set(new Uint8Array(b), ap + at);
      offsets[2 * i] = at; offsets[2 * i + 1] = b.byteLength;
      at += b.byteLength;
    });
    const op = alloc(offsets.byteLength);
    M.HEAP32.set(offsets, op >> 2);
    const tf = new Float32Array(transforms.flat());
    const tp = alloc(tf.byteLength);
    M.HEAPF32.set(tf, tp >> 2);
    const out = alloc(8);
    r = M._orc_slice_multi(session, ap, total, op, stls.length, 0, out, out + 4, tp);
    if (r !== 0) throw engineError(r);
    const gp = M.HEAPU32[out >> 2], gl = M.HEAPU32[(out + 4) >> 2];
    const gcode = M.HEAPU8.slice(gp, gp + gl).buffer;
    M._orc_free(gp);
    return gcode;
  } finally {
    for (const p of ptrs) M && M._free(p);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await load();
    if (msg.type === 'load') { self.postMessage({ type: 'ready' }); return; }
    if (msg.type === 'slice') {
      self.postMessage({ type: 'ready' });
      const gcode = slice(msg);
      self.postMessage({ type: 'done', id: msg.id, gcode }, [gcode]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id ?? null, message: err?.message ?? String(err), code: err?.code ?? null });
  }
};
