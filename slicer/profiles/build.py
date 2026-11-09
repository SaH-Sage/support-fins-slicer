#!/usr/bin/env python3
"""Build the slicer's printer files (web/slicer/printers/*.json) from OrcaSlicer
vendor profiles.

    python3 slicer/profiles/build.py                      # rebuild from the vendored profiles
    python3 slicer/profiles/build.py --vendor-from ORCA   # refresh the vendored source files
                                                          # from an OrcaSlicer checkout first

Each printer is described by a recipe (RECIPES below): one machine profile, the
process (quality) presets and the filament presets students may pick. For each
one this script

  1. resolves OrcaSlicer's `inherits` chain (child keys win) and merges the
     machine's `include` templates (start/end/layer G-code live there),
  2. collapses the per-nozzle-variant arrays of a multi-nozzle printer to the one
     nozzle we print with (see collapse_variants),
  3. writes one self-contained JSON file the browser hands to the engine as-is:
     {"printer": {...}, "machine": {...}, "processes": [...], "filaments": [...]}.

Only the profile files a recipe actually reaches are vendored, under
slicer/profiles/<vendor>/, with the OrcaSlicer commit they came from in SOURCE.txt.
They are AGPL-3.0 like OrcaSlicer (see NOTICE.md).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT_DIR = ROOT / "web" / "slicer" / "printers"

# ---------------------------------------------------------------------------
# Recipes. Add a printer by adding a recipe; the site's printer list is built
# from the files this writes (web/slicer/printers/index.json).
# ---------------------------------------------------------------------------
RECIPES = [
    {
        "id": "bambu-x2d-0.4",
        "label": "Bambu Lab X2D (0.4 mm nozzle)",
        "vendor": "BBL",
        "machine": "Bambu Lab X2D 0.4 nozzle",
        # The X2D has two nozzles: extruder 1 is the main, direct-drive one.
        # First version prints with that one only (support fins replace the
        # second nozzle's support material).
        "extruder": 1,
        "variant": "Direct Drive Standard",
        # Placeholders Bambu's X2D G-code uses that the OrcaSlicer 2.4.2 engine
        # predates (they arrived with multi-nozzle support in Orca 2.5). Each is
        # replaced by the value Orca 2.5's GCode.cpp computes for a print with
        # ONE filament on the main nozzle: filament id 0, logical nozzle 0, and
        # that nozzle's diameter. initial_no_support_hotend needs no help: the
        # old engine already gives the -1 Orca 2.5 gives a Bambu printer
        # without a hotend rack (an explicit index would make the firmware ask
        # for a Filament Track Switch and reject the job).
        "placeholders": {
            "initial_no_support_filament_id": "0",
            "initial_filament_id": "0",
            "initial_nozzle_id": "0",
            "current_filament_id": "0",
            "current_nozzle_id": "0",
        },
        "rewrites": [
            # nozzle_diameter_at_nozzle_id[n] -> the one nozzle's diameter
            (r"nozzle_diameter_at_nozzle_id\[[a-z_0-9]+\]", "nozzle_diameter[0]"),
        ],
        # Templates left out. The timelapse block only runs when timelapse
        # recording is on at the printer (M1002 judge_flag timelapse_record_flag,
        # marked SKIPPABLE) and needs camera-position variables the 2.4.2 engine
        # lacks. Without it a print simply records no timelapse video.
        "blank": ["time_lapse_gcode"],
        "processes": [
            {"id": "0.08-hq", "preset": "0.08mm High Quality @BBL X2D", "label": "0.08 mm – High Quality"},
            {"id": "0.12-hq", "preset": "0.12mm High Quality @BBL X2D", "label": "0.12 mm – High Quality"},
            {"id": "0.16-std", "preset": "0.16mm Standard @BBL X2D", "label": "0.16 mm – Standard"},
            {"id": "0.20-std", "preset": "0.20mm Standard @BBL X2D", "label": "0.20 mm – Standard", "default": True},
            {"id": "0.24-std", "preset": "0.24mm Standard @BBL X2D", "label": "0.24 mm – Draft"},
        ],
        "filaments": [
            {"id": "pla-basic", "preset": "Bambu PLA Basic @BBL X2D 0.4 nozzle", "label": "Bambu PLA Basic", "default": True},
            {"id": "pla", "preset": "Generic PLA @BBL X2D 0.4 nozzle", "label": "PLA (generic)"},
            {"id": "petg-hf", "preset": "Bambu PETG HF @BBL X2D 0.4 nozzle", "label": "Bambu PETG HF"},
            {"id": "petg", "preset": "Generic PETG @BBL X2D 0.4 nozzle", "label": "PETG (generic)"},
            {"id": "tpu", "preset": "Generic TPU @BBL X2D 0.4 nozzle", "label": "TPU (generic)"},
        ],
    },
]

# ---------------------------------------------------------------------------
# Variant collapsing. These sets mirror OrcaSlicer's own lists in
# src/libslic3r/PrintConfig.cpp (printer_options_with_variant_1/_2,
# print_options_with_variant, filament_options_with_variant,
# printer_extruder_options) at the vendored commit.
# ---------------------------------------------------------------------------
PRINTER_VARIANT_1 = {
    "nozzle_volume", "retraction_length", "z_hop", "travel_slope", "retract_lift_above",
    "retract_lift_below", "retract_lift_enforce", "z_hop_types", "retraction_speed",
    "deretraction_speed", "retraction_minimum_travel", "retract_when_changing_layer", "wipe",
    "wipe_distance", "retract_before_wipe", "retract_after_wipe", "retract_length_toolchange",
    "retract_restart_extra", "retract_restart_extra_toolchange", "long_retractions_when_cut",
    "retraction_distances_when_cut", "nozzle_type", "printer_extruder_id",
    "printer_extruder_variant", "hotend_cooling_rate", "hotend_heating_rate",
    "nozzle_flush_dataset", "deretract_speed_extruder_change",
}
# (normal, silent) pairs per variant
PRINTER_VARIANT_2 = {
    "machine_max_acceleration_x", "machine_max_acceleration_y", "machine_max_acceleration_z",
    "machine_max_acceleration_e", "machine_max_acceleration_extruding",
    "machine_max_acceleration_retracting", "machine_max_acceleration_travel",
    "machine_max_speed_x", "machine_max_speed_y", "machine_max_speed_z", "machine_max_speed_e",
    "machine_max_jerk_x", "machine_max_jerk_y", "machine_max_jerk_z", "machine_max_jerk_e",
    "machine_max_junction_deviation",
}
PRINT_VARIANT = {
    "initial_layer_speed", "initial_layer_infill_speed", "outer_wall_speed", "inner_wall_speed",
    "small_perimeter_speed", "small_perimeter_threshold", "sparse_infill_speed",
    "internal_solid_infill_speed", "top_surface_speed", "enable_overhang_speed",
    "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed",
    "slowdown_for_curled_perimeters", "bridge_speed", "internal_bridge_speed", "gap_infill_speed",
    "support_speed", "support_interface_speed", "travel_speed", "travel_speed_z",
    "initial_layer_travel_speed", "default_acceleration", "bridge_acceleration",
    "travel_acceleration", "initial_layer_travel_acceleration", "initial_layer_acceleration",
    "outer_wall_acceleration", "inner_wall_acceleration", "sparse_infill_acceleration",
    "internal_solid_infill_acceleration", "top_surface_acceleration", "default_jerk",
    "outer_wall_jerk", "inner_wall_jerk", "infill_jerk", "top_surface_jerk", "initial_layer_jerk",
    "travel_jerk", "initial_layer_travel_jerk", "default_junction_deviation", "print_extruder_id",
    "print_extruder_variant", "top_solid_infill_flow_ratio",
}
FILAMENT_VARIANT = {
    "filament_flow_ratio", "filament_max_volumetric_speed", "filament_ramming_volumetric_speed",
    "filament_pre_cooling_temperature", "filament_ramming_travel_time",
    "filament_ramming_volumetric_speed_nc", "filament_pre_cooling_temperature_nc",
    "filament_ramming_travel_time_nc", "filament_retract_length_nc",
    "filament_preheat_temperature_delta", "filament_extruder_variant", "filament_retraction_length",
    "filament_z_hop", "filament_z_hop_types", "filament_retract_lift_above",
    "filament_retract_lift_below", "filament_retract_lift_enforce", "filament_retract_restart_extra",
    "filament_retract_length_toolchange", "filament_retract_restart_extra_toolchange",
    "filament_retraction_speed", "filament_deretraction_speed", "filament_retraction_minimum_travel",
    "filament_retract_when_changing_layer", "filament_wipe", "filament_wipe_distance",
    "filament_retract_before_wipe", "filament_retract_after_wipe",
    "filament_long_retractions_when_cut", "filament_retraction_distances_when_cut",
    "long_retractions_when_ec", "retraction_distances_when_ec", "nozzle_temperature_initial_layer",
    "nozzle_temperature", "filament_flush_volumetric_speed", "filament_flush_temp",
    "filament_cooling_before_tower", "volumetric_speed_coefficients",
    "filament_adaptive_volumetric_speed", "filament_ironing_flow", "filament_ironing_spacing",
    "filament_ironing_inset", "filament_ironing_speed", "enable_pressure_advance",
    "pressure_advance", "adaptive_pressure_advance", "adaptive_pressure_advance_model",
    "adaptive_pressure_advance_overhangs", "adaptive_pressure_advance_bridges", "fan_min_speed",
    "fan_max_speed", "additional_cooling_fan_speed", "filament_minimal_purge_on_wipe_tower",
    "filament_multitool_ramming", "filament_multitool_ramming_volume",
    "filament_multitool_ramming_flow", "nozzle_temperature_range_low",
    "nozzle_temperature_range_high", "activate_air_filtration",
    "activate_air_filtration_during_print", "activate_air_filtration_on_completion",
    "during_print_exhaust_fan_speed", "complete_print_exhaust_fan_speed",
}
# one value per physical extruder
PRINTER_PER_EXTRUDER = {
    "extruder_type", "nozzle_diameter", "default_nozzle_volume_type", "nozzle_volume_type",
    "extruder_printable_area", "extruder_bed_exclude_volumes", "extruder_printable_height",
    "min_layer_height", "max_layer_height", "extruder_max_nozzle_count", "extruder_offset",
}
# Keys that only mean something to the desktop app or to a two-nozzle setup.
DROP = {
    "from", "setting_id", "instantiation", "include", "inherits", "upward_compatible_machine",
    "compatible_printers", "compatible_printers_condition", "compatible_prints",
    "compatible_prints_condition", "base_id", "description", "renamed_from",
    "extruder_variant_list", "filament_extruder_id", "printer_settings_id", "print_settings_id",
    "filament_settings_id", "filament_vendor",
}


def load_index(vendor_dir: Path) -> dict[str, tuple[Path, dict]]:
    idx: dict[str, tuple[Path, dict]] = {}
    for sub in ("machine", "process", "filament"):
        for f in sorted((vendor_dir / sub).glob("*.json")):
            j = json.loads(f.read_text(encoding="utf-8"))
            idx[j.get("name", f.stem)] = (f, j)
    return idx


def chain(idx, name: str) -> list[tuple[Path, dict]]:
    """[root ... name] following `inherits`, plus each level's `include` files."""
    out = []
    seen = set()
    cur = name
    while cur:
        if cur in seen:
            raise SystemExit(f"inherits loop at {cur!r}")
        seen.add(cur)
        if cur not in idx:
            raise SystemExit(f"profile not found: {cur!r}")
        f, j = idx[cur]
        level = [(f, j)]
        for inc in j.get("include", []) or []:
            if inc not in idx:
                raise SystemExit(f"include not found: {inc!r} (from {cur!r})")
            level.append(idx[inc])
        out[:0] = level  # parents first
        cur = j.get("inherits") or ""
    return out


