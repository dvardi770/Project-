/**
 * The live 3D stage for the ring and band builders, built for 60 frames per second on phones:
 *
 * - Metal: physically based, lit by a studio made of softboxes (rendered once into an
 *   environment map), with polished, satin (brushed), matte and hammered finishes.
 * - Stones: each pixel follows light through the stone's real facets (cuts.mjs), bouncing
 *   inside with Fresnel reflection. While the ring moves, fire (dispersion) is added where
 *   light leaves the stone, which costs one trace instead of three. When the ring stops, the
 *   frame is refined: sub-pixel samples, each tracing one colour at a slightly different
 *   refractive index, averaged into a still that is sharper and has full spectral fire.
 * - A soft contact shadow, baked once per design, and a glow round the brightest sparkles.
 * - Rendering is linear HDR into a 4× multisampled target; tone mapping (Khronos PBR Neutral,
 *   made for product colours) and the page background are applied last.
 * - Resolution adapts to keep frames under ~16 ms; rendering stops when nothing changes and
 *   when the stage is off screen.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cut } from './cuts.mjs';
import { GEMS, METALS, FINISHES } from './materials.mjs';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ─── Shaders ────────────────────────────────────────────────────────────────

const gemVertex = /* glsl */`
  varying vec3 vLocalPos;
  varying vec3 vLocalCam;
  varying vec3 vLocalNormal;
  varying vec3 vW0;
  varying vec3 vW1;
  varying vec3 vW2;
  varying float vScale;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = modelMatrix * instanceMatrix;
    #endif
    gl_Position = projectionMatrix * viewMatrix * (m * vec4(position, 1.0));
    vLocalCam = (inverse(m) * vec4(cameraPosition, 1.0)).xyz;
    vLocalPos = position;
    vLocalNormal = normal;
    vScale = length(m[0].xyz);
    vW0 = m[0].xyz / vScale;
    vW1 = m[1].xyz / vScale;
    vW2 = m[2].xyz / vScale;
  }`;

const gemFragment = /* glsl */`
  uniform vec4 planes[PLANES];
  uniform samplerCube envMap;
  uniform float ior;
  uniform float dispersion;
  uniform vec3 absorption;
  uniform float brightness;
  uniform int bounces;
  // -1: moving (fire added where light leaves); 0, 1, 2: trace only red, green or blue.
  uniform int channel;
  uniform float iorJitter;
  varying vec3 vLocalPos;
  varying vec3 vLocalCam;
  varying vec3 vLocalNormal;
  varying vec3 vW0;
  varying vec3 vW1;
  varying vec3 vW2;
  varying float vScale;

  vec3 studio(vec3 localDir) {
    return textureLod(envMap, normalize(mat3(vW0, vW1, vW2) * localDir), 0.0).rgb;
  }

  // The facet a ray inside the stone leaves through is the nearest plane ahead of it.
  float leave(vec3 p, vec3 d, out vec3 n) {
    float best = 1e6;
    n = -d;
    for (int i = 0; i < PLANES; i++) {
      vec4 pl = planes[i];
      float nd = dot(pl.xyz, d);
      if (nd > 1e-5) {
        float t = (pl.w - dot(pl.xyz, p)) / nd;
        if (t < best) { best = t; n = -pl.xyz; }
      }
    }
    return max(best, 0.0);
  }

  float fresnel(float f0, float cosT) { return f0 + (1.0 - f0) * pow(1.0 - cosT, 5.0); }

  // Light through the stone. eta: refractive index for this trace. spread > 0 adds fire at exits.
  vec3 trace(vec3 pos, vec3 dir, float eta, float spread) {
    float travelled = 0.0;
    vec3 light = vec3(0.0);
    float carried = 1.0;
    float f0 = pow((eta - 1.0) / (eta + 1.0), 2.0);
    for (int i = 0; i < BOUNCES; i++) {
      if (i >= bounces) break;
      vec3 n;
      float dist = leave(pos, dir, n);
      travelled += dist;
      pos += dir * dist;
      vec3 outDir = refract(dir, n, eta);
      if (dot(outDir, outDir) > 0.0) {
        float F = fresnel(f0, clamp(dot(outDir, -n), 0.0, 1.0));
        vec3 c;
        if (spread > 0.0) {
          vec3 outR = refract(dir, n, eta - spread);
          vec3 outB = refract(dir, n, eta + spread);
          c = vec3(studio(outR).r, studio(outDir).g, dot(outB, outB) > 0.0 ? studio(outB).b : 0.0);
        } else {
          c = studio(outDir);
        }
        light += carried * (1.0 - F) * c * exp(-absorption * (travelled * vScale + 0.8));
        carried *= F;
        if (carried < 0.035) return light;
      }
      dir = reflect(dir, n);
      pos += n * 0.0004;
    }
    return light + carried * studio(dir) * exp(-absorption * (travelled * vScale + 0.8));
  }

  void main() {
    vec3 V = normalize(vLocalPos - vLocalCam);
    vec3 N = normalize(vLocalNormal);
    if (dot(N, V) > 0.0) N = -N;
    float f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
    float F = fresnel(f0, clamp(dot(-V, N), 0.0, 1.0));
    vec3 reflected = studio(reflect(V, N));
    vec3 start = vLocalPos - N * 0.0006;
    vec3 inside;
    if (channel >= 0) {
      float eta = ior + (float(channel) - 1.0) * dispersion + iorJitter;
      vec3 t = trace(start, refract(V, N, 1.0 / eta), eta, 0.0);
      inside = 3.0 * t * vec3(equal(ivec3(channel), ivec3(0, 1, 2)));
    } else {
      inside = trace(start, refract(V, N, 1.0 / ior), ior, dispersion);
    }
    gl_FragColor = vec4((inside * (1.0 - F) + reflected * F) * brightness, 1.0);
  }`;

const quadVertex = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Khronos PBR Neutral tone mapping: keeps product colours true while rolling off highlights.
const composeFragment = /* glsl */`
  uniform sampler2D tColor;
  uniform sampler2D tGlow;
  uniform vec3 background;
  uniform float glow;
  uniform float exposure;
  varying vec2 vUv;
  vec3 neutral(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    const float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  void main() {
    vec4 c = texture2D(tColor, vUv);
    vec3 rgb = c.a > 1e-4 ? c.rgb / c.a : vec3(0.0);
    vec3 col = neutral(rgb * exposure) * c.a + background * (1.0 - c.a);
    col += texture2D(tGlow, vUv).rgb * glow;
    gl_FragColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), 1.0);
  }`;

