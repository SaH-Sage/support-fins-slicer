# Support Fins Slicer

A fork of [Support Fins](https://github.com/gittrahan/support-fins) that adds the last
step: **slice the plate for a printer and save the file for its USB stick**, in the
browser, with nothing to install. Built for a school that may not install software.

Everything else is Support Fins as it is: import, rotate, fins, plates, arrange.

## Using it

1. Import a model, rotate it, click **Add fins** (as on printfins.com).
2. Click **Slice** (top bar). Pick the printer, quality, filament and build plate.
   The site's build volume, nozzle and layer height are set to match, and the fins
   rebuild for them: the grip tines must be exactly one layer tall.
3. Click **Slice**. The **preview** opens: the toolpaths layer by layer on the bed,
   coloured by what each line is (walls, infill, top surface...). Drag the slider
   (or use the arrow keys) to go through the layers; "Only this layer" and "Travel
   moves" show one layer's paths and the moves between them. Check the fins came out
   as walls under the overhangs.
4. **Save for USB stick**. Copy the `.gcode.3mf` file to the stick, plug it into
   the printer and start the print from the printer's screen.

Each plate is sliced on its own (like "Slice plate" in Bambu Studio); several models
on one plate are sliced together, each as its own object so the printer can skip one.

The first slice downloads the engine (about 37 MB); the browser keeps it after that.

## Printers

| Printer | Notes |
|---|---|
| Bambu Lab X2D, 0.4 mm nozzle | Nozzle 1 (the direct-drive one, filament 1 in Bambu Studio) only. Five qualities (0.08–0.24 mm), Bambu PLA Basic, PLA, Bambu PETG HF, PETG, TPU; textured or smooth PEI plate. |

### Before the first real print

The G-code has been checked by reading it, not yet by a printer. Print a small part
first and watch:

- the start: bed levelling, heating to the filament's temperatures, then the purge line;
- that the printer accepts the file from the USB stick at all (if it doesn't list or
  start the `.gcode.3mf`, try **Plain .gcode instead**, and tell us which worked);
- the first layer.

What was adapted for the X2D, and why, is in `profiles/build.py` (RECIPES): five
placeholders that Bambu's G-code uses but the OrcaSlicer 2.4.2 engine predates are
filled with the values OrcaSlicer 2.5 gives a one-filament, main-nozzle print, and the
timelapse block (camera only) is left out.

Checked against cubes Bambu Studio 2.9.1 sliced for an X2D (one cube on nozzle 1,
two cubes, and a two-colour cube): for the same cube on nozzle 1, the start and end
sequences match line for line apart from progress lines (M73), a slightly larger
bed-levelling area, and two "fans off" lines at the start; skip-object markers for
two objects are identical. Print speeds and accelerations match too; the time
estimate on the printer runs longer than Bambu Studio's (about 23 vs 17 minutes for
a 25.6 mm cube) because the two slicers estimate differently. All settings the two slicers share were compared
too; where OrcaSlicer's profile differed in a way that changes how the printer moves
(absolute instead of relative extrusion, arc fitting), the recipe sets Bambu
Studio's value.

## How it works

```
web/slicer/
  panel.js        the Slice dialog: settings, waiting for the fins, the result
  worker.js       runs the engine in a Web Worker
  package.js      the .gcode.3mf (Bambu's sliced-3MF layout), stats from the G-code
  thumb.js        the plate picture the printer shows
  md5.js          the G-code checksum the 3MF carries
  preview/        the slice preview: preview.js (viewer), gcode-parse.js + parse-worker.js
                  (toolpaths from the G-code), lines/ (three.js r185 thick-line add-ons)
  printers/       one JSON per printer (built, don't edit by hand) + index.json
  engine/         the engine, downloaded (not in git)
slicer/
  engine.json     which engine build, where from, its SHA-256
  fetch-engine.py downloads it into web/slicer/engine/
  profiles/       build.py + the OrcaSlicer vendor profiles it reads
```

- **Engine:** OrcaSlicer 2.4.2 compiled to WebAssembly by
  [OrcaWeb](https://github.com/Hiosdra/OrcaWeb), single-threaded build `wasm-v2.4.2-patch17`,
  pinned by checksum. Later OrcaWeb releases changed the engine's API, and the newest
  need cross-origin isolation, which GitHub Pages can't provide.
- **Profiles:** OrcaSlicer's own Bambu Lab profiles (`profiles/BBL/`, copied from the
  OrcaSlicer commit in `profiles/BBL/SOURCE.txt`). `build.py` resolves their
  inheritance, merges the G-code templates, and reduces the X2D's two-nozzle arrays to
  the main nozzle the way OrcaSlicer's `PrintConfig.cpp` indexes them.
- **G-code templates:** from Bambu Studio itself (`profiles/BBL-BambuStudio/`, tag
  `v02.09.01.70`), because Bambu updates them along with the printer's firmware. To
  refresh: check out a newer Bambu Studio tag, change `tag` in the recipe, run
  `build.py --templates-from /path/to/BambuStudio`, and compare against a plate that
  version of Bambu Studio sliced.
- **Fins:** the fins are baked into each model's mesh before slicing, exactly as the
  site's STL export does, so the slicer's own supports stay off.

### Adding a printer

Add a recipe to `RECIPES` in `profiles/build.py` (machine, qualities, filaments from an
OrcaSlicer vendor folder), then:

```
python3 slicer/profiles/build.py --vendor-from /path/to/OrcaSlicer   # copies the files the recipe needs
python3 slicer/profiles/test_build.py
```

Slice a test part and read the G-code before offering it to anyone. The planned
"import printer" button will build on the same printer files.

### Running it locally

```
python3 slicer/fetch-engine.py      # once: the engine
python3 dev-server.py               # http://localhost:8731/
```

Deployed by `.github/workflows/pages.yml` (Settings → Pages → Source: GitHub Actions).

## Keeping up with Support Fins

On GitHub, **Sync fork** pulls in gittrahan's changes. This fork touches only a few
upstream lines (one import in `web/app.js`, two `export` keywords in
`web/ui/export.js`, a guard on two workflow jobs so the fork never publishes plugin
releases, and `.gitignore`), so syncs merge cleanly.

## Licences

- Support Fins (everything from upstream): MIT, see `LICENSE`.
- The engine (OrcaSlicer/OrcaWeb) and the vendored OrcaSlicer profiles: AGPL-3.0,
  see `LICENSE-AGPL-3.0.txt`. The site serves the engine, so the combined site is
  offered under AGPL-3.0 terms; its complete source is this repository.
- This fork's additions (`web/slicer/`, `slicer/`, `tests/slicer_*`): AGPL-3.0. The
  preview's G-code parser is ported from the CraftBot-2-slicer project (AGPL-3.0);
  `web/slicer/preview/lines/` are unmodified three.js files (MIT).
