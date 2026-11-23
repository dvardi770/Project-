# Ring lab: 3D configurator and render studio

Built straight from the jeweller's CAD files: a live 3D viewer, an automatic fit check for
mixing heads and shanks, and a render studio that makes product photos from four angles and a
360° video for every metal, centre-stone shape and diamond colour. The ring builder shows the
renders and the 3D view for settings that have them (see "Rendered photos, 360° video and 3D"
in the main README).

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
  - **Centre-stone shapes**: any cut found in the loaded files (round, oval, cushion…) can
    replace the centre stone. It is scaled to the head's seat (as large as fits in the original
    stone's outline, at the same girdle height). A head made for another shape would place its
    prongs differently, so this shows the stone, not a production head.
  - **Fancy colours**: yellow, pink and blue diamonds, besides sapphire, ruby and emerald.
  - **White product studio** (`studio: 'white'`): the ring and its shadow are laid over pure
    white after tone mapping. The metal is lit like a light tent: bright softboxes over a
    mid-grey surround and a bright table, with dark-grey cards (never black) for edge lines, so
    no turn of the ring shows black metal. Stones get their own darker, high-contrast lighting.
  - **Stones**: at each facet part of the light leaves and part reflects back inside (Fresnel),
    beyond the critical angle all of it, and the reflected part keeps going: that is the
    brilliance. Accent stones get softened fire, since a camera blends their few pixels.
  - **Finished images** average sub-pixel-shifted samples. After the first, each sample traces
    one of red, green or blue through the stones at a slightly varied index of refraction (fire
    across the spectrum at a third of the cost). `aperture` adds a little depth of field (the
    camera moves within the lens opening while the focus plane stays put) and `glare` a soft
    glow around the brightest sparkles. Stones draw only their front faces (mirrored placements
    get mirrored copies), which nearly halved render time.
  - **Views and pose**: angled, front, side and top, fitted to the ring's own surface points;
    `pose: 'flat'` lays the ring on its side as it would rest on a table (touching with band and
    head), and the `turntable` view films it from about 32° as it turns under fixed lights.
  - **Embed mode** (`index.html?embed&studio=white&head=&shank=&metal=&stone=&shape=&rotate=1`):
    only the stage, for the ring builder and the render studio page. Pages that frame it can
    change choices with `postMessage({ type: 'ring-viewer:set', options })`.
  - `window.ringViewer` lets scripts set a configuration (`show`, `prepare`), render a still
    right away (`renderNow`), path trace it (`photo`) and capture it (`capture`).
- **Render studio** (`src/renderMedia.mjs`): for every fitting head and shank, in each metal,
  shape and colour, four photos of the ring standing (WebP, 1200 px and half size) and a 360°
  turntable of it lying down (720 px, 180 frames at 30 fps, H.264 MP4 at CRF 18 with
  `+faststart`, no audio, a seamless loop, plus its first frame as a poster), and
  `media/manifest.json`. Photos are also path traced by default (`--image-quality photo`).
  Variants render most-wanted first; finished ones are skipped on a re-run. Needs ffmpeg.
- **Render studio page** (`viewer/gallery.html`): a product page with the photos, thumbnails
  for the four angles, the 360° video and live 3D, and choices for setting, metal, shape and
  colour. Combinations not yet rendered are shown in live 3D.
- **Catalogue renderer** (`src/renderCatalogue.mjs`) drives the viewer in headless Chromium
  (Playwright) and saves a PNG of every fitting head and shank in each metal and stone, plus
  `catalogue/manifest.json`. The viewer shows them as a gallery.

## Running it

```
# rings.config.json, next to the .3dm files:
# [{ "file": "oval.3dm", "label": "3 oval file", "head": "Three-stone oval", "shank": "Plain band" }]
node src/convert.mjs path/to/rings.config.json out
node src/fitCheck.mjs out
node src/renderMedia.mjs out --metals white,yellow,rose --colours white,yellow,pink,blue --shapes all
npx serve out          # or any static server; open index.html (3D) or gallery.html (render studio)
```

To serve renders to the ring builder, put each output folder in the API's `RENDERS_DIR` under a
collection name and set the setting's `renderKey` to `"<collection>/<combo id from the manifest>"`.

## Why it looks real and loads fast

- The approach is the one iJewel's batch renderer (BatchX) describes: a real-time engine renders
  every metal × stone × view as images and 360° turntables, with separate lighting for metal and
  for stones. Diamonds get their fire the way offline renderers such as Blender's Cycles fake it:
  red, green and blue bend by slightly different amounts.
- Shoppers never wait for rendering: they download finished files. Photos are WebP in two sizes
  (phones take the half-size one, about 5–40 KB on white); the 360° video is a short H.264 MP4
  that starts streaming at once and loads only when opened; the 3D engine loads only on request.

## Speed

Measured on the build machine, which has no GPU (Chromium's software renderer, 4 cores): a
1200 px photo with 25 samples takes about 10 s, a 720 px turntable frame with 13 samples about
2.4 s, so one variant (four photos and a 180-frame video) about 8 minutes, most of it the video.
The stones are most of the cost (the metal alone is about a fifth). A machine with a GPU should
be many times faster; pass Chromium flags that enable it through `RING_LAB_CHROMIUM_ARGS`.

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
- Shapes other than a head's own are fitted to its seat for display; production needs a head
  per shape. The fit check does not check stone shapes.
- Fancy-colour diamonds are not in the diamond data yet, so the ring builder always shows
  white diamonds; the render studio page offers all colours.
- No ring sizing.
