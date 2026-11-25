# Ring lab: ring and band builders, CAD configurator and render studio

## Ring builder and band builder (`configurator/`)

Two live 3D builders in which every part is made from measurements, so any combination fits and
nothing needs a CAD file per variant: an **engagement ring builder** and a **wedding band builder**
for a pair of rings.

- **Gem cuts** (`engine/cuts.mjs`) are made the way a cutter specifies them: each facet is a plane
  (its direction round the stone and its slope), and the stone is the space inside all of them. Round,
  oval, cushion and pear brilliants with excellent proportions (table 56%, crown 34.5°, pavilion
  40.75°, 8 bezel, 8 star, 16 upper-half, 8 main and 16 lower-half facets, faceted girdle), an
  emerald step cut, princess and marquise. Sizes come from carats: a 1 ct round is 6.4 mm, a 1 ct
  oval 7.7 × 5.6 mm, as real stones are (weights use each gem's density). Accent stones use a
  simpler cut with 33 facets, since they are a few pixels across.
- **Ring parts** (`engine/ring.mjs`, `engine/geometry.mjs`): heads are prongs swept along curves
  round the stone's outline, with basket rails; halos of small stones set tight round the centre
  stone, with the centre's prongs rising through gaps between them; hidden and secret halos under
  the girdle; bezels and tulip petals. Shanks are cross-sections swept round the finger (tapering,
  comfort fit, flutes, French and U-pavé scallops), twisted or braided wires, and rows of pavé
  (beads over the stones' edges, shared between rows) or eight-stone settings. Cathedral shoulders
  are arches that leave the band and rise to the basket, open underneath. Channel stones sit in a
  groove cut along the band, tables just below the walls that hold them (bands too). Every combination builds in 10–40 ms. Metal
  weight comes from the closed meshes' volume (a typical ring: 2.5–3.5 g), carats from each stone.
- **Bands** (`engine/band.mjs`): eight profiles, width 2–10 mm, thickness matched to width or set,
  seven outer shapes (oval, cushion, hexagon, octagon, wave, wavy…), one or two metals (halves,
  centre stripe, edges, inside), a finish per metal, grooves, diamonds (flush solitaire or three,
  channel or pavé line, half or all round) and engraving inside. Weights use the cross-section's
  area (Pappus): a 4 mm 14k band is about 5 g.
- **Stage** (`engine/stage.mjs`), built for 60 frames per second on phones:
  - Stones are traced through their own facet planes in the shader, with Fresnel reflection at each
    facet and up to 7 bounces. While the ring turns, fire is added where light leaves the stone (one
    trace instead of three); when it stops, the picture is refined over 14 steps, each tracing red,
    green and blue separately at slightly varied refractive indices, with sub-pixel offsets.
  - Metal: physically based, in a studio of softboxes rendered once into an environment map;
    polished, satin (anisotropic), matte and hammered finishes at real scale.
  - Ambient occlusion baked per vertex on the GPU each time the design changes: the design is
    seen from 64 directions and each metal vertex counts how much of the studio it can see, so
    crevices under the basket, between prongs and halo stones and inside the band are shaded as in
    a photo. A few directions are done per frame and the shading fades in, so a change never
    stalls the turning ring, and it costs nothing afterwards.
  - Softboxes with soft, diffused edges (bright centre, fading edges) and small crisp lights for
    sparkle, rendered once into environment maps.
  - A contact shadow baked once per design; glow round the brightest sparkles; Khronos PBR Neutral
    tone mapping (made for product colours); 4× multisampling.
  - The resolution adapts to keep frames near 16 ms, rendering stops when nothing changes or the
    stage is off screen, and shaders for every cut are compiled in the background.
  - Views move smoothly to what a choice changes (head, top, side, the inside for engraving).
    Engraving is drawn into relief, colour and roughness maps on the band's inside.
- **Pages**: `ring-builder.html` and `band-builder.html`, mobile first (stage on top, choices
  below, price bar at the bottom), with live thumbnails of heads and shanks, a price breakdown,
  total carats and grams, share links, `?embed`, `?stats` (frames per second), and add-to-cart events
  for the store page. `engine/pricing.mjs` holds the sample price list.

Serve the folder with any static server (`npx serve configurator`) and open either page. Test:
`pnpm test` (cuts, rings, bands, prices) and `pnpm --filter @jewelry/ring-lab test:e2e` (both pages
in Chromium).

Not done in the builders yet: try-on on the shopper's hand (camera and hand tracking); server-side
pricing and the cart hand-off into Shopify/WooCommerce (the pages emit the design, specs and price);
a real stone from the diamond feed as the centre stone; frame rates measured on phones (built and
tested here only in software rendering, which has no GPU).

## CAD configurator and render studio

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
  Variants render most-wanted first; finished ones are skipped on a re-run. A run adds to the
  manifest rather than replacing it, so a long job can be split (one run per shape, or a metal
  added later) and every finished variant stays listed. Needs ffmpeg.
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
