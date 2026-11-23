# Ring lab (prototype)

A test bed for a 3D ring configurator built straight from the jeweller's CAD files. It is
not wired into the API, widget or dashboard yet.

- **Converter** (`src/convert.mjs`) reads Rhino / MatrixGold `.3dm` files with `rhino3dm`,
  keeps the visible `Metal*` and `Gem*` layers, and splits each ring into its **head** (the
  centre stone and what holds it) and its **shank** (the band, including pavé on it). It
  keeps the render meshes and exact surface normals saved in the file, and stones placed as
  blocks (one cut, many placements). It also works out, once:
  - ambient occlusion for every metal vertex (crevices under a halo or between prongs are
    darker, as in a photo);
  - each stone cut's facet planes (its convex hull) and whether the cut is convex.
- **Compact data** (`src/meshData.mjs`): positions quantised to 16 bits per mesh, octahedral
  normals and occlusion in a 12-byte vertex, compressed with meshoptimizer's codecs (the ones
  glTF's `EXT_meshopt_compression` uses). For the two test rings: 3.5 MB of base64 down to
  1.3 MB (0.8 MB gzipped). The viewer has its own copy of the decoder; keep them in step.
- **Fit check** (`src/fitCheck.mjs`) decides which heads may go on which shanks. Each
  uploaded ring is a known-good pair, so the original pair teaches the joint: the band
  surface the original head covers and the head surface the band supports. Another head
  fits when, after seating it (moving it up to 1.5 mm up or down), it covers at least 85%
  of the joint on both arms and its own joint rests on the band. 60–85% means a person
  should look; below that the mix is never offered. About 0.1 s per pair on one core.
- **Viewer** (`viewer/index.html`), three.js:
  - Metal: studio environment, the CAD's normals, baked occlusion.
  - Stones: ray traced in the shader through their real facets, with each stone's
    refractive index, colour absorption and dispersion (fire). Convex cuts are traced
    against their facet planes (exact and cheap); other cuts use a triangle BVH
    (`three-mesh-bvh`).
  - Smooth while moving (quality steps down when frames are slow), sharp when still
    (24 jittered full-quality frames averaged).
  - **Photo quality** button: path traces the metal with `three-gpu-pathtracer` (light
    bouncing between metal parts, computed shadows). Stones are held out and come from the
    still image: MatrixGold keeps stone seats as separate cutter objects, so the metal
    under each stone is solid and a path tracer would show the stones nearly black.
  - Mixes that don't fit are switched to a part that fits.
  - `window.ringViewer` lets scripts set a configuration, wait for the finished image and
    capture it.
- **Catalogue renderer** (`src/renderCatalogue.mjs`) drives the viewer in headless Chromium
  (Playwright) and saves a PNG of every fitting head and shank in each metal and stone, plus
  `catalogue/manifest.json`. The viewer shows them as a gallery.

## Running it

```
# rings.config.json, next to the .3dm files:
# [{ "file": "oval.3dm", "label": "3 oval file", "head": "Three-stone oval", "shank": "Plain band" }]
node src/convert.mjs path/to/rings.config.json out
node src/fitCheck.mjs out
node src/renderCatalogue.mjs out --metals white,yellow,rose --stones diamond --quality photo --samples 240 --size 1024
npx serve out          # or any static server; open index.html
```

The catalogue renderer serves the viewer's libraries from `node_modules`, so it needs no
internet access. It needs Playwright's Chromium (`npx playwright install chromium` on a new
machine) and renders in software by default, which is slow: on the build machine without a
GPU, 64 path-traced samples at 640 px took about a minute per image. On a machine with a
GPU, pass Chromium flags that enable it through `RING_LAB_CHROMIUM_ARGS`.

`pnpm test` at the repository root runs the fit check's test (box shapes instead of real CAD
files) and the compressed-data round-trip test.

## Not done

- Customer CAD files are not committed; keep them out of the repository.
- The split into head and shank is a placement rule tuned on two MatrixGold rings. Other
  designers' files may need the person uploading to confirm the split.
- The fit check has only been run on two real rings, which were not designed to share
  parts, so it has only been seen rejecting real mixes. Accepting a real interchangeable
  pair is covered by the unit test, not by real files.
- Photo mode reaches into `three-gpu-pathtracer` 0.0.23 only through its public API; the
  newer releases need a newer three.js than the viewer uses.
- Only tested in Chromium without a GPU; not yet on a phone.
- No pricing, cart, ring sizing, or Nivoda stone swap.