def resolve(idx, name: str) -> dict:
    merged: dict = {}
    for _, j in chain(idx, name):
        merged.update(j)
    merged["name"] = name
    return merged


def pick(arr, i: int):
    return arr[i] if i < len(arr) else arr[0]


def collapse_variants(cfg: dict, kind: str, variant: str, extruder: int) -> dict:
    """Keep only `variant` of every per-variant array (and extruder `extruder`
    of every per-extruder one), so a multi-nozzle profile becomes the profile
    of a one-nozzle printer that is that nozzle."""
    vkey = {"machine": "printer_extruder_variant", "process": "print_extruder_variant",
            "filament": "filament_extruder_variant"}[kind]
    variants = cfg.get(vkey)
    vi = 0
    if isinstance(variants, list) and variants:
        if variant not in variants:
            raise SystemExit(f"{cfg['name']}: variant {variant!r} not in {variants}")
        vi = variants.index(variant)
        n = len(variants)
    else:
        n = 1
    keys = {"machine": PRINTER_VARIANT_1, "process": PRINT_VARIANT, "filament": FILAMENT_VARIANT}[kind]
    out = {}
    for k, v in cfg.items():
        if k in DROP:
            continue
        if isinstance(v, list):
            if kind == "machine" and k in PRINTER_VARIANT_2 and n > 1 and len(v) == 2 * n:
                v = v[2 * vi: 2 * vi + 2]
            elif k in keys and n > 1 and len(v) == n:
                v = [v[vi]]
            elif kind == "machine" and k in PRINTER_PER_EXTRUDER and len(v) > 1:
                v = [pick(v, extruder - 1)]
        out[k] = v
    if kind == "machine":
        out["printer_extruder_id"] = ["1"]
        out["printer_extruder_variant"] = [variant]
    elif kind == "process":
        out["print_extruder_id"] = ["1"]
        out["print_extruder_variant"] = [variant]
    else:
        out["filament_extruder_variant"] = [variant]
    return out