const brightFragment = /* glsl */`
  uniform sampler2D tColor;
  uniform float threshold;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    vec3 rgb = c.rgb;
    float l = max(rgb.r, max(rgb.g, rgb.b));
    gl_FragColor = vec4(rgb * smoothstep(threshold, threshold * 1.8, l), 1.0);
  }`;

const blurFragment = /* glsl */`
  uniform sampler2D tColor;
  uniform vec2 step;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tColor, vUv).rgb * 0.227027;
    s += (texture2D(tColor, vUv + step * 1.3846).rgb + texture2D(tColor, vUv - step * 1.3846).rgb) * 0.316216;
    s += (texture2D(tColor, vUv + step * 3.2308).rgb + texture2D(tColor, vUv - step * 3.2308).rgb) * 0.070270;
    gl_FragColor = vec4(s, 1.0);
  }`;

const averageFragment = /* glsl */`
  uniform sampler2D tFrame;
  uniform sampler2D tSum;
  uniform float weight;
  varying vec2 vUv;
  void main() { gl_FragColor = mix(texture2D(tSum, vUv), texture2D(tFrame, vUv), weight); }`;

class Pass {
  constructor(fragmentShader, uniforms) {
    this.material = new THREE.ShaderMaterial({ vertexShader: quadVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}

// ─── Studio ─────────────────────────────────────────────────────────────────

/**
 * Softbox studio rendered into a cube map. Metal gets a bright light tent with grey cards for
 * polished contrast (never black, so no turn of the ring shows black metal); stones get a
 * darker, contrasty set, since dark areas are what make a diamond sparkle.
 */
function studioMaps(renderer) {
  const scene = new THREE.Scene();
  const dome = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: 1 }, mid: { value: 0.3 }, low: { value: 0.1 } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float top; uniform float mid; uniform float low; varying vec3 vDir;
      void main() { float y = vDir.y; float c = y > 0.0 ? mix(mid, top, smoothstep(0.0, 0.9, y)) : mix(mid, low, smoothstep(0.0, 0.45, -y)); gl_FragColor = vec4(vec3(c), 1.0); }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), dome));
  const boxes = [];
  const box = (w, h, x, y, z, round = false) => {
    const m = new THREE.Mesh(round ? new THREE.CircleGeometry(w, 32) : new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
    boxes.push(m);
    return m;
  };
  const keys = [
    box(36, 36, 0, 46, 0), box(8, 48, -40, 8, 16), box(8, 48, 38, 8, -12),
    box(32, 12, 12, 14, 46), box(38, 6, 0, 12, -46), box(16, 6, -30, -6, -30),
  ];
  const sparks = [[22, 34, 26], [-26, 28, -14], [6, 40, -22], [-18, 22, 34], [34, 18, 6], [-34, 12, -30]].map(([x, y, z]) => box(2.2, 0, x, y, z, true));
  const flags = [[-44, -16], [44, 18], [18, -44], [-14, 46]].map(([x, z]) => box(9, 62, x, 6, z));
  const make = (o) => {
    dome.uniforms.top.value = o.top; dome.uniforms.mid.value = o.mid; dome.uniforms.low.value = o.low;
    keys.forEach((k, i) => k.material.color.setScalar(o.keys[i]));
    sparks.forEach((s) => s.material.color.setScalar(o.spark));
    flags.forEach((f) => f.material.color.setScalar(o.flag));
    const rt = new THREE.WebGLCubeRenderTarget(o.size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    new THREE.CubeCamera(0.5, 200, rt).update(renderer, scene);
    return rt;
  };
  const metalCube = make({ top: 1.3, mid: 0.58, low: 0.72, keys: [2.8, 5.2, 4.4, 2.2, 3.6, 2.4], spark: 7, flag: 0.2, size: 512 });
  const stoneCube = make({ top: 0.75, mid: 0.17, low: 0.05, keys: [3.4, 7.5, 6.0, 2.4, 4.5, 3.0], spark: 16, flag: 0.0, size: 512 });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const metal = pmrem.fromCubemap(metalCube.texture).texture;
  pmrem.dispose();
  metalCube.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return { metal, stones: stoneCube.texture };
}

// ─── Finish textures ────────────────────────────────────────────────────────

/** Normal map from a height function on a tileable canvas. */
function normalTexture(size, height, strength) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = height(x / size, y / size);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (xx, yy) => h[((yy + size) % size) * size + ((xx + size) % size)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      img.data[o] = (0.5 - dx / l / 2) * 255; img.data[o + 1] = (0.5 - dy / l / 2) * 255; img.data[o + 2] = (0.5 + 0.5 / l) * 255; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const finishMaps = new Map();
function finishMap(kind) {
  if (finishMaps.has(kind)) return finishMaps.get(kind);
  let t = null;
  if (kind === 'hammered') {
    // Overlapping round dents of different sizes, as a jeweller's hammer leaves them.
    const r = rng(7);
    const dents = Array.from({ length: 70 }, () => ({ x: r(), y: r(), s: 0.05 + r() * 0.07 }));
    t = normalTexture(256, (x, y) => {
      let h = 0;
      for (const d of dents) {
        for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
          const dd = Math.hypot(x - d.x - ox, y - d.y - oy) / d.s;
          if (dd < 1) h = Math.min(h, -(1 - dd * dd));
        }
      }
      return h * 0.6;
    }, 6);
  } else if (kind === 'satin') {
    // Fine lines along the band, as left by a brush.
    const r = rng(3);
    const lines = Array.from({ length: 256 }, () => r());
    t = normalTexture(256, (x, y) => lines[Math.floor(y * 256)] * 0.5 + Math.sin(x * 6.283 * 3 + y * 40) * 0.02, 1.2);
  } else if (kind === 'matte') {
    const r = rng(11);
    const n = Array.from({ length: 128 * 128 }, () => r());
    t = normalTexture(128, (x, y) => n[Math.floor(y * 128) * 128 + Math.floor(x * 128)], 0.5);
  }
  finishMaps.set(kind, t);
  return t;
}

// ─── Stage ──────────────────────────────────────────────────────────────────

export class Stage {
  /**
   * @param {HTMLElement} container the stage fills it
   * @param {{ background?: string, autoRotate?: boolean, rotateSpeed?: number, stats?: boolean }} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = { background: '#ffffff', autoRotate: true, rotateSpeed: 3.2, adaptive: true, touchScroll: true, ...options };
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer = renderer;
    container.append(renderer.domElement);
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';

    this.maxRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.ratio = this.maxRatio;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
    this.camera.position.set(30, 18, 60);
    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.rotateSpeed = 0.7;
    controls.enablePan = false;
    // On a touch screen an up-or-down swipe over the 3D scrolls the page (the stage fills much of
    // a phone's screen); a sideways swipe turns the ring and a pinch zooms. OrbitControls turns
    // all touch scrolling off, so this comes after it.
    if (this.options.touchScroll) renderer.domElement.style.touchAction = 'pan-y';
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI * 0.53;
    controls.autoRotate = this.options.autoRotate && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotateSpeed = this.options.rotateSpeed;
    this.controls = controls;
    this.wantsRotate = controls.autoRotate;
    controls.addEventListener('start', () => { this.interacting = true; controls.autoRotate = false; this.tween = null; this.wake(); });
    controls.addEventListener('end', () => { this.interacting = false; this.lastInput = performance.now(); });
    controls.addEventListener('change', () => { this.moved = true; });

    this.maps = studioMaps(renderer);
    // The turntable turns the ring and its shadow under fixed lights and camera, as on a
    // photographer's turntable (the 360° video); the root holds the design.
    this.turntable = new THREE.Group();
    this.root = new THREE.Group();
    this.turntable.add(this.root);
    this.scene.add(this.turntable);

    this.buildTargets();
    this.post = {
      bright: new Pass(brightFragment, { tColor: { value: null }, threshold: { value: 5.5 } }),
      blur: new Pass(blurFragment, { tColor: { value: null }, step: { value: new THREE.Vector2() } }),
      average: new Pass(averageFragment, { tFrame: { value: null }, tSum: { value: null }, weight: { value: 1 } }),
      compose: new Pass(composeFragment, {
        tColor: { value: null }, tGlow: { value: null }, glow: { value: 0.18 }, exposure: { value: 1.0 },
        background: { value: new THREE.Color(this.options.background) },
      }),
    };
    this.shadow = this.makeShadow();
    this.turntable.add(this.shadow.plane);

    this.gemMaterials = new Map();
    this.metalMaterials = new Map();
    // Ambient occlusion baked per vertex (see bakeOcclusion); metal materials read it.
    const none = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1);
    none.needsUpdate = true;
    this.aoUniforms = { aoTex: { value: none }, aoSize: { value: new THREE.Vector2(1, 1) }, aoAmount: { value: 0 } };
    this.ao = null;
    this.objects = [];
    this.samples = 0;
    this.frameTimes = [];
    this.stats = { fps: 0, ms: 0, ratio: this.ratio, samples: 0, triangles: 0 };
    this.lastFrame = performance.now();
    this.lastInput = 0;
    this.visible = true;
    this.dirty = true;

    new ResizeObserver(() => this.resize()).observe(container);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) this.wake(); }).observe(container);
    document.addEventListener('visibilitychange', () => this.wake());
    this.resize();
    renderer.setAnimationLoop((t) => this.frame(t));
  }

  buildTargets() {
    const w = 4, h = 4;
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.frameRT = new THREE.WebGLRenderTarget(w, h, { ...opts, samples: 4 });
    this.stillRT = new THREE.WebGLRenderTarget(w, h, opts);
    this.sumRT = [new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType }), new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType })];
    this.glowRT = [new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType }), new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType })];
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(w, h, false);
    const pw = Math.round(w * this.ratio), ph = Math.round(h * this.ratio);
    this.frameRT.setSize(pw, ph);
    this.stillRT.setSize(pw, ph);
    this.sumRT.forEach((t) => t.setSize(pw, ph));
    this.glowRT.forEach((t) => t.setSize(Math.max(1, pw >> 2), Math.max(1, ph >> 2)));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  wake() { this.dirty = true; this.samples = 0; }

  // ─── Materials ──

  metalMaterial(metal, finish = 'polished', extra = null, uvSize = null) {
    // Finish textures tile at a real size: brush lines and grain small, hammer dents larger.
    const tileMm = { satin: 4, matte: 3, hammered: 11 }[finish];
    const repeat = uvSize && tileMm ? [Math.max(1, Math.round(uvSize[0] / tileMm)), Math.max(0.25, uvSize[1] / tileMm)] : null;
    const key = `${metal}|${finish}|${extra?.id ?? ''}|${repeat ? repeat.map((x) => x.toFixed(2)).join('x') : ''}`;
    if (this.metalMaterials.has(key)) return this.metalMaterials.get(key);
    const f = FINISHES[finish];
    const brushed = !!f.brushed;
    const m = new (brushed ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
      metalness: 1, roughness: f.roughness, envMap: this.maps.metal, envMapIntensity: 1,
    });
    m.color.setRGB(...METALS[metal].f0, THREE.LinearSRGBColorSpace);
    // Brushed and matte metal scatter the studio's light: a touch less bright than polish.
    if (finish === 'satin' || finish === 'matte') m.envMapIntensity = 0.8;
    let map = finishMap(finish);
    if (map && repeat) { map = map.clone(); map.repeat.set(repeat[0], repeat[1]); map.needsUpdate = true; }
    const strength = { hammered: 1.6, satin: 0.14, matte: 0.3 }[finish] ?? 0.3;
    if (map) { m.normalMap = map; m.normalScale.set(strength, strength); }
    if (brushed) { m.anisotropy = 0.85; m.anisotropyRotation = 0; }
    if (extra?.normalMap) {
      // Engraving: its own relief, darker and rougher in the letters.
      m.normalMap = extra.normalMap; m.normalScale.set(1, 1);
      m.map = extra.map; m.roughnessMap = extra.roughnessMap; m.roughness = 1;
    }
    // Crevices (under the basket, between prongs and halo stones, inside the band) see less of
    // the studio: the baked occlusion dims their reflections, as in a photograph.
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.aoUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aoIndex;\nuniform sampler2D aoTex;\nuniform vec2 aoSize;\nvarying float vAo;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          { vec2 c = (vec2(mod(aoIndex, aoSize.x), floor(aoIndex / aoSize.x)) + 0.5) / aoSize;
            vec4 a = textureLod(aoTex, c, 0.0); vAo = a.y > 1e-4 ? a.x / a.y : 1.0; }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float aoAmount;\nvarying float vAo;')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
          { float occ = mix(1.0, clamp(vAo * 1.12, 0.0, 1.0), aoAmount);
            reflectedLight.indirectDiffuse *= occ;
            float dotNVo = saturate(dot(geometryNormal, geometryViewDir));
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNVo, occ, material.roughness); }`);
    };
    m.customProgramCacheKey = () => 'metal-baked-occlusion';
    this.metalMaterials.set(key, m);
    return m;
  }

  gemMaterial(cutKey, gemKey, role) {
    const key = `${cutKey}|${gemKey}|${role}`;
    if (this.gemMaterials.has(key)) return this.gemMaterials.get(key);
    const c = cut(cutKey), g = GEMS[gemKey];
    const accent = role === 'accent';
    const planes = [];
    for (let i = 0; i < c.planeCount; i++) planes.push(new THREE.Vector4(c.planes[i * 4], c.planes[i * 4 + 1], c.planes[i * 4 + 2], c.planes[i * 4 + 3]));
    const m = new THREE.ShaderMaterial({
      defines: { PLANES: c.planeCount, BOUNCES: accent ? 4 : 7 },
      uniforms: {
        planes: { value: planes },
        envMap: { value: this.maps.stones },
        ior: { value: g.ior },
        // A camera blends a small stone's few pixels, so its fire looks softer.
        dispersion: { value: g.dispersion * (accent ? 0.45 : 1) },
        absorption: { value: new THREE.Vector3(...g.absorption) },
        brightness: { value: accent ? 1.25 : 1.0 },
        bounces: { value: accent ? 4 : 7 },
        channel: { value: -1 },
        iorJitter: { value: 0 },
      },
      vertexShader: gemVertex,
      fragmentShader: gemFragment,
    });
    m.userData.accent = accent;
    this.gemMaterials.set(key, m);
    return m;
  }

  // ─── Content ──

  /**
   * Shows a design. groups: [{ matrix?: number[16], parts: [{ geometry, metal, finish?, maps? }],
   * stones: [{ cut, gem, role, matrices }] }]. frame: { floor, centre?, radius }.
   */
  setDesign({ groups, frame }, { refit = false } = {}) {
    for (const o of this.objects) { this.root.remove(o); if (o.userData.owned) o.geometry.dispose(); }
    this.turntable.rotation.y = 0;
    this.turntable.updateMatrixWorld(true);
    const built = this.buildGroups(groups);
    for (const parent of built.parents) this.root.add(parent);
    this.objects = [...built.meshes, ...built.parents];
    this.frameInfo = frame;
    this.stats.triangles = built.triangles;
    this.root.updateMatrixWorld(true);
    this.bakeShadow();
    this.bakeOcclusion();
    if (refit || !this.fitted) this.fit(!this.fitted ? false : true);
    this.wake();
  }

  /**
   * Ambient occlusion for every metal vertex, worked out on the GPU: the design is seen from 64
   * directions round it; for each, a depth picture shows which vertices are hidden from that
   * side, and the visible share (weighted towards each vertex's normal) is summed per vertex.
   * A few directions are done per frame, so changing a choice never stalls the turning ring;
   * the shading fades in when all are done. It costs nothing afterwards.
   */
  bakeOcclusion() {
    const metal = this.objects.filter((o) => o.isMesh && o.userData.owned);
    if (!this.ao) {
      const depth = new THREE.WebGLRenderTarget(512, 512, { depthBuffer: true });
      depth.depthTexture = new THREE.DepthTexture(512, 512);
      const points = new THREE.ShaderMaterial({
        uniforms: {
          depthTex: { value: depth.depthTexture }, viewProj: { value: new THREE.Matrix4() }, dir: { value: new THREE.Vector3() },
          aoSize: { value: new THREE.Vector2() }, bias: { value: 0.002 }, offset: { value: 0.04 },
        },
        vertexShader: `
          attribute float aoIndex;
          uniform sampler2D depthTex; uniform mat4 viewProj; uniform vec3 dir; uniform vec2 aoSize; uniform float bias; uniform float offset;
          varying vec2 vSum;
          void main() {
            vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
            vec3 wn = normalize(mat3(modelMatrix) * normal);
            float facing = dot(wn, dir);
            float seen = 0.0;
            if (facing > 0.0) {
              vec4 c = viewProj * vec4(wp + wn * offset, 1.0);
              vec3 ndc = c.xyz / c.w;
              float nearest = textureLod(depthTex, ndc.xy * 0.5 + 0.5, 0.0).r;
              seen = (ndc.z * 0.5 + 0.5) - bias <= nearest ? 1.0 : 0.0;
            }
            vSum = vec2(seen * max(facing, 0.0), max(facing, 0.0));
            vec2 cell = vec2(mod(aoIndex, aoSize.x), floor(aoIndex / aoSize.x)) + 0.5;
            gl_Position = vec4(cell / aoSize * 2.0 - 1.0, 0.0, 1.0);
            gl_PointSize = 1.0;
          }`,
        fragmentShader: 'varying vec2 vSum; void main() { gl_FragColor = vec4(vSum, 0.0, 1.0); }',
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
      });
      const dirs = [];
      const K = 64;
      for (let i = 0; i < K; i++) {
        const y = 1 - (2 * (i + 0.5)) / K, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
        dirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      this.ao = { depth, points, dirs, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10), scene: new THREE.Scene(), hide: new THREE.MeshBasicMaterial({ colorWrite: false }), rt: null, job: null };
    }
    const ao = this.ao;
    for (const c of [...ao.scene.children]) { ao.scene.remove(c); c.geometry.dispose(); }
    let total = 0;
    for (const mesh of metal) {
      const count = mesh.geometry.attributes.position.count;
      const index = new Float32Array(count);
      for (let i = 0; i < count; i++) index[i] = total + i;
      mesh.geometry.setAttribute('aoIndex', new THREE.BufferAttribute(index, 1));
      // Points share the mesh's vertices, once each (no index: an indexed vertex would count twice).
      const g = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'aoIndex']) g.setAttribute(name, mesh.geometry.attributes[name]);
      const p = new THREE.Points(g, ao.points);
      p.matrixAutoUpdate = false;
      p.matrix.copy(mesh.matrixWorld);
      p.frustumCulled = false;
      ao.scene.add(p);
      total += count;
    }
    const width = 1024, height = Math.max(1, Math.ceil(total / width));
    if (!ao.rt || ao.rt.height !== height) {
      ao.rt?.dispose();
      ao.rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    const r = this.renderer;
    r.setRenderTarget(ao.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.setRenderTarget(null);
    this.aoUniforms.aoTex.value = ao.rt.texture;
    this.aoUniforms.aoSize.value.set(width, height);
    this.aoUniforms.aoAmount.value = 0;
    ao.points.uniforms.aoSize.value.set(width, height);
    const sphere = this.bounds().getBoundingSphere(new THREE.Sphere());
    ao.job = total ? { next: 0, sphere, fade: null } : null;
  }

  /** Does a few more directions of the occlusion bake; fades the result in when finished. */
  stepOcclusion(now) {
    const ao = this.ao, job = ao.job;
    if (job.fade !== null) {
      const k = Math.min((now - job.fade) / 450, 1);
      this.aoUniforms.aoAmount.value = k * k * (3 - 2 * k);
      if (k >= 1) ao.job = null;
      return true;
    }
    const r = this.renderer;
    const { center, radius } = job.sphere;
    const cam = ao.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 0.1; cam.far = radius * 4;
    cam.updateProjectionMatrix();
    ao.points.uniforms.bias.value = 0.08 / (cam.far - cam.near);
    const hidden = [];
    for (const o of this.objects) if (o.isInstancedMesh) { hidden.push(o); o.visible = false; }
    const shadowWas = this.shadow.plane.visible;
    this.shadow.plane.visible = false;
    const autoClear = r.autoClear;
    for (let n = 0; n < 4 && job.next < ao.dirs.length; n++, job.next++) {
      const d = ao.dirs[job.next];
      cam.position.copy(center).addScaledVector(d, radius * 2);
      cam.up.set(Math.abs(d.y) > 0.99 ? 1 : 0, Math.abs(d.y) > 0.99 ? 0 : 1, 0);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      this.scene.overrideMaterial = ao.hide;
      r.autoClear = true;
      r.setRenderTarget(ao.depth);
      r.clear();
      r.render(this.scene, cam);
      this.scene.overrideMaterial = null;
      ao.points.uniforms.viewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      ao.points.uniforms.dir.value.copy(d);
      r.autoClear = false;
      r.setRenderTarget(ao.rt);
      r.render(ao.scene, cam);
    }
    r.autoClear = autoClear;
    r.setRenderTarget(null);
    for (const o of hidden) o.visible = true;
    this.shadow.plane.visible = shadowWas;
    if (job.next >= ao.dirs.length) job.fade = now;
    return false;
  }

  /** three.js objects for a design's groups (metal meshes and instanced stones). */
  buildGroups(groups) {
    const parents = [], meshes = [];
    let triangles = 0;
    for (const group of groups) {
      const parent = new THREE.Group();
      if (group.matrix) { parent.matrixAutoUpdate = false; parent.matrix.fromArray(group.matrix); }
      for (const part of group.parts) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(part.geometry.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(part.geometry.normals, 3));
        if (part.geometry.uvs) g.setAttribute('uv', new THREE.BufferAttribute(part.geometry.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(part.geometry.index, 1));
        const mesh = new THREE.Mesh(g, this.metalMaterial(part.metal, part.finish ?? 'polished', part.maps, part.uvSize));
        mesh.userData.owned = true;
        parent.add(mesh);
        meshes.push(mesh);
        triangles += part.geometry.index.length / 3;
      }
      for (const s of group.stones) {
        const geometry = stoneGeometry(s.cut);
        const mesh = new THREE.InstancedMesh(geometry, this.gemMaterial(s.cut, s.gem, s.role), s.matrices.length);
        const m4 = new THREE.Matrix4();
        s.matrices.forEach((m, i) => mesh.setMatrixAt(i, m4.fromArray(m)));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.frustumCulled = false;
        parent.add(mesh);
        meshes.push(mesh);
        triangles += (geometry.attributes.position.count / 3) * s.matrices.length;
      }
      parents.push(parent);
    }
    return { parents, meshes, triangles };
  }

  /**
   * A small picture of another design (for the choices' thumbnails), rendered with the same
   * studio and materials. Returns a PNG data URL.
   */
  async thumbnail({ groups, frame }, view = 'overview', size = 96) {
    const px = size * 2;
    if (!this.thumb) {
      const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      black.needsUpdate = true;
      this.thumb = {
        scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(30, 1, 0.5, 600), black,
        rt: new THREE.WebGLRenderTarget(px, px, { type: THREE.HalfFloatType, samples: 4 }),
        out: new THREE.WebGLRenderTarget(px, px),
        canvas: document.createElement('canvas'),
      };
    }
    const t = this.thumb, r = this.renderer;
    t.rt.setSize(px, px); t.out.setSize(px, px);
    const built = this.buildGroups(groups);
    for (const p of built.parents) t.scene.add(p);
    t.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of built.meshes) box.expandByObject(m);
    const hb = frame?.headBox;
    const headBox = hb ? new THREE.Box3(new THREE.Vector3(...hb.min), new THREE.Vector3(...hb.max)) : box;
    const [polar, azimuth, fitBox, margin] = { head: [64, 24, headBox, 0.84], shank: [62, 40, box, 0.92], top: [14, 0, headBox, 0.84] }[view] ?? [70, 32, box, 0.92];
    const target = fitBox.getCenter(new THREE.Vector3());
    const dist = this.distanceToFit(fitBox, target, polar, azimuth, margin, t.camera);
    t.camera.position.setFromSpherical(new THREE.Spherical(dist, (polar * Math.PI) / 180, (azimuth * Math.PI) / 180)).add(target);
    t.camera.lookAt(target);
    this.setGemMode(-1, 0);
    const aoWas = this.aoUniforms.aoAmount.value;
    this.aoUniforms.aoAmount.value = 0;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(t.rt);
    r.clear();
    r.render(t.scene, t.camera);
    this.aoUniforms.aoAmount.value = aoWas;
    const c = this.post.compose.material.uniforms;
    const glow = c.glow.value;
    c.tColor.value = t.rt.texture; c.tGlow.value = t.black; c.glow.value = 0;
    this.post.compose.render(r, t.out);
    c.glow.value = glow;
    const buf = new Uint8Array(px * px * 4);
    r.readRenderTargetPixels(t.out, 0, 0, px, px, buf);
    r.setRenderTarget(null);
    for (const p of built.parents) t.scene.remove(p);
    for (const m of built.meshes) if (m.userData.owned) m.geometry.dispose();
    t.canvas.width = t.canvas.height = px;
    const g = t.canvas.getContext('2d');
    const img = g.createImageData(px, px);
    for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
    g.putImageData(img, 0, 0);
    this.wake();
    return t.canvas.toDataURL('image/png');
  }

  /** Size of everything shown, for framing. */
  bounds() {
    const box = new THREE.Box3();
    for (const o of this.objects) if (o.isMesh) box.expandByObject(o);
    return box;
  }

  /** Frames the design: from 3/4 above, filling the stage. */
  fit(animate = true) {
    const box = this.bounds();
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.fitted = { centre: sphere.center.clone(), radius: sphere.radius };
    this.focus('overview', { animate });
  }

  /**
   * Moves the camera to a named view, smoothly. Views: overview, head (close on the head from
   * the side), top (looking down on the stone), side (profile), front (through the ring), shank.
   */
  focus(name, { animate = true } = {}) {
    if (!this.fitted) return;
    const whole = this.bounds();
    const centre = whole.getCenter(new THREE.Vector3());
    const hb = this.frameInfo?.headBox;
    const headBox = hb ? new THREE.Box3(new THREE.Vector3(...hb.min), new THREE.Vector3(...hb.max)) : whole;
    const head = headBox.getCenter(new THREE.Vector3());
    // Closer views are taken nearer the stage's top, leaving the lower part for the ring below.
    const views = {
      overview: { box: whole, target: centre, polar: 72, azimuth: 32, margin: 0.9 },
      head: { box: headBox, target: head, polar: 64, azimuth: 24, margin: 0.62 },
      top: { box: headBox, target: head, polar: 12, azimuth: 0, margin: 0.6 },
      // The whole ring from above (a product photo's top view).
      above: { box: whole, target: new THREE.Vector3(head.x, centre.y, head.z), polar: 8, azimuth: 0, margin: 0.9 },
      side: { box: whole, target: centre, polar: 84, azimuth: 90, margin: 0.86 },
      front: { box: whole, target: centre, polar: 86, azimuth: 0, margin: 0.86 },
      shank: { box: whole, target: centre, polar: 62, azimuth: 52, margin: 0.86 },
      inside: { box: whole, target: centre, polar: 82, azimuth: 8, margin: 1.4 },
    };
    const v = views[name] ?? views.overview;
    this.look({ ...v, animate, keepAzimuth: (name === 'overview' || name === 'shank') && animate, rotateAfter: name !== 'top' });
  }

  /**
   * Moves the camera to look at `target` from (polar, azimuth) degrees, at the distance that fits
   * `box` within `margin` of the frame (or at `distance`).
   */
  look({ target, polar, azimuth, box = null, margin = 0.86, distance = null, animate = true, keepAzimuth = false, rotateAfter = true }) {
    target = target.isVector3 ? target.clone() : new THREE.Vector3(...target);
    const d = distance ?? this.distanceToFit(box ?? this.bounds(), target, polar, azimuth, margin);
    this.baseDistance = d;
    const to = new THREE.Spherical(d, (polar * Math.PI) / 180, (azimuth * Math.PI) / 180);
    if (keepAzimuth) to.theta = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
    if (!animate) {
      // A jump cancels any move still under way.
      this.tween = null;
      this.controls.target.copy(target);
      this.camera.position.copy(new THREE.Vector3().setFromSpherical(to).add(target));
      this.controls.update();
      this.wake();
      return;
    }
    const fromS = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    let dTheta = to.theta - fromS.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.tween = {
      start: performance.now(), duration: 900,
      fromTarget: this.controls.target.clone(), toTarget: target,
      from: fromS, to: new THREE.Spherical(to.radius, to.phi, fromS.theta + dTheta),
    };
    this.controls.autoRotate = false;
    this.resumeAfterTween = this.wantsRotate && rotateAfter;
    this.wake();
  }

  /** Bounds of one group of the design (for example one ring of a pair). */
  groupBounds(index) {
    const parent = this.root.children[index];
    const box = new THREE.Box3();
    if (parent) parent.traverse((o) => { if (o.isMesh) box.expandByObject(o); });
    return box;
  }

  /** Camera distance at which every corner of `box` is inside `margin` of the frame. */
  distanceToFit(box, target, polar, azimuth, margin, camera = this.camera) {
    const cam = camera.clone();
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const dir = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, (polar * Math.PI) / 180, (azimuth * Math.PI) / 180));
    const fits = (d) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      return corners.every((c) => {
        const p = c.clone().project(cam);
        return p.z < 1 && Math.abs(p.x) <= margin && Math.abs(p.y) <= margin;
      });
    };
    let lo = 1, hi = 2000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  }

  /** Zoom from 0 (far) to 1 (close), relative to the last framed view; 0.5 is that view. */
  zoomTo(f) {
    if (!this.baseDistance) return;
    const d = this.baseDistance * 2 ** ((0.5 - f) * 2.2);
    const offset = this.camera.position.clone().sub(this.controls.target).setLength(d);
    this.camera.position.copy(this.controls.target).add(offset);
    this.tween = null;
    this.wake();
  }

  setAutoRotate(on) { this.wantsRotate = on; this.controls.autoRotate = on; this.wake(); }

  /** Turns the ring (and its shadow) on the turntable, in radians. */
  setTurn(angle) {
    this.turntable.rotation.y = angle;
    this.turntable.updateMatrixWorld(true);
    this.wake();
  }

  /** Finishes the occlusion bake at once and shows it in full (for rendering photos). */
  settleOcclusion() {
    while (this.ao?.job && this.ao.job.fade === null) this.stepOcclusion(performance.now());
    if (this.ao?.job) this.ao.job = null;
    this.aoUniforms.aoAmount.value = 1;
    this.wake();
  }

  setBackground(css) {
    this.options.background = css;
    this.post.compose.material.uniforms.background.value.set(css);
    this.wake();
  }

  // ─── Shadow ──

  makeShadow() {
    const size = 512;
    const rt = new THREE.WebGLRenderTarget(size, size);
    const blurRT = new THREE.WebGLRenderTarget(size, size);
    rt.texture.generateMipmaps = false;
    // As in three.js's contact shadow example: a plane facing down, flipped, so the picture taken
    // from below lands the right way round.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true, depthWrite: false, opacity: 1 }));
    plane.renderOrder = -1;
    plane.material.color.setRGB(0, 0, 0);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    camera.rotation.x = Math.PI / 2;     // looks up from the floor
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = { value: 0.95 };
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 2.2 ) * darkness );',
      )}`;
    };
    depth.depthTest = false;
    depth.depthWrite = false;
    const blurH = new Pass(blurFragment.replace('vec3 s = texture2D(tColor, vUv).rgb', 'vec4 s = texture2D(tColor, vUv)').replace(/\.rgb/g, '').replace('gl_FragColor = vec4(s, 1.0);', 'gl_FragColor = s;'), { tColor: { value: null }, step: { value: new THREE.Vector2() } });
    return { rt, blurRT, plane, camera, depth, blurH, size };
  }

  /** Renders the design from below into a soft shadow under it (once per design). */
  bakeShadow() {
    const s = this.shadow;
    const box = this.bounds();
    if (box.isEmpty()) { s.plane.visible = false; return; }
    const floor = this.frameInfo?.floor ?? box.min.y;
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.6 + 8;
    const cx = (box.max.x + box.min.x) / 2, cz = (box.max.z + box.min.z) / 2;
    s.plane.visible = true;
    s.plane.scale.set(span, -1, span);
    s.plane.position.set(cx, floor + 0.01, cz);
    const cam = s.camera;
    cam.left = -span / 2; cam.right = span / 2; cam.top = span / 2; cam.bottom = -span / 2;
    cam.near = 0; cam.far = Math.max((box.max.y - floor) * (this.frameInfo?.shadowReach ?? 0.6), 3);
    cam.position.set(cx, floor, cz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const r = this.renderer;
    const prevBg = this.scene.background;
    this.scene.overrideMaterial = s.depth;
    s.plane.visible = false;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(s.rt);
    r.clear();
    r.render(this.scene, cam);
    this.scene.overrideMaterial = null;
    this.scene.background = prevBg;
    s.plane.visible = true;
    // Blur several times, wider each time, for a soft penumbra.
    const blur = s.blurH;
    for (const [k, amount] of [[0, 1], [1, 2.2], [2, 4], [3, 6]]) {
      void k;
      blur.material.uniforms.tColor.value = s.rt.texture;
      blur.material.uniforms.step.value.set(amount / s.size, 0);
      blur.render(r, s.blurRT);
      blur.material.uniforms.tColor.value = s.blurRT.texture;
      blur.material.uniforms.step.value.set(0, amount / s.size);
      blur.render(r, s.rt);
    }
    r.setRenderTarget(null);
  }

  // ─── Frames ──

  frame(now) {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    if (!this.visible || document.hidden || !this.width) return;

    let animating = false;
    if (this.tween) {
      const tw = this.tween;
      const k = ease(Math.min((now - tw.start) / tw.duration, 1));
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      const s = new THREE.Spherical(
        tw.from.radius + (tw.to.radius - tw.from.radius) * k,
        tw.from.phi + (tw.to.phi - tw.from.phi) * k,
        tw.from.theta + (tw.to.theta - tw.from.theta) * k,
      );
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      if (k >= 1) { this.tween = null; this.lastInput = now; }
      animating = true;
    }
    // Turning resumes a few seconds after the shopper lets go.
    if (!this.tween && !this.interacting && this.wantsRotate && !this.controls.autoRotate && now - this.lastInput > 4500) this.controls.autoRotate = true;
    // The occlusion bake runs a few directions per frame; its fade-in changes the picture.
    if (this.ao?.job && this.stepOcclusion(now)) this.wake();
    this.moved = false;
    this.controls.update(dt);
    const moving = animating || this.moved || this.controls.autoRotate || this.interacting;
    if (moving) this.samples = 0;
    if (!moving && !this.dirty && this.samples >= this.maxSamples()) { this.stats.samples = this.samples; return; }
    this.dirty = false;

    const t0 = performance.now();
    if (moving || this.samples === 0) this.renderMoving();
    else this.refine();
    this.trackSpeed(now, moving);
    this.stats.ms = performance.now() - t0;
  }

  maxSamples() { return 14; }

  setGemMode(channel, jitter) {
    for (const m of this.gemMaterials.values()) {
      m.uniforms.channel.value = channel;
      m.uniforms.iorJitter.value = jitter;
    }
  }

  renderMoving() {
    const r = this.renderer;
    this.camera.clearViewOffset();
    this.setGemMode(-1, 0);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.frameRT);
    r.clear();
    r.render(this.scene, this.camera);
    this.present(this.frameRT.texture);
    this.samples = 1;
  }

  /**
   * One more sub-pixel step of a still view: red, green and blue traced separately through the
   * stones (each at a slightly varied refractive index) and averaged with the steps before.
   */
  refine() {
    const r = this.renderer;
    const n = this.samples;
    const pw = this.frameRT.width, ph = this.frameRT.height;
    const jx = halton(n + 1, 2) - 0.5, jy = halton(n + 1, 3) - 0.5;
    this.camera.setViewOffset(pw, ph, jx, jy, pw, ph);
    const avg = this.post.average;
    for (let channel = 0; channel < 3; channel++) {
      this.setGemMode(channel, (halton(n * 3 + channel + 1, 5) - 0.5) * 0.012);
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.stillRT);
      r.clear();
      r.render(this.scene, this.camera);
      const count = (n - 1) * 3 + channel;   // renders averaged so far
      const [a, b] = this.sumRT;
      avg.material.uniforms.tFrame.value = this.stillRT.texture;
      avg.material.uniforms.tSum.value = a.texture;
      avg.material.uniforms.weight.value = 1 / (count + 1);
      avg.render(r, b);
      this.sumRT = [b, a];
    }
    this.camera.clearViewOffset();
    this.samples = n + 1;
    this.present(this.sumRT[0].texture);
  }

  present(texture) {
    const r = this.renderer;
    const { bright, blur, compose } = this.post;
    bright.material.uniforms.tColor.value = texture;
    bright.render(r, this.glowRT[0]);
    const [g0, g1] = this.glowRT;
    for (const s of [1]) {
      blur.material.uniforms.tColor.value = g0.texture;
      blur.material.uniforms.step.value.set(s / g0.width, 0);
      blur.render(r, g1);
      blur.material.uniforms.tColor.value = g1.texture;
      blur.material.uniforms.step.value.set(0, s / g0.height);
      blur.render(r, g0);
    }
    compose.material.uniforms.tColor.value = texture;
    compose.material.uniforms.tGlow.value = g0.texture;
    compose.render(r, null);
  }

  /** Keeps frames near 16 ms by changing the resolution, and reports frames per second. */
  trackSpeed(now, moving) {
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.stats.fps = this.frameTimes.length;
    this.stats.ratio = this.ratio;
    this.stats.samples = this.samples;
    if (!moving || !this.options.adaptive || this.frameTimes.length < 20) return;
    const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / (this.frameTimes.length - 1);
    if (!this.lastAdapt) this.lastAdapt = now;
    if (now - this.lastAdapt < 1200) return;
    if (span > 19 && this.ratio > 0.75) { this.ratio = Math.max(0.75, this.ratio - 0.25); this.lastAdapt = now; this.resize(); }
    else if (span < 13 && this.ratio < this.maxRatio && now - this.lastAdapt > 4000) { this.ratio = Math.min(this.maxRatio, this.ratio + 0.25); this.lastAdapt = now; this.resize(); }
  }

  /** A finished still at the given size (CSS pixels × ratio) as a PNG data URL. */
  async snapshot(samples = 32) {
    const was = this.controls.autoRotate;
    this.controls.autoRotate = false;
    this.samples = 0;
    this.renderMoving();
    for (let i = 1; i < samples; i++) this.refine();
    const url = this.renderer.domElement.toDataURL('image/png');
    this.controls.autoRotate = was;
    return url;
  }

  /** Compiles every shader a design could need, so the first change does not stutter. */
  async warm(cutKeys, gemKeys) {
    for (const c of cutKeys) for (const g of gemKeys) this.gemMaterial(c, g, c.endsWith('accent') ? 'accent' : 'centre');
    const scene = new THREE.Scene();
    for (const [key, m] of this.gemMaterials) scene.add(new THREE.Mesh(stoneGeometry(key.split('|')[0]), m));
    if (this.renderer.compileAsync) await this.renderer.compileAsync(scene, this.camera);
  }
}

function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

const stoneGeometries = new Map();
function stoneGeometry(key) {
  if (stoneGeometries.has(key)) return stoneGeometries.get(key);
  const c = cut(key);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
  stoneGeometries.set(key, g);
  return g;
}

// ─── Engraving ──────────────────────────────────────────────────────────────

export const ENGRAVING_FONTS = {
  serif: { label: 'Classic', css: 'italic 400 {px}px Georgia, "Times New Roman", serif' },
  script: { label: 'Script', css: '400 {px}px "Snell Roundhand", "Apple Chancery", "URW Chancery L", "Brush Script MT", cursive' },
  sans: { label: 'Modern', css: '500 {px}px "Helvetica Neue", Arial, sans-serif' },
  block: { label: 'Block', css: '700 {px}px "Arial Black", "Helvetica Neue", Arial, sans-serif' },
};

const engravingCache = new Map();
/**
 * Maps for text engraved on the inside of a band: relief (normal map), and letters darker and
 * rougher than the polish round them. The inside's uv runs round the band (u) and across it (v);
 * the text is centred at u = 0.5, the bottom of the ring as it stands.
 */
export function engravingMaps({ text, font = 'serif', width, circumference }) {
  const id = `${text}|${font}|${width.toFixed(2)}|${circumference.toFixed(1)}`;
  if (engravingCache.has(id)) return engravingCache.get(id);
  const pxPerMm = 40;
  const W = Math.min(4096, Math.round(circumference * pxPerMm)), H = Math.max(32, Math.round(width * pxPerMm));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const size = Math.round(H * 0.5);
  g.font = (ENGRAVING_FONTS[font] ?? ENGRAVING_FONTS.serif).css.replace('{px}', size);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  // Seen from above, looking into the ring, the inside's u runs right to left and its v upwards:
  // turn the text half round so it reads the right way up.
  g.translate(W / 2, H / 2);
  g.rotate(Math.PI);
  g.fillText(text, 0, 0, W * 0.45);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const src = g.getImageData(0, 0, W, H).data;
  // Soften the letter walls a little (a 3×3 average) so the relief looks cut, not stamped.
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
      sum += src[(yy * W + xx) * 4];
    }
    h[y * W + x] = sum / (9 * 255);
  }
  const normal = g.createImageData(W, H), colour = g.createImageData(W, H), rough = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (xx, yy) => h[Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))];
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.5, dy = (at(x, y + 1) - at(x, y - 1)) * 2.5;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * W + x) * 4;
      // Letters are cut in: the surface slopes down into them.
      normal.data[o] = (0.5 + dx / l / 2) * 255; normal.data[o + 1] = (0.5 + dy / l / 2) * 255; normal.data[o + 2] = (0.5 + 0.5 / l) * 255; normal.data[o + 3] = 255;
      const k = h[y * W + x];
      const shade = 255 - k * 95;
      colour.data[o] = colour.data[o + 1] = colour.data[o + 2] = shade; colour.data[o + 3] = 255;
      rough.data[o] = rough.data[o + 1] = rough.data[o + 2] = (0.05 + k * 0.4) * 255; rough.data[o + 3] = 255;
    }
  }
  const tex = (img, colourSpace) => {
    const cc = document.createElement('canvas');
    cc.width = W; cc.height = H;
    cc.getContext('2d').putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cc);
    t.colorSpace = colourSpace;
    t.anisotropy = 8;
    return t;
  };
  const maps = { id, normalMap: tex(normal, THREE.NoColorSpace), map: tex(colour, THREE.SRGBColorSpace), roughnessMap: tex(rough, THREE.NoColorSpace) };
  engravingCache.set(id, maps);
  return maps;
}
