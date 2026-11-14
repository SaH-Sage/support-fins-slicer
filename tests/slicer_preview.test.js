// support-fins-slicer: the slice preview's G-code parser (web/slicer/preview/gcode-parse.js).
// The extrusion and line-scanning cases are ported from the CraftBot-2-slicer
// project's GcodeViewer tests; coordinates here are bed millimetres (not re-centred).
import { assertEquals } from 'jsr:@std/assert';
import { parseGcode, tessellateArc } from '../web/slicer/preview/gcode-parse.js';

const count = (gcode) => {
  const layer = parseGcode(gcode).layers[0];
  return {
    extrusion: layer?.features.reduce((n, f) => n + f.segments.length / 6, 0) ?? 0,
    travel: (layer?.travels.length ?? 0) / 6,
  };
};

Deno.test('absolute E: only moves where E increases extrude', () => {
  assertEquals(count('M82\nG1 X10 Y0 E1\nG1 X20 Y0 E1\nG1 X30 Y0 E0.5'), { extrusion: 1, travel: 2 });
});

Deno.test('relative E (M83, what the X2D uses)', () => {
  assertEquals(count('M83\nG1 X10 Y0 E1\nG1 X20 Y0 E0\nG1 X30 Y0 E-1'), { extrusion: 1, travel: 2 });
});

Deno.test('switching back to absolute keeps the accumulated E', () => {
  assertEquals(count('M83\nG1 X10 Y0 E0.5\nG1 X20 Y0 E0.5\nM82\nG1 X30 Y0 E1'), { extrusion: 2, travel: 1 });
});

Deno.test('G92 E resets apply before the next delta', () => {
  assertEquals(count('M82\nG92 E10\nG1 X10 Y0 E11\nG92 E0\nG1 X20 Y0 E1'), { extrusion: 2, travel: 0 });
});

Deno.test('G92 XYZ resets apply before the next absolute move', () => {
  const layer = parseGcode('M82\nG1 X10 Y5 E1\nG92 X0 Y0 E0\nG1 X5 Y0 E1').layers[0];
  assertEquals(Array.from(layer.features[0].segments), [0, 0, 0, 10, 5, 0, 0, 0, 0, 5, 0, 0]);
});

Deno.test('an E word on G0 is not material, and a layer with nothing printed is left out', () => {
  assertEquals(count('M82\nG0 X10 Y0 E1'), { extrusion: 0, travel: 0 });
  assertEquals(parseGcode('M82\nG0 X10 Y0 E1').layers.length, 0);
});

Deno.test('last line without a newline, and CRLF', () => {
  assertEquals(count('M82\nG1 X10 Y0 E1'), { extrusion: 1, travel: 0 });
  assertEquals(count('M82\r\nG1 X10 Y0 E1\r\nG1 X20 Y0 E1\r\n'), { extrusion: 1, travel: 1 });
});

// Bambu-flavoured output, shaped like the engine's X2D G-code
const BAMBU = `; HEADER_BLOCK_START
; total layer number: 2
; HEADER_BLOCK_END
M83
G1 X10 Y-0.2 Z0.6 F3000
G1 X100 Y-0.2 E12 ; purge line in the start routine
; CHANGE_LAYER
; Z_HEIGHT: 0.2
; LAYER_HEIGHT: 0.2
G1 X100 Y100 Z0.2
; FEATURE: Outer wall
G1 X110 Y100 E0.5
G1 X110 Y110 E0.5
; FEATURE: Sparse infill
G1 X105 Y105 E0.2
G1 X100 Y100
; CHANGE_LAYER
; Z_HEIGHT: 0.4
G1 Z0.4
; FEATURE: Outer wall
G2 X110 Y100 I5 J0 E1
; FEATURE: Custom
; filament end gcode
G1 X0 Y250 E5 ; would-be extrusion in the end routine
`;

Deno.test('Bambu markers: layers, heights, features; start and end routines left out', () => {
  const r = parseGcode(BAMBU);
  assertEquals(r.layers.map((l) => l.z), [0.2, 0.4]);
  assertEquals(r.layers[0].features.map((f) => [f.type, f.segments.length / 6]), [['Outer wall', 2], ['Sparse infill', 1]]);
  assertEquals(r.types, ['Outer wall', 'Sparse infill']);
  assertEquals(r.hasFeatureTypes, true);
  // the purge line (Y -0.2) and the end routine (Y 250) don't widen the bounds
  assertEquals(r.bounds, [100, 100, 0, 110, 110, 0.4]);
  // the G2 arc becomes several straight pieces, ending on its target
  const arc = r.layers[1].features[0].segments;
  assertEquals(arc.length / 6 > 4, true);
  assertEquals([arc.at(-3), arc.at(-2)].map((v) => Math.round(v * 1e4) / 1e4), [110, 100]);
});

Deno.test('tessellateArc: half circle by I/J and by R end on the target', () => {
  const ij = tessellateArc(0, 0, 0, 10, 0, 0, 5, 0, null, false);
  const r = tessellateArc(0, 0, 0, 10, 0, 0, null, null, 5, false);
  for (const w of [ij, r]) assertEquals(w.slice(-3), [10, 0, 0]);
  // counter-clockwise from (0,0) to (10,0) around (5,0) goes below the axis
  assertEquals(ij.some((v, i) => i % 3 === 1 && v < -4.9), true);
});
