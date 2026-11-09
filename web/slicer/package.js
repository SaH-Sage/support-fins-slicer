/**
 * The file that goes on the USB stick: a Bambu "sliced 3MF" (name.gcode.3mf),
 * laid out the way OrcaSlicer's bbs_3mf.cpp writes one for a sliced plate:
 *
 *   [Content_Types].xml, _rels/.rels
 *   3D/3dmodel.model                    an empty model part (the job is the G-code)
 *   Metadata/plate_1.gcode              the G-code
 *   Metadata/plate_1.gcode.md5          its MD5, uppercase hex
 *   Metadata/plate_1.png                the picture the printer shows in its file list
 *   Metadata/slice_info.config          printer model, nozzles, time, weight, objects, filament
 *   Metadata/project_settings.config    the settings it was sliced with (JSON)
 *
 * Plain .gcode is offered beside it (see panel.js) for printers or firmware that
 * read that instead.
 */
import { zipStore } from '../zip.js';
import { md5Hex } from './md5.js';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "1h 18m 41s" / "5m 8s" / "2d 3h 4m 5s" -> seconds */
export function durationSeconds(text) {
  if (!text) return 0;
  let s = 0;
  for (const [, n, u] of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) s += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return Math.round(s);
}

/**
 * The numbers a person wants after slicing, read from the G-code's own comments
 * (the header block and the statistics at the end; only those parts are read).
 */
export function gcodeStats(bytes) {
  const dec = new TextDecoder();
  const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const tail = dec.decode(bytes.subarray(Math.max(0, bytes.length - 256 * 1024)));
  const pick = (re, s = head + '\n' + tail) => s.match(re)?.[1];
  const stats = {
    seconds: durationSeconds(pick(/total estimated time:\s*([^;\n]+)/)),
    firstLayerSeconds: durationSeconds(pick(/estimated first layer printing time[^=]*=\s*([^\n]+)/)),
    layers: Number(pick(/total layer number:\s*(\d+)/)) || 0,
    maxZ: Number(pick(/max_z_height:\s*([\d.]+)/)) || 0,
    filamentMm: Number(pick(/filament used \[mm\]\s*=\s*([\d.]+)/)) || 0,
    filamentG: Number(pick(/filament used \[g\]\s*=\s*([\d.]+)/)) || 0,
  };
  return stats;
}

/** The objects the G-code labels (Bambu's skip-object ids), in print order. */
export function gcodeObjects(text) {
  const out = [];
  const seen = new Set();
  const re = /; start printing object, unique label id: (\d+)/g;
  for (const [, id] of text.matchAll(re)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
</Relationships>`;

const MODEL = (title) => `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">Support Fins slicer (OrcaSlicer 2.4.2 engine)</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${xml(title)}</metadata>
 <resources/>
 <build/>
</model>`;

// OrcaSlicer's enum order (PrintConfig.hpp): ExtruderType etDirectDrive = 0, etBowden = 1.
const EXTRUDER_TYPE = { 'Direct Drive': 0, Bowden: 1 };

function sliceInfo({ printer, filament, stats, objects, color }) {
  const phys = printer.physical ?? { extruder_type: ['Direct Drive'], nozzle_diameter: [String(printer.nozzle)], extruder: 1 };
  const types = phys.extruder_type.map((t) => EXTRUDER_TYPE[t] ?? 0).join(' ');
  const volumeTypes = phys.extruder_type.map(() => 0).join(' ');          // nvtStandard
  const diameters = phys.nozzle_diameter.join(',');
  const ext = phys.extruder;                                               // 1-based
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <header>',
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
    // The engine is OrcaSlicer 2.4.2 (the G-code says so); this is the Bambu
    // protocol version it reports (SLIC3R_VERSION in its version.inc).
    '    <header_item key="X-BBL-Client-Version" value="02.06.00.51"/>',
    '    <header_item key="OrcaSlicer-Version" value="2.4.2"/>',
    '  </header>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    `    <metadata key="extruder_type" value="${types}"/>`,
    `    <metadata key="nozzle_volume_type" value="${volumeTypes}"/>`,
    `    <metadata key="printer_model_id" value="${xml(printer.model_id ?? '')}"/>`,
    `    <metadata key="nozzle_diameters" value="${xml(diameters)}"/>`,
    '    <metadata key="timelapse_type" value="0"/>',
    `    <metadata key="prediction" value="${stats.seconds}"/>`,
    `    <metadata key="weight" value="${stats.filamentG.toFixed(2)}"/>`,
    `    <metadata key="first_layer_time" value="${stats.firstLayerSeconds.toFixed(6)}"/>`,
    '    <metadata key="outside" value="false"/>',
    '    <metadata key="support_used" value="false"/>',
    '    <metadata key="label_object_enabled" value="true"/>',
    '    <metadata key="enable_filament_dynamic_map" value="false"/>',
    `    <metadata key="filament_maps" value="${ext}"/>`,
    ...objects.map((o) => `    <object identify_id="${o.id}" name="${xml(o.name)}" skipped="false" />`),
    `    <filament id="1" tray_info_idx="${xml(filament.tray_id ?? '')}" type="${xml(first(filament.config.filament_type) ?? 'PLA')}" `
      + `color="${xml(color)}" used_m="${(stats.filamentMm / 1000).toFixed(2)}" used_g="${stats.filamentG.toFixed(2)}" `
      + `group_id="${ext - 1}" nozzle_diameter="${xml(phys.nozzle_diameter[ext - 1] ?? printer.nozzle)}" volume_type="Standard" `
      + 'used_for_object="true" used_for_support="false"/>',
    `    <nozzle id="${ext - 1}" extruder_id="${ext}" nozzle_diameter="${xml(phys.nozzle_diameter[ext - 1] ?? printer.nozzle)}" volume_type="Standard"/>`,
    '  </plate>',
    '</config>',
  ];
  return lines.join('\n') + '\n';
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * OrcaSlicer's project_settings.config: every setting as a string, or a list of
 * strings for per-extruder/per-filament ones.
 */
function projectSettings(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = Array.isArray(v) ? v.map(String) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  }
  return JSON.stringify(out, null, 4) + '\n';
}

/**
 * @param gcode     Uint8Array, the G-code as the engine wrote it
 * @param thumbnail Uint8Array PNG, or null
 * @param objects   [{ id: label id, name }] in the G-code's order
 * @returns Blob (application/zip)
 */
export function writeGcode3mf({ gcode, thumbnail, printer, filament, config, stats, objects, title, color = '#FFFFFF' }) {
  const files = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: MODEL(title) },
    { name: 'Metadata/plate_1.gcode', data: gcode },
    { name: 'Metadata/plate_1.gcode.md5', data: md5Hex(gcode) },
    { name: 'Metadata/slice_info.config', data: sliceInfo({ printer, filament, stats, objects, color }) },
    { name: 'Metadata/project_settings.config', data: projectSettings(config) },
  ];
  if (thumbnail) files.splice(4, 0, { name: 'Metadata/plate_1.png', data: thumbnail });
  return zipStore(files);
}
