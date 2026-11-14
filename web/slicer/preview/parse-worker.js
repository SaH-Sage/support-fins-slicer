// Parses sliced G-code for the preview off the main thread (a big print's
// G-code is tens of MB). In: { id, gcode: ArrayBuffer }. Out: { id, result }.
import { parseGcode } from './gcode-parse.js';

self.onmessage = ({ data: { id, gcode } }) => {
  try {
    const result = parseGcode(new TextDecoder().decode(gcode));
    const transfer = [];
    for (const l of result.layers) {
      for (const f of l.features) transfer.push(f.segments.buffer);
      transfer.push(l.travels.buffer);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