GCODE_KEYS = (
    "machine_start_gcode", "machine_end_gcode", "layer_change_gcode", "before_layer_change_gcode",
    "change_filament_gcode", "time_lapse_gcode", "printing_by_object_gcode", "machine_pause_gcode",
    "template_custom_gcode", "change_extrusion_role_gcode", "wrapping_detection_gcode",
)


def adapt_gcode(text: str, placeholders: dict[str, str], rewrites) -> str:
    """Substitute engine-unknown placeholders in one G-code template.

    OrcaSlicer's macro language has two forms: `{expression}` blocks, where a
    variable is a bare name (`filament_type[initial_filament_id]`), and the
    legacy `[variable]` outside braces (`T[initial_filament_id]`). Inside a
    block the name becomes the value; outside, `[name]` becomes the value."""
    for pat, rep in rewrites:
        text = re.sub(pat, rep, text)
    if not placeholders:
        return text
    names = "|".join(map(re.escape, placeholders))
    inner = re.compile(rf"\b({names})\b")
    legacy = re.compile(rf"\[({names})\]")
    out, pos = [], 0
    for m in re.finditer(r"\{[^{}]*\}", text):
        out.append(legacy.sub(lambda g: placeholders[g.group(1)], text[pos:m.start()]))
        out.append(inner.sub(lambda g: placeholders[g.group(1)], m.group(0)))
        pos = m.end()
    out.append(legacy.sub(lambda g: placeholders[g.group(1)], text[pos:]))
    return "".join(out)


