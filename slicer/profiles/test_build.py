"""Tests for slicer/profiles/build.py.   python3 slicer/profiles/test_build.py"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402


class AdaptGcode(unittest.TestCase):
    P = {"initial_filament_id": "0", "current_nozzle_id": "0"}

    def test_names_inside_braces_become_values(self):
        out = build.adapt_gcode("M104 S{nozzle_temperature[initial_filament_id]}", self.P, [])
        self.assertEqual(out, "M104 S{nozzle_temperature[0]}")

    def test_legacy_square_placeholders_outside_braces(self):
        self.assertEqual(build.adapt_gcode("T[initial_filament_id] H[x]", self.P, []), "T0 H[x]")

    def test_other_names_and_partial_matches_untouched(self):
        src = "{if my_initial_filament_id_2 == 1}[initial_filament_ids]{endif}"
        self.assertEqual(build.adapt_gcode(src, self.P, []), src)

    def test_rewrites_run_first(self):
        out = build.adapt_gcode("H{nozzle_diameter_at_nozzle_id[current_nozzle_id]}", self.P,
                                [(r"nozzle_diameter_at_nozzle_id\[[a-z_0-9]+\]", "nozzle_diameter[0]")])
        self.assertEqual(out, "H{nozzle_diameter[0]}")


class CollapseVariants(unittest.TestCase):
    def test_machine_variant_and_silent_pairs(self):
        cfg = {
            "name": "m",
            "printer_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow", "Bowden Standard"],
            "retraction_length": ["0.8", "0.9", "2"],
            "machine_max_speed_e": ["30", "31", "40", "41", "120", "121"],   # (normal, silent) per variant
            "nozzle_diameter": ["0.4", "0.6"],
            "include": ["x"],
        }
        out = build.collapse_variants(cfg, "machine", "Direct Drive High Flow", 2)
        self.assertEqual(out["retraction_length"], ["0.9"])
        self.assertEqual(out["machine_max_speed_e"], ["40", "41"])
        self.assertEqual(out["nozzle_diameter"], ["0.6"])            # per extruder: extruder 2
        self.assertEqual(out["printer_extruder_variant"], ["Direct Drive High Flow"])
        self.assertNotIn("include", out)

    def test_unknown_variant_is_an_error(self):
        with self.assertRaises(SystemExit):
            build.collapse_variants({"name": "f", "filament_extruder_variant": ["A"]}, "filament", "B", 1)


class BuiltPrinterFile(unittest.TestCase):
    """The committed web/slicer/printers files: one nozzle, nothing left that the
    2.4.2 engine can't parse (the substitutions in RECIPES)."""

    def test_x2d(self):
        d = json.loads((build.OUT_DIR / "bambu-x2d-0.4.json").read_text(encoding="utf-8"))
        m = d["machine"]
        self.assertEqual(m["nozzle_diameter"], ["0.4"])
        self.assertEqual(d["printer"]["model_id"], "N6")
        self.assertEqual(d["printer"]["bed"], [256.0, 256.0, 261.0])
        for k in build.GCODE_KEYS:
            for name in ("initial_filament_id", "initial_no_support_filament_id", "initial_nozzle_id",
                         "nozzle_diameter_at_nozzle_id", "current_filament_id", "current_nozzle_id"):
                self.assertNotIn(name, m.get(k, ""), f"{k} still uses {name}")
        self.assertEqual(m["time_lapse_gcode"], "")
        self.assertTrue(all(f.get("tray_id", "").startswith("GF") for f in d["filaments"]))
        self.assertEqual(sum(p["default"] for p in d["processes"]), 1)


if __name__ == "__main__":
    unittest.main()
