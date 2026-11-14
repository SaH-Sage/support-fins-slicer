/**
 * The file that goes on the USB stick: a Bambu "sliced 3MF" (name.gcode.3mf),
 * laid out the way OrcaSlicer's bbs_3mf.cpp writes one for a sliced plate:
 *
 *   [Content_Types].xml, _rels/.rels
 *   3D/3dmodel.model                    an empty model part (the job is the G-code)
 *   Metadata/plate_1.gcode              the G-code
 *   Metadata/plate_1.gcode.md5          its MD5, uppercase hex
 *   Metadata/plate_1.png                the picture the printer shows in its file list (512 px)
 *   Metadata/plate_1_small.png          the same at 128 px
 *   Metadata/plate_1.json               where the objects are on the bed (bounding boxes)
 *   Metadata/model_settings.config      which file is the plate's G-code, picture, boxes
 *   Metadata/_rels/model_settings.config.rels
 *   Metadata/slice_info.config          printer model, nozzles, time, weight, objects, filament
 *   Metadata/project_settings.config    the settings it was sliced with (JSON)
 *
 * Checked against a plate Bambu Studio 2.9.1 exported for an X2D ("Export plate
 * sliced file"); the files Bambu Studio adds only for its own editor (the
 * no-light/top/pick renders, cut and height-range info) are left out.
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

const RELS = (big, small) => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${big ? `
 <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>` : ''}${small ? `
 <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>` : ''}
</Relationships>`;

const MODEL_SETTINGS_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>`;

const modelSettings = (ext, big) => `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Manual"/>
    <metadata key="filament_maps" value="${ext}"/>
    <metadata key="filament_volume_maps" value="0"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>${big ? `
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>` : ''}
    <metadata key="pattern_bbox_file" value="Metadata/plate_1.json"/>
  </plate>
</config>
`;

// Bambu Studio's names for OrcaSlicer's curr_bed_type values (plate_1.json bed_type)
const BED_TYPE = { 'Textured PEI Plate': 'textured_plate', 'High Temp Plate': 'hot_plate',
  'Cool Plate': 'cool_plate', 'Engineering Plate': 'eng_plate', 'Supertack Plate': 'supertack_plate' };

/**
 * plate_1.json: the objects' bounding boxes on the bed (mm, bed coordinates),
 * which the printer uses to know where the parts are (first-layer checks).
 * plate.objects: [{ name, bbox: [x0, y0, x1, y1] }].
 */
function plateJson({ plate, config, ext, color, stats }) {
  const objs = plate.objects;
  const all = objs.reduce((b, o) => [Math.min(b[0], o.bbox[0]), Math.min(b[1], o.bbox[1]),
    Math.max(b[2], o.bbox[2]), Math.max(b[3], o.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const lh = Number(first(config.layer_height)) || 0.2;
  return JSON.stringify({
    bbox_all: all,
    bbox_objects: objs.map((o, i) => ({ area: (o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]), bbox: o.bbox,
      id: i + 1, layer_height: lh, name: o.name })),
    bed_type: BED_TYPE[first(config.curr_bed_type)] ?? 'textured_plate',
    filament_colors: [color], filament_ids: [0], first_extruder: ext - 1,
    first_layer_time: stats.firstLayerSeconds, is_seq_print: false,
    nozzle_diameter: Number(first(config.nozzle_diameter)) || 0.4, version: 2,
  });
}

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
    // The Bambu protocol version this file follows: the X2D's G-code templates
    // and this package layout are Bambu Studio 2.9.1's (slicer/profiles/build.py);
    // the X2D is newer than the 2.6 protocol OrcaSlicer 2.4.2 reports. The G-code
    // header and 3dmodel.model name the real slicer engine (OrcaSlicer 2.4.2).
    '    <header_item key="X-BBL-Client-Version" value="02.09.01.70"/>',
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
    '    <metadata key="pause_count" value="0"/>',
    `    <metadata key="first_layer_time" value="${stats.firstLayerSeconds.toFixed(6)}"/>`,
    '    <metadata key="outside" value="false"/>',
    '    <metadata key="support_used" value="false"/>',
    '    <metadata key="label_object_enabled" value="true"/>',
    '    <metadata key="support_material_on_wipe_tower" value="false"/>',
    '    <metadata key="enable_filament_dynamic_map" value="false"/>',
    '    <metadata key="has_filament_switcher" value="false"/>',
    '    <metadata key="multi_nozzle_diameter_mode" value="0"/>',
    `    <metadata key="filament_maps" value="${ext}"/>`,
    '    <metadata key="limit_filament_maps" value="0"/>',
    ...objects.map((o) => `    <object identify_id="${o.id}" name="${xml(o.name)}" skipped="false" />`),
    `    <filament id="1" tray_info_idx="${xml(filament.tray_id ?? '')}" type="${xml(first(filament.config.filament_type) ?? 'PLA')}" `
      + `color="${xml(color)}" used_m="${(stats.filamentMm / 1000).toFixed(2)}" used_g="${stats.filamentG.toFixed(2)}" `
      + `group_id="${ext - 1}" nozzle_diameter="${Number(phys.nozzle_diameter[ext - 1] ?? printer.nozzle).toFixed(2)}" volume_type="Standard" `
      + 'used_for_object="true" used_for_support="false" directly_used="true" total_load_time="0.00" total_unload_time="0.00"/>',
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
 * @param gcode          Uint8Array, the G-code as the engine wrote it
 * @param thumbnail      Uint8Array PNG (512 px), or null
 * @param thumbnailSmall Uint8Array PNG (128 px), or null
 * @param objects        [{ id: label id, name }] in the G-code's order
 * @param plate          { objects: [{ name, bbox: [x0, y0, x1, y1] }] } in bed mm, or null
 * @returns Blob (application/zip)
 */
export function writeGcode3mf({ gcode, thumbnail, thumbnailSmall = null, printer, filament, config, stats, objects,
  plate = null, title, color = '#FFFFFF' }) {
  const ext = printer.physical?.extruder ?? 1;
  const files = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS(!!thumbnail, !!thumbnailSmall) },
    { name: '3D/3dmodel.model', data: MODEL(title) },
    thumbnail && { name: 'Metadata/plate_1.png', data: thumbnail },
    thumbnailSmall && { name: 'Metadata/plate_1_small.png', data: thumbnailSmall },
    plate && { name: 'Metadata/plate_1.json', data: plateJson({ plate, config, ext, color, stats }) },
    { name: 'Metadata/plate_1.gcode', data: gcode },
    { name: 'Metadata/plate_1.gcode.md5', data: md5Hex(gcode) },
    { name: 'Metadata/_rels/model_settings.config.rels', data: MODEL_SETTINGS_RELS },
    { name: 'Metadata/model_settings.config', data: modelSettings(ext, !!thumbnail) },
    { name: 'Metadata/slice_info.config', data: sliceInfo({ printer, filament, stats, objects, color }) },
    { name: 'Metadata/project_settings.config', data: projectSettings(config) },
  ].filter(Boolean);
  return zipStore(files);
}