def build(recipe, vendor_dir: Path) -> tuple[dict, set[Path]]:
    idx = load_index(vendor_dir)
    used: set[Path] = set()

    def get(name, kind):
        for f, _ in chain(idx, name):
            used.add(f)
        return collapse_variants(resolve(idx, name), kind, recipe["variant"], recipe["extruder"])

    raw_machine = resolve(idx, recipe["machine"])
    machine = get(recipe["machine"], "machine")
    for k in GCODE_KEYS:
        if isinstance(machine.get(k), str):
            machine[k] = adapt_gcode(machine[k], recipe.get("placeholders", {}), recipe.get("rewrites", []))
    for k in recipe.get("blank", []):
        machine[k] = ""
    # printable_area entries sometimes carry stray spaces ("0x256 ")
    if isinstance(machine.get("printable_area"), list):
        machine["printable_area"] = [p.strip() for p in machine["printable_area"]]
    xs = [float(p.split("x")[0]) for p in machine["printable_area"]]
    ys = [float(p.split("x")[1]) for p in machine["printable_area"]]
    printer = {
        "id": recipe["id"], "label": recipe["label"],
        "bed": [max(xs) - min(xs), max(ys) - min(ys), float(machine.get("printable_height", 250))],
        "nozzle": float(machine["nozzle_diameter"][0]),
        "flavor": machine.get("gcode_flavor", "marlin"),
        "source": {"machine": recipe["machine"]},
    }
    # The vendor's printer-model file (named after printer_model) carries the id
    # Bambu firmware checks a sliced file against ("N6" for the X2D), and the
    # physical nozzles are reported as the printer has them, both of them, so
    # the printer's own compatibility check sees its real hardware.
    model_file = vendor_dir / "machine" / f"{raw_machine.get('printer_model', '')}.json"
    if model_file.exists():
        used.add(model_file)
        printer["model_id"] = json.loads(model_file.read_text(encoding="utf-8")).get("model_id", "")
    printer["physical"] = {
        "extruder_type": raw_machine.get("extruder_type", ["Direct Drive"]),
        "nozzle_diameter": raw_machine.get("nozzle_diameter", [str(printer["nozzle"])]),
        "extruder": recipe["extruder"],
    }
    processes = []
    for p in recipe["processes"]:
        processes.append({"id": p["id"], "label": p["label"], "default": p.get("default", False),
                          "preset": p["preset"], "config": get(p["preset"], "process")})
    filaments = []
    for f in recipe["filaments"]:
        entry = {"id": f["id"], "label": f["label"], "default": f.get("default", False),
                 "preset": f["preset"], "config": get(f["preset"], "filament")}
        # Bambu's own filament id (what the AMS reads off a spool and a sliced
        # file names in slice_info.config). OrcaSlicer's profiles carry their own
        # "OF..." ids in filament_id, but the setting_id keeps Bambu's code:
        # "GFSA00_08" is filament GFA00 (Bambu PLA Basic), "GFSL99_17" GFL99.
        sid = resolve(idx, f["preset"]).get("setting_id", "")
        m = re.match(r"GFS([A-Z]\d\d)", sid)
        if m:
            entry["tray_id"] = "GF" + m.group(1)
        filaments.append(entry)
    return {"printer": printer, "machine": machine, "processes": processes, "filaments": filaments}, used


