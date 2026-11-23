# Ring lab (prototype)

A test bed for a 3D ring configurator built straight from the jeweller's CAD files. It is
not wired into the API, widget or dashboard yet.

- **Converter** (`src/convert.mjs`) reads Rhino / MatrixGold `.3dm` files with `rhino3dm`,
  keeps the visible `Metal*` and `Gem*` layers, and splits each ring into its **head** (the
  centre stone and what holds it) and its **shank** (the band, including pavé on it). It
  keeps the render meshes and exact surface normals saved in the file, and stones placed
  as blocks (one cut, many placements).
- **Fit check** (`src/fitCheck.mjs`) decides which heads may go on which shanks. Each
  uploaded ring is a known-good pair, so the original pair teaches the joint: the band
  surface the original head covers and the head surface the band supports. Another head
  fits when, after seating it (moving it up to 1.5 mm up or down), it covers at least 85%
  of the joint on both arms and its own joint rests on the band. 60–85% means a person
  should look; below that the mix is never offered. About 0.1 s per pair on one core.
- **Viewer** (`viewer/index.html`) shows the rings in three.js. Metal is lit by a studio
  environment; stones are ray traced through their real facets (`three-mesh-bvh`), with each
  stone's refractive index and colour absorption. Mixes that don't fit are switched to a part
  that fits.

## Running it

```
# rings.config.json, next to the .3dm files:
# [{ "file": "oval.3dm", "label": "3 oval file", "head": "Three-stone oval", "shank": "Plain band" }]
node src/convert.mjs path/to/rings.config.json out
node src/fitCheck.mjs out
npx serve out          # or any static server; open index.html
```

`pnpm test` at the repository root runs the fit check's unit test, which uses simple box
shapes instead of real CAD files.

## Not done

- Customer CAD files are not committed; keep them out of the repository.
- The split into head and shank is a placement rule tuned on two MatrixGold rings. Other
  designers' files may need the person uploading to confirm the split.
- The fit check has only been run on two real rings, which were not designed to share
  parts, so it has only been seen rejecting real mixes. Accepting a real interchangeable
  pair is covered by the unit test, not by real files.
- No pricing, cart, ring sizing, or Nivoda stone swap.