def vendor_from(orca: Path):
    """Copy every file the recipes reach out of an OrcaSlicer checkout."""
    import subprocess
    for recipe in RECIPES:
        src = orca / "resources" / "profiles" / recipe["vendor"]
        _, used = build(recipe, src)
        dst = HERE / recipe["vendor"]
        if dst.exists():
            shutil.rmtree(dst)
        for f in sorted(used):
            rel = f.relative_to(src)
            (dst / rel.parent).mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst / rel)
        try:
            commit = subprocess.run(["git", "-C", str(orca), "rev-parse", "HEAD"], capture_output=True,
                                    text=True, check=True).stdout.strip()
        except Exception:
            commit = "unknown"
        (dst / "SOURCE.txt").write_text(
            f"Copied from OrcaSlicer (https://github.com/OrcaSlicer/OrcaSlicer)\n"
            f"commit {commit}, resources/profiles/{recipe['vendor']}/\n"
            f"License: AGPL-3.0. Only the files the recipes in build.py reach are kept.\n", encoding="utf-8")
        print(f"vendored {len(used)} files -> {dst.relative_to(ROOT)}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vendor-from", type=Path, help="OrcaSlicer checkout to copy profiles from")
    a = ap.parse_args(argv)
    if a.vendor_from:
        vendor_from(a.vendor_from)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for recipe in RECIPES:
        data, _ = build(recipe, HERE / recipe["vendor"])
        out = OUT_DIR / f"{recipe['id']}.json"
        out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        index.append({"id": recipe["id"], "label": recipe["label"], "file": out.name})
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
    (OUT_DIR / "index.json").write_text(json.dumps({"printers": index}, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
