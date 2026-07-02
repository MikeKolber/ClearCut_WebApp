/**
 * Three.js rocket structure viewer - cinematic port of the desktop's
 * `core/Trajectory Simulation/src/sketch/generate_3d.py` HTML template.
 *
 * Heavy three.js + post-processing imports load only when this module
 * is dynamically `import()`-ed from the modal, so users who never open
 * the rocket viewer don't pay the bundle cost.
 *
 * Visual stack:
 *   * PMREM-generated environment lighting (RoomEnvironment) for
 *     proper PBR reflections on every metallic surface
 *   * UnrealBloomPass on the engine glow + plume layers
 *   * ACES filmic tone mapping
 *   * Canvas-textured deep-space background with Milky Way + Earth
 *     horizon glow at the bottom of frame
 *   * 3D star particles for parallax
 *
 * Geometry: every mechanical detail from the desktop port -
 * stringers, conduits, RCS pods, sep bolts, TVC actuators,
 * interstage struts, antennas, patch antennas, stiffeners, access
 * panels, payload thermal blanket, fairing seams, lightning strips.
 *
 * Cinematic intro: camera starts far away and dollies in over ~1.8s
 * before auto-rotate kicks in.
 *
 * Per-stage sub-groups so the "Explode" toggle can pull stages apart
 * along the long axis with a smooth lerp.
 */

import * as THREE from 'three';

/* Company decals — bundled via webpack so the dev server proxy
   doesn't mistake them for backend API requests, and so the URL
   survives any future deploy where `public/` is mounted at a
   non-root prefix. */
import companyLogoUrl from '../../assets/ccs-logo-black.svg';
import israelFlagUrl from '../../assets/ccs-israel-flag.svg';
import { OrbitControls }   from 'three/examples/jsm/controls/OrbitControls';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment';
import { EffectComposer }  from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass';

const SEG = 64;
const TW  = 0.95;
const EW  = 0.8;
const GAP = 0.1;

const C = {
  engine:  0x3a3a42,
  fuel:    0xE8860C,
  ox:      0x87CEEB,
  head:    0xB0B0B0,
  inter:   0x808088,
  payload: 0xC9A55A,
  fairing: 0xDCDCE6,
  wall:    0xCCCCD0,
  nozzle:  0x1a1a1a,
  fin:     0x666666,
  ring:    0x222228,
  nose:    0xE0E0E8,
  cover:   0xE8E8EC,   // outer aeroshell "operational white" (Phase 1 default)
};

/* ---------- material factory ---------- */

function mat(color, o = {}) {
  const isTransparent = o.alpha != null;
  const props = {
    color,
    roughness: o.rough ?? 0.45,
    metalness: o.metal ?? 0.15,
    clearcoat: o.coat ?? 0,
    clearcoatRoughness: o.coatR ?? 0.25,
    transparent: isTransparent,
    opacity: o.alpha ?? 1,
    depthWrite: !isTransparent,
    side: o.double ? THREE.DoubleSide : THREE.FrontSide,
    envMapIntensity: o.env ?? 0.4,
  };
  if (isTransparent && o.double) {
    props.emissive = color;
    props.emissiveIntensity = 0.1;
  }
  return new THREE.MeshPhysicalMaterial(props);
}

/* ---------- dissolve material (removable outer cover) ----------
 *
 * A MeshPhysicalMaterial patched via `onBeforeCompile` so the outer
 * cover can "burn away" when the user reveals the internal structure.
 * A value-noise field erodes the surface as `uDissolve` climbs 0 → 1;
 * the receding edge is pushed into `totalEmissiveRadiance` in an accent
 * colour bright enough to cross the UnrealBloomPass threshold, so the
 * dissolving rim visibly glows and blooms as it vanishes.
 *
 * `uSweep` biases the erosion threshold by height (object-space Y) so
 * lower geometry disappears first — a directed bottom-to-top reveal
 * rather than uniform static. The live `shader` object is stashed on
 * `material.userData.dissolveShader` so the tick loop can animate
 * `uDissolve` after the program has compiled.
 */
function makeDissolveMaterial(color, o = {}, dissolveOpts = {}) {
  const material = mat(color, o);
  const {
    edgeColor = 0x8fe0ff,
    edge = 0.10,
    edgeIntensity = 3.4,
    noiseScale = 3.0,
    sweep = 0.55,
    yMin = 0,
    yMax = 1,
  } = dissolveOpts;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDissolve      = { value: 0 };
    shader.uniforms.uEdge          = { value: edge };
    shader.uniforms.uEdgeColor     = { value: new THREE.Color(edgeColor) };
    shader.uniforms.uEdgeIntensity = { value: edgeIntensity };
    shader.uniforms.uNoiseScale    = { value: noiseScale };
    shader.uniforms.uSweep         = { value: sweep };
    shader.uniforms.uYMin          = { value: yMin };
    shader.uniforms.uYMax          = { value: yMax };

    shader.vertexShader =
      'varying vec3 vDisPos;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vDisPos = position;',
      );

    shader.fragmentShader =
      [
        'varying vec3 vDisPos;',
        'uniform float uDissolve;',
        'uniform float uEdge;',
        'uniform vec3  uEdgeColor;',
        'uniform float uEdgeIntensity;',
        'uniform float uNoiseScale;',
        'uniform float uSweep;',
        'uniform float uYMin;',
        'uniform float uYMax;',
        'float dvHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
        'float dvNoise(vec3 x){',
        '  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(mix(dvHash(i + vec3(0,0,0)), dvHash(i + vec3(1,0,0)), f.x),',
        '                 mix(dvHash(i + vec3(0,1,0)), dvHash(i + vec3(1,1,0)), f.x), f.y),',
        '             mix(mix(dvHash(i + vec3(0,0,1)), dvHash(i + vec3(1,0,1)), f.x),',
        '                 mix(dvHash(i + vec3(0,1,1)), dvHash(i + vec3(1,1,1)), f.x), f.y), f.z);',
        '}',
        '',
      ].join('\n') +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          '{',
          '  float dNoise = dvNoise(vDisPos * uNoiseScale);',
          '  float dH = clamp((vDisPos.y - uYMin) / max(uYMax - uYMin, 1e-4), 0.0, 1.0);',
          '  float dThr = uDissolve * (1.0 + uSweep) - dH * uSweep;',
          '  if (dNoise < dThr) discard;',
          '  if (uDissolve > 0.0001) {',
          '    float dEdge = 1.0 - smoothstep(dThr, dThr + uEdge, dNoise);',
          '    totalEmissiveRadiance += uEdgeColor * uEdgeIntensity * dEdge;',
          '  }',
          '}',
        ].join('\n'),
      );

    material.userData.dissolveShader = shader;
  };

  return material;
}

const sk = (D, n, k) => D[`stage${n}_${k}`];

/* ---------- core geometry helpers ---------- */

function addCyl(g, r, h, y, c, o) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, SEG), mat(c, o));
  m.position.y = y + h / 2; g.add(m); return y + h;
}
function addCone(g, rT, rB, h, y, c, o) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rT, rB, h, SEG), mat(c, o));
  m.position.y = y + h / 2; g.add(m); return y + h;
}
function addDomeUp(g, r, h, y, c, o) {
  const geo = new THREE.SphereGeometry(r, SEG, SEG / 2, 0, Math.PI * 2, 0, Math.PI / 2);
  const m = new THREE.Mesh(geo, mat(c, o)); m.scale.y = h / r; m.position.y = y;
  g.add(m); return y + h;
}
function addDomeDown(g, r, h, y, c, o) {
  const geo = new THREE.SphereGeometry(r, SEG, SEG / 2, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const m = new THREE.Mesh(geo, mat(c, o)); m.scale.y = h / r; m.position.y = y + h;
  g.add(m); return y + h;
}
function addSphere(g, r, cy, c, o) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, SEG, SEG), mat(c, o));
  m.position.y = cy; g.add(m);
}
function addWall(g, r, h, y) {
  const geo = new THREE.CylinderGeometry(r, r, h, SEG, 1, true);
  const m = new THREE.Mesh(geo, mat(C.wall, { alpha: 0.18, double: true, rough: 0.3, coat: 0.2 }));
  m.position.y = y + h / 2; g.add(m);
}
function addRing(g, y, r) {
  const geo = new THREE.TorusGeometry(r + 0.002, r * 0.008, 8, SEG);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: C.ring }));
  m.rotation.x = Math.PI / 2; m.position.y = y; g.add(m);
}
function addThrustRing(g, y, R) {
  const geo = new THREE.TorusGeometry(R * EW, R * 0.025, 8, SEG);
  const m = new THREE.Mesh(geo, mat(0x555560, { metal: 0.7, rough: 0.2 }));
  m.rotation.x = Math.PI / 2; m.position.y = y; g.add(m);
}

/* ---------- engine nozzle: lathe + chamber + gimbal + glow + plume ----------
 *
 * All meshes (including the emissive glow ring + plume cones) go
 * directly into `g` — i.e. the stage's subgroup. That way when a
 * stage moves up during the Explode animation, its engine glow
 * moves with it instead of being left behind at the original
 * position. UnrealBloomPass is a screen-space effect so it picks
 * up the bright emissive pixels regardless of group hierarchy.
 */

function addNozzle(g, y, stageR, engLen) {
  const tR = stageR * EW * 0.28;
  const eR = stageR * EW * 0.88;
  const len = engLen * 0.45;
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const r = tR + (eR - tR) * Math.pow(t, 0.52);
    pts.push(new THREE.Vector2(r, -t * len));
  }
  const geo = new THREE.LatheGeometry(pts, SEG);
  const m = new THREE.Mesh(geo, mat(C.nozzle, { metal: 0.85, rough: 0.12, coat: 0.6, double: true }));
  m.position.y = y; g.add(m);

  const chR = tR * 0.9, chH = engLen * 0.18;
  const ch = new THREE.Mesh(
    new THREE.CylinderGeometry(chR, chR * 1.1, chH, 24),
    mat(0x2a2a30, { metal: 0.9, rough: 0.1, coat: 0.5 }),
  );
  ch.position.y = y + chH * 0.3; g.add(ch);

  const gimR = tR * 1.15;
  const gim = new THREE.Mesh(
    new THREE.TorusGeometry(gimR, gimR * 0.06, 8, SEG),
    mat(0x444450, { metal: 0.8, rough: 0.15 }),
  );
  gim.rotation.x = Math.PI / 2; gim.position.y = y + 0.01; g.add(gim);

  /* Glow ring + plume — bright enough to cross the bloom threshold
     and wash with light in post-processing. Live in the same group
     as the rest of the engine so they explode together. */
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(eR * 0.85, eR * 0.08, 12, SEG),
    new THREE.MeshBasicMaterial({ color: 0xff5a1a }),
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.y = y - len;
  /* `userData.plume` tags let the launch-sequence controller find and
     flare each stage's exhaust visuals without keeping refs through
     the builder call chain. */
  glow.userData.plume = 'ring';
  g.add(glow);

  const plH = engLen * 0.5, exitY = y - len;
  const cM = new THREE.Mesh(
    new THREE.ConeGeometry(eR * 0.3, plH * 0.5, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8833, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  cM.position.y = exitY - plH * 0.25;
  cM.userData.plume = 'inner';
  g.add(cM);
  const oM = new THREE.Mesh(
    new THREE.ConeGeometry(eR * 0.7, plH, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
  );
  oM.position.y = exitY - plH * 0.5;
  oM.userData.plume = 'outer';
  g.add(oM);

  /* Turbopump exhaust pipe — small but adds engineering credibility. */
  const pipeA = Math.PI * 0.75;
  const pipePts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const pr = tR + (eR - tR) * Math.pow(t, 0.52) + eR * 0.08;
    pipePts.push(new THREE.Vector3(Math.cos(pipeA) * pr, y - t * len, Math.sin(pipeA) * pr));
  }
  const pipePath = new THREE.CatmullRomCurve3(pipePts);
  g.add(new THREE.Mesh(
    new THREE.TubeGeometry(pipePath, 16, stageR * 0.01, 6, false),
    mat(0x555560, { metal: 0.7, rough: 0.2 }),
  ));
}

/* ---------- TVC actuators (thrust vector control rods) ---------- */

function addTVC(g, y, stageR, engLen) {
  const actR = stageR * 0.013;
  const actMat = mat(0x777780, { metal: 0.8, rough: 0.15 });
  const eW = stageR * EW;
  const upperY = y + engLen * 0.45;
  const lowerY = y + engLen * 0.05;
  const upperR = eW * 0.72;
  const lowerR = eW * 0.32;
  for (let i = 0; i < 2; i++) {
    const a = Math.PI * 0.3 + i * Math.PI;
    const path = new THREE.LineCurve3(
      new THREE.Vector3(Math.cos(a) * upperR, upperY, Math.sin(a) * upperR),
      new THREE.Vector3(Math.cos(a) * lowerR, lowerY, Math.sin(a) * lowerR),
    );
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 2, actR, 6, false), actMat));
    const pU = new THREE.Mesh(new THREE.SphereGeometry(actR * 2.2, 8, 8), actMat);
    pU.position.set(Math.cos(a) * upperR, upperY, Math.sin(a) * upperR); g.add(pU);
    const pL = new THREE.Mesh(new THREE.SphereGeometry(actR * 2.2, 8, 8), actMat);
    pL.position.set(Math.cos(a) * lowerR, lowerY, Math.sin(a) * lowerR); g.add(pL);
  }
}

/* ---------- delta fins ---------- */

function addFins(g, baseY, R, numFins, engLen) {
  const root = engLen * 0.9;
  const span = R * 0.55;
  const tip = root * 0.2;
  const sw = root * 0.5;
  const thick = R * 0.025;

  const shape = new THREE.Shape();
  shape.moveTo(R * 0.98, 0);
  shape.lineTo(R * 0.98, root);
  shape.lineTo(R + span, sw + tip);
  shape.lineTo(R + span, sw);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick, bevelEnabled: true,
    bevelThickness: thick * 0.3, bevelSize: thick * 0.3, bevelSegments: 2,
  });
  const finMat = mat(C.fin, { metal: 0.55, rough: 0.2, coat: 0.4 });

  for (let i = 0; i < numFins; i++) {
    const mesh = new THREE.Mesh(geo, finMat);
    mesh.position.z = -thick / 2;
    const piv = new THREE.Group();
    piv.add(mesh);
    piv.rotation.y = (i / numFins) * Math.PI * 2;
    piv.position.y = baseY;
    g.add(piv);
  }
}

/* ---------- vertical stringers (subtle line graphics on shell) ---------- */

function addStringers(g, baseY, h, R, num) {
  const lMat = new THREE.LineBasicMaterial({ color: 0x333340, transparent: true, opacity: 0.3 });
  for (let i = 0; i < num; i++) {
    const a = (i / num) * Math.PI * 2;
    const cx = Math.cos(a) * R, cz = Math.sin(a) * R;
    const pts = [new THREE.Vector3(cx, baseY, cz), new THREE.Vector3(cx, baseY + h, cz)];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lMat));
  }
}

/* ---------- horizontal stiffener rings ---------- */

function addStiffeners(g, baseY, h, R, spacing) {
  const rMat = new THREE.MeshBasicMaterial({ color: 0x444450, transparent: true, opacity: 0.3 });
  const n = Math.floor(h / spacing);
  for (let i = 1; i < n; i++) {
    const geo = new THREE.TorusGeometry(R + 0.003, R * 0.005, 6, SEG);
    const m = new THREE.Mesh(geo, rMat);
    m.rotation.x = Math.PI / 2; m.position.y = baseY + i * spacing; g.add(m);
  }
}

/* ---------- external conduit (vertical pipe) ---------- */

function addConduit(g, baseY, h, R, angle) {
  const r = R * 0.015;
  const cx = Math.cos(angle) * R, cz = Math.sin(angle) * R;
  const path = new THREE.LineCurve3(
    new THREE.Vector3(cx, baseY, cz),
    new THREE.Vector3(cx, baseY + h, cz),
  );
  g.add(new THREE.Mesh(
    new THREE.TubeGeometry(path, 1, r, 8, false),
    mat(0x666677, { metal: 0.6, rough: 0.3 }),
  ));
}

/* ---------- access panel outlines (curved rectangle lines) ---------- */

function addAccessPanels(g, baseY, h, R) {
  const lMat = new THREE.LineBasicMaterial({ color: 0x555560, transparent: true, opacity: 0.25 });
  const pw = 0.1, ph = 0.07;
  const panels = [
    { a: Math.PI * 0.15, f: 0.35 },
    { a: Math.PI * 0.65, f: 0.55 },
    { a: Math.PI * 1.20, f: 0.40 },
    { a: Math.PI * 1.70, f: 0.65 },
  ];
  const rr = R + 0.005;
  for (const p of panels) {
    const cy = baseY + h * p.f, halfArc = pw / (2 * R);
    const pts = [];
    for (let j = 0; j <= 4; j++) {
      const aa = p.a - halfArc + (j / 4) * 2 * halfArc;
      pts.push(new THREE.Vector3(Math.cos(aa) * rr, cy - ph / 2, Math.sin(aa) * rr));
    }
    pts.push(new THREE.Vector3(Math.cos(p.a + halfArc) * rr, cy + ph / 2, Math.sin(p.a + halfArc) * rr));
    for (let j = 4; j >= 0; j--) {
      const aa = p.a - halfArc + (j / 4) * 2 * halfArc;
      pts.push(new THREE.Vector3(Math.cos(aa) * rr, cy + ph / 2, Math.sin(aa) * rr));
    }
    pts.push(new THREE.Vector3(Math.cos(p.a - halfArc) * rr, cy - ph / 2, Math.sin(p.a - halfArc) * rr));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lMat));
  }
}

/* ---------- RCS thruster pods (small thrusters around interstages) ---------- */

function addRCSPods(g, y, R, num) {
  const podR = R * 0.04, podL = R * 0.12;
  const pMat = mat(0x888888, { metal: 0.7, rough: 0.2 });
  const nMat = mat(0x333333, { metal: 0.5, rough: 0.3 });
  for (let i = 0; i < num; i++) {
    const a = (i / num) * Math.PI * 2;
    const pod = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(podL, podR * 2, podR * 2), pMat);
    pod.add(body);
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(podR * 0.4, podR * 0.7, podL * 0.25, 8), nMat);
    noz.rotation.z = Math.PI / 2; noz.position.x = podL * 0.55; pod.add(noz);
    pod.position.set(Math.cos(a) * (R + podL * 0.4), y, Math.sin(a) * (R + podL * 0.4));
    pod.rotation.y = -a; g.add(pod);
  }
}

/* ---------- separation bolts (tiny spheres at stage seams) ---------- */

function addSepBolts(g, y, R, num) {
  const bMat = mat(0x888890, { metal: 0.8, rough: 0.15 });
  const br = R * 0.018;
  for (let i = 0; i < num; i++) {
    const a = (i / num) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.SphereGeometry(br, 6, 6), bMat);
    b.position.set(Math.cos(a) * (R + br * 0.5), y, Math.sin(a) * (R + br * 0.5)); g.add(b);
  }
}

/* ---------- interstage lattice struts (visible behind transparent cone) ---------- */

function addInterstageStruts(g, baseY, h, botR, topR, num) {
  const strutR = Math.max(botR, topR) * 0.012;
  const sMat = mat(0x888888, { metal: 0.6, rough: 0.2 });
  for (let i = 0; i < num; i++) {
    const a = (i / num) * Math.PI * 2;
    const path = new THREE.LineCurve3(
      new THREE.Vector3(Math.cos(a) * botR * 0.95, baseY,     Math.sin(a) * botR * 0.95),
      new THREE.Vector3(Math.cos(a) * topR * 0.95, baseY + h, Math.sin(a) * topR * 0.95),
    );
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 1, strutR, 6, false), sMat));
  }
}

/* ---------- payload antenna (rod with red tip) ---------- */

function addAntenna(g, y, R, angle) {
  const a = angle != null ? angle : Math.PI / 2;
  const bH = R * 0.14, rH = R * 0.7, rR = R * 0.022;
  const ax = Math.cos(a) * R * 0.7, az = Math.sin(a) * R * 0.7;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.06, R * 0.08, bH, 8),
    mat(0x888888, { metal: 0.7, rough: 0.2 }),
  );
  base.position.set(ax, y + bH / 2, az); g.add(base);
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(rR, rR, rH, 8),
    mat(0xaaaaaa, { metal: 0.8, rough: 0.15 }),
  );
  rod.position.set(ax, y + bH + rH / 2, az); g.add(rod);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(rR * 3, 8, 8),
    mat(0xdd2200, { metal: 0.2, rough: 0.4 }),
  );
  tip.position.set(ax, y + bH + rH, az); g.add(tip);
}

/* ---------- patch antenna (flat telemetry on payload skin) ---------- */

function addPatchAntenna(g, y, R, angle) {
  const pw = R * 0.2, ph = R * 0.16, pd = R * 0.025;
  const ax = Math.cos(angle) * (R + pd / 2 + 0.005), az = Math.sin(angle) * (R + pd / 2 + 0.005);
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(pw, ph, pd),
    mat(0xcccccc, { metal: 0.3, rough: 0.5 }),
  );
  back.position.set(ax, y, az); back.rotation.y = -angle; g.add(back);
  const face = new THREE.Mesh(
    new THREE.BoxGeometry(pw * 0.85, ph * 0.85, pd * 0.3),
    mat(0xddddee, { metal: 0.15, rough: 0.7 }),
  );
  face.position.set(Math.cos(angle) * (R + pd + 0.005), y, Math.sin(angle) * (R + pd + 0.005));
  face.rotation.y = -angle; g.add(face);
}

/* ---------- payload mechanical details (bands, solar stubs, star trackers,
                                          sensor dome, thermal blanket band) ---------- */

function addPayloadDetails(g, baseY, h, R) {
  const bdMat = mat(0x777780, { metal: 0.6, rough: 0.2 });
  for (const f of [0.3, 0.65]) {
    const geo = new THREE.TorusGeometry(R + 0.004, R * 0.012, 8, SEG);
    const m = new THREE.Mesh(geo, bdMat);
    m.rotation.x = Math.PI / 2; m.position.y = baseY + h * f; g.add(m);
  }

  /* Folded solar panel stubs flush against body (dark blue strips). */
  const spMat = mat(0x1a2a55, { metal: 0.3, rough: 0.4, coat: 0.3 });
  for (let i = 0; i < 2; i++) {
    const a = Math.PI * i;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(R * 0.16, h * 0.4, R * 0.02), spMat);
    sp.position.set(Math.cos(a) * (R + R * 0.01), baseY + h * 0.5, Math.sin(a) * (R + R * 0.01));
    sp.rotation.y = -a; g.add(sp);
  }

  /* Star tracker housings on the equator. */
  const stMat = mat(0x222230, { metal: 0.5, rough: 0.3 });
  for (let i = 0; i < 2; i++) {
    const a = Math.PI * 0.5 + Math.PI * i;
    const st = new THREE.Mesh(new THREE.BoxGeometry(R * 0.08, R * 0.06, R * 0.1), stMat);
    st.position.set(Math.cos(a) * (R + R * 0.045), baseY + h * 0.75, Math.sin(a) * (R + R * 0.045));
    st.rotation.y = -a; g.add(st);
  }

  /* Top sensor dome — sits at the apex of the payload. */
  const dGeo = new THREE.SphereGeometry(R * 0.15, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const dome = new THREE.Mesh(dGeo, mat(0x333340, { metal: 0.5, rough: 0.3, coat: 0.3 }));
  dome.position.y = baseY + h; g.add(dome);

  /* Gold thermal blanket band — translucent MLI foil look. */
  const blGeo = new THREE.CylinderGeometry(R + 0.003, R + 0.003, h * 0.12, SEG, 1, true);
  const bl = new THREE.Mesh(blGeo, mat(0xaa8844, { metal: 0.4, rough: 0.35, alpha: 0.55, double: true }));
  bl.position.y = baseY + h * 0.15; g.add(bl);
}

/* ---------- per-component tooltip metadata ----------
 *
 * Each major mechanical assembly (engine, fuel tank, oxidiser tank,
 * outer wall, interstage, payload, fairing) gets its own tooltip
 * payload attached via `userData.tooltipInfo` on its meshes. The
 * raycaster in `setupRocketScene` finds the hovered mesh and walks
 * up to the nearest tagged ancestor to look up the tooltip text.
 *
 * Builders below take the rocket-data dict and return:
 *
 *     { title: string, items: [{ label, value }, …] }
 *
 * Items with a missing/non-finite value are filtered out, so older
 * sim outputs (which may not include propellant masses, for example)
 * just produce a shorter tooltip rather than rendering "—" rows.
 */

function fmtLen(m) {
  if (m == null || !Number.isFinite(m)) return null;
  return `${m.toFixed(2)} m`;
}
function fmtMass(kg) {
  if (kg == null || !Number.isFinite(kg) || kg <= 0) return null;
  return Math.abs(kg) >= 1000
    ? `${(kg / 1000).toFixed(2)} t`
    : `${kg.toFixed(0)} kg`;
}
/* Helper to filter out missing rows in one go. */
function row(label, value) {
  return value == null ? null : { label, value };
}

/* NOTE on lengths: the single "primary length" of each component
   is no longer listed as a tooltip row — it's rendered as a 3D
   dimension line beside the component instead (see the dimension-
   line system in setupRocketScene). So these builders deliberately
   omit the headline length and keep only the *other* parameters. */

function infoEngine(n, D) {
  return {
    title: `Stage ${n} Engine`,
    items: [
      row('Radius', fmtLen((D[`stage${n}_radius`] || 0) * EW)),
    ].filter(Boolean),
  };
}
function infoFuel(n, D) {
  return {
    title: `Stage ${n} Fuel Tank`,
    items: [
      row('Dome length', fmtLen(D[`stage${n}_tank_head_length`])),
      row('Propellant', fmtMass(D[`stage${n}_bottom_propellant_mass`])),
    ].filter(Boolean),
  };
}
function infoOx(n, D) {
  return {
    title: `Stage ${n} Oxidiser Tank`,
    items: [
      row('Dome length', fmtLen(D[`stage${n}_tank_head_length`])),
      row('Oxidiser', fmtMass(D[`stage${n}_top_propellant_mass`])),
    ].filter(Boolean),
  };
}
function infoWall(n, D) {
  /* The hull is the only single component that visually represents
     a whole stage, so its tooltip doubles as a stage summary —
     dimensions plus the fuel + oxidiser params that describe how
     much propellant the stage carries. The individual fuel-tank
     and ox-tank tooltips keep their own focused panels for users
     who want to drill in. */
  const isS3 = n === 3;
  return {
    title: `Stage ${n}`,
    items: [
      row('Radius', fmtLen(D[`stage${n}_radius`])),
      row('Engine length', fmtLen(D[`stage${n}_engine_length`])),
      /* Stage 3 has spherical tanks, so the "tank length" field
         doesn't really apply — skip those rows on stage 3 and let
         the propellant masses carry the info. */
      isS3 ? null : row('Fuel tank',  fmtLen(D[`stage${n}_bottom_propellant_length`])),
      row('Fuel',       fmtMass(D[`stage${n}_bottom_propellant_mass`])),
      isS3 ? null : row('Ox tank',    fmtLen(D[`stage${n}_top_propellant_length`])),
      row('Oxidiser',   fmtMass(D[`stage${n}_top_propellant_mass`])),
    ].filter(Boolean),
  };
}
function infoFuelSphere(D) {
  return {
    title: 'Stage 3 Fuel Tank',
    items: [
      row('Radius', fmtLen(D.stage3_radius)),
      row('Propellant', fmtMass(D.stage3_bottom_propellant_mass)),
    ].filter(Boolean),
  };
}
function infoOxSphere(D) {
  return {
    title: 'Stage 3 Oxidiser Tank',
    items: [
      row('Radius', fmtLen(D.stage3_radius)),
      row('Oxidiser', fmtMass(D.stage3_top_propellant_mass)),
    ].filter(Boolean),
  };
}
function infoInterstage(low, high, D) {
  return {
    title: `Interstage ${low}-${high}`,
    items: [
      row('Lower radius', fmtLen(D[`stage${low}_radius`])),
      row('Upper radius', fmtLen(D[`stage${high}_radius`])),
    ].filter(Boolean),
  };
}
function infoPayload(D) {
  return {
    title: 'Payload',
    items: [
      row('Radius', fmtLen(D.payload_radius)),
      row('Mass', fmtMass(D.payload_mass)),
    ].filter(Boolean),
  };
}
function infoFairing(D) {
  return {
    title: 'Fairing',
    items: [
      row('Radius', fmtLen(D.fairing_radius)),
    ].filter(Boolean),
  };
}

/**
 * Tag every direct child of `group` from index `since` to the end
 * with the given tooltipInfo. Used by buildRocket / addStage12 /
 * addStage3 to associate a chunk of just-added meshes with the
 * component they collectively represent.
 *
 * `bounds` (optional) is `{ yBot, yTop }` in the component's
 * build-time local frame (== root-local, since subgroups start at
 * position 0). It's the axial span the 3D dimension line will
 * measure. `group` is stashed as `info.subgroup` so the dimension
 * line can read its live explode offset (`subgroup.position.y`)
 * and travel with the part when the rocket disassembles. Pass
 * `null` bounds for components with no meaningful axial length
 * (e.g. spherical stage-3 tanks) — they get a tooltip but no line.
 */
function tagSince(group, since, info, bounds = null) {
  info.subgroup = group;
  info.bounds = bounds;
  for (let i = since; i < group.children.length; i++) {
    group.children[i].userData.tooltipInfo = info;
  }
}

/* ---------- stage builders (full mechanical detail) ---------- */

function addStage12(g, D, n, y) {
  const R = sk(D, n, 'radius'), tw = R * TW;
  const engLen = sk(D, n, 'engine_length');
  const fuelLen = sk(D, n, 'bottom_propellant_length');
  const oxLen = sk(D, n, 'top_propellant_length');
  const headLen = sk(D, n, 'tank_head_length');
  const bot = y;

  /* Engine cluster — nozzle, TVC actuators, combustion-chamber
     cylinder, thrust ring. Tagged together so hovering any of the
     visible engine bits surfaces the same "Stage N Engine" panel.
     Dimension-line bounds = the engine cylinder span [bot, engTop]
     — captured explicitly rather than from a bbox, so the long
     exhaust-plume cones addNozzle draws below the bell don't bleed
     into the measured length. */
  let mark = g.children.length;
  const engBot = y;
  addNozzle(g, y, R, engLen);
  addTVC(g, y, R, engLen);
  y = addCyl(g, R * EW, engLen, y, C.engine, { metal: 0.7, rough: 0.2, coat: 0.3 });
  const engTop = y;
  addThrustRing(g, y, R);
  addRing(g, y, R);
  tagSince(g, mark, infoEngine(n, D), { yBot: engBot, yTop: engTop });

  /* Fuel tank: bottom dome + cylinder.
     Both deliberately TRANSLUCENT (alpha 0.5, double-sided) so the
     ox tank's lower dome — which lives geometrically inside the
     top portion of the fuel cylinder, modeling the common bulkhead
     between the propellants — shows through. The ox tank itself
     stays fully opaque so it reads clearly through the orange
     fuel envelope. */
  mark = g.children.length;
  const fuelBot = y;
  const fuelMatOpts = { alpha: 0.5, double: true, rough: 0.55 };
  y = addDomeDown(g, tw, headLen, y, C.fuel, fuelMatOpts);
  addCyl(g, tw, fuelLen + headLen, y, C.fuel, fuelMatOpts);
  y += fuelLen;
  const fuelTop = y;
  tagSince(g, mark, infoFuel(n, D), { yBot: fuelBot, yTop: fuelTop });

  /* Oxidiser tank — opaque blue cylinder + domes. */
  mark = g.children.length;
  const oxBot = y;
  y = addDomeDown(g, tw, headLen, y, C.ox);
  addRing(g, y, tw);
  /* Capture the ox cylinder's vertical bounds — used by the decal
     placer to wrap company markings on the stage's largest visible
     opaque surface. */
  const oxCylBot = y;
  y = addCyl(g, tw, oxLen, y, C.ox);
  const oxCylTop = y;
  y = addDomeUp(g, tw, headLen, y, C.ox);
  const oxTop = y;
  tagSince(g, mark, infoOx(n, D), { yBot: oxBot, yTop: oxTop });

  /* Outer hull — translucent shell, stringers, conduits, top ring.
     Dimension line spans the whole stage [bot, y]. */
  mark = g.children.length;
  addWall(g, R, y - bot, bot);
  addStringers(g, bot, y - bot, R, 8);
  addConduit(g, bot, y - bot, R, Math.PI * 1.0);
  addConduit(g, bot, y - bot, R, Math.PI * 2.0);
  addRing(g, y, R);
  tagSince(g, mark, infoWall(n, D), { yBot: bot, yTop: y });

  return { y, oxCylBot, oxCylTop };
}

function addStage3(g, D, y) {
  const R = sk(D, 3, 'radius');
  const engLen = sk(D, 3, 'engine_length');
  const bot = y;

  /* Engine. */
  let mark = g.children.length;
  const engBot = y;
  addNozzle(g, y, R, engLen);
  addTVC(g, y, R, engLen);
  y = addCyl(g, R * EW, engLen, y, C.engine, { metal: 0.7, rough: 0.2, coat: 0.3 });
  const engTop = y;
  addThrustRing(g, y, R);
  tagSince(g, mark, infoEngine(3, D), { yBot: engBot, yTop: engTop });

  y += GAP;
  /* Fuel tank — spherical. No dimension line (a sphere has no
     single meaningful axial "length"; a diameter line beside a
     "Radius" tooltip row would read as a contradiction). */
  mark = g.children.length;
  addSphere(g, R, y + R, C.fuel);
  y += R * 2 + GAP;
  tagSince(g, mark, infoFuelSphere(D), null);

  /* Oxidiser tank — spherical, same no-line rule. */
  mark = g.children.length;
  addSphere(g, R, y + R, C.ox);
  y += R * 2;
  tagSince(g, mark, infoOxSphere(D), null);

  /* Outer hull — dimension line spans the whole stage [bot, y]. */
  mark = g.children.length;
  addWall(g, R, y - bot, bot);
  addStringers(g, bot, y - bot, R, 6);
  addRing(g, y, R);
  tagSince(g, mark, infoWall(3, D), { yBot: bot, yTop: y });

  return y;
}

/* ---------- cover livery palettes ----------
 *
 * Each palette drives the procedural paint scheme baked onto the cover
 * skin. `base` is the big body colour (what changes between colour
 * modes); the roll pattern + stage bands are the "fixed" black/white
 * accents that stay constant so the vehicle keeps a consistent
 * identity; `logoColor` flips light/dark for contrast against `base`.
 * Phase 2 only wires up `white`; the picker in Phase 3 swaps between
 * several of these.
 */
const COVER_PALETTES = {
  white: {
    base:      '#E6E6EA',
    panelLine: 'rgba(120,120,138,0.30)',
    ring:      'rgba(95,95,112,0.26)',
    rivet:     'rgba(80,80,95,0.28)',
    band:      '#17171c',
    rollA:     '#111114',
    rollB:     '#ededf0',
    logoColor: '#141418',
    raceway:   0xb8b8c0,
    ringMetal: 0x2a2a30,
    /* Skin finish — kept matte-ish so the white body doesn't read as
       glossy plastic. */
    skinRough: 0.62, skinMetal: 0.10, skinCoat: 0.16, skinEnv: 0.38,
  },
  black: {
    base:      '#17181c',
    panelLine: 'rgba(200,200,215,0.16)',
    ring:      'rgba(190,190,205,0.13)',
    rivet:     'rgba(210,210,225,0.15)',
    band:      '#050506',
    rollA:     '#050506',
    rollB:     '#e8e8ec',
    logoColor: '#f2f2f6',
    raceway:   0x2c2c33,
    ringMetal: 0x101013,
    /* Painted (dielectric) finish — near-zero metalness + low env so
       the dark curved body doesn't sparkle/shimmer as it spins. */
    skinRough: 0.62, skinMetal: 0.04, skinCoat: 0.08, skinEnv: 0.26,
  },
  darkblue: {
    base:      '#1a2740',
    panelLine: 'rgba(170,190,225,0.18)',
    ring:      'rgba(150,175,215,0.15)',
    rivet:     'rgba(190,205,235,0.15)',
    band:      '#0b1120',
    rollA:     '#0b1120',
    rollB:     '#eef2f8',
    logoColor: '#eef3fb',
    raceway:   0x2a3a58,
    ringMetal: 0x101828,
    /* Painted (dielectric) finish — matte navy, minimal reflections. */
    skinRough: 0.6, skinMetal: 0.05, skinCoat: 0.10, skinEnv: 0.28,
  },
  metal: {
    base:      '#b8bcc4',
    panelLine: 'rgba(70,72,80,0.32)',
    ring:      'rgba(60,62,70,0.30)',
    rivet:     'rgba(50,52,60,0.3)',
    band:      '#3a3d45',
    rollA:     '#222327',
    rollB:     '#e6e8ec',
    logoColor: '#1b1c20',
    raceway:   0x9aa0aa,
    ringMetal: 0x3a3d45,
    /* Brushed metal — metallic but deliberately ROUGH (and no
       clearcoat) so the environment reflection is diffuse rather than
       a sharp highlight that sparkles/shimmers on the spinning body. */
    skinRough: 0.58, skinMetal: 0.85, skinCoat: 0.0, skinEnv: 0.5,
  },
};

/* Recolour a monochrome logo silhouette to `color` at the requested
   pixel size. `source-in` keeps the image's alpha shape but replaces
   every opaque pixel with the flat fill, so the same single-colour SVG
   can be tinted light or dark for contrast against any body colour. */
function tintImage(img, color, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, c.width, c.height);
  cx.globalCompositeOperation = 'source-in';
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, c.height);
  return c;
}

/* ---------- procedural cover livery texture ----------
 *
 * Draws the paint scheme onto a canvas that is mapped onto the cover
 * lathe. Because the lathe's V coordinate is remapped to normalised
 * height (see buildCover), texture-V == height/yMax — so bands, rings
 * and the roll pattern land at exact physical heights. Baking the
 * detail (and, asynchronously, the logo) into this one texture means it
 * erodes together with the skin during the dissolve reveal, instead of
 * detail meshes hanging in mid-air.
 */
function buildCoverLivery(geom) {
  const { yMax, bands = [], rollTop = 0, seams = 28 } = geom;
  const CW = 2048, CH = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  const ctx = canvas.getContext('2d');

  /* CanvasTexture defaults to flipY = true, so texture-V 0 (bottom of
     the rocket) maps to the BOTTOM row of the canvas. */
  const vToY = (v) => (1 - v) * CH;

  /* Draw the whole paint scheme for `palette`. Called on first build
     and again whenever the colour mode changes (the decals are then
     re-stamped on top by buildCover). */
  const drawBase = (palette) => {
    ctx.fillStyle = palette.base;
    ctx.fillRect(0, 0, CW, CH);

    /* Vertical panel seams. */
    ctx.strokeStyle = palette.panelLine;
    ctx.lineWidth = 2;
    for (let i = 0; i < seams; i++) {
      const px = (i / seams) * CW;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, CH); ctx.stroke();
    }

    /* Horizontal stiffener rings (~every 2.6 m). Rivets go on alternate
       rings only, sparse and chunky — dense 1px dots otherwise alias
       into shimmering "static" when the cylinder is seen at grazing
       angles (very visible on dark/metal bodies). */
    const ringN = Math.max(2, Math.floor(yMax / 2.6));
    for (let i = 1; i < ringN; i++) {
      const py = vToY(i / ringN);
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(CW, py); ctx.stroke();
      if (i % 2 === 0) {
        ctx.fillStyle = palette.rivet;
        for (let j = 0; j < seams; j++) {
          const px = ((j + 0.5) / seams) * CW;
          ctx.beginPath(); ctx.arc(px, py, 2.4, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    /* Dark stage bands (fixed accent) across each interstage span. */
    ctx.fillStyle = palette.band;
    for (const b of bands) {
      const yTop = vToY(b.y1 / yMax);
      const yBot = vToY(b.y0 / yMax);
      ctx.fillRect(0, yTop, CW, yBot - yTop);
    }

    /* Roll pattern near the base — alternating black/white blocks, the
       classic optical-tracking checkerboard. Fixed accent. */
    if (rollTop > 0) {
      const yTop = vToY(rollTop / yMax);
      const yBot = vToY(0);
      const cells = 12, rows = 3;
      const cw = CW / cells, rh = (yBot - yTop) / rows;
      for (let r = 0; r < rows; r++) {
        for (let cI = 0; cI < cells; cI++) {
          ctx.fillStyle = ((r + cI) % 2 === 0) ? palette.rollA : palette.rollB;
          ctx.fillRect(cI * cw, yTop + r * rh, cw, rh);
        }
      }
    }
  };

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  /* High anisotropy + mipmaps (on by default for this POT canvas) are
     what keep the fine livery lines from shimmering on the near-grazing
     cylinder sides as the rocket spins. */
  tex.anisotropy = 16;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;

  return { canvas, ctx, tex, vToY, CW, CH, drawBase };
}

/* ---------- removable outer cover (the "real rocket" aeroshell) ----------
 *
 * A single continuous outer-mold-line skin lofted from the vehicle's
 * radius profile: stage-1 barrel → interstage cone → stage-2 barrel →
 * interstage cone → stage-3 barrel → payload-adapter shoulder →
 * fairing barrel → ogive nose. Opaque, so by default it hides the
 * detailed internals and the vehicle reads as a finished rocket.
 *
 * The skin carries a baked procedural livery texture (panel lines,
 * rings, stage bands, roll pattern, and — loaded async — the company
 * logo + national flag). A couple of raised geometry accents (a cable
 * raceway running the body and a base structural ring) add real 3D
 * relief. Every cover material is a dissolve material driven by the
 * same `uDissolve`, so the whole assembly erodes together on reveal.
 *
 * Colour modes: `setColorMode(name)` re-draws the livery + re-stamps
 * the decals for the chosen palette and retints the skin finish, so
 * the whole vehicle recolours live. `m` carries the axial milestones
 * already computed inside buildRocket so we don't re-derive heights.
 */
function buildCover(D, m) {
  /* The cover skin is inflated a few percent beyond the internal hull
     walls (which sit at the raw stage radii). Without this margin the
     opaque skin and the translucent internal walls are coincident and
     z-fight — a shimmering "static" that's especially visible on a
     dark/metal cover. The gap also reads as a real aeroshell standing
     off the tank structure. */
  const COVER_MARGIN = 1.03;
  const R1 = D.stage1_radius * COVER_MARGIN;
  const R2 = D.stage2_radius * COVER_MARGIN;
  const R3 = D.stage3_radius * COVER_MARGIN;
  const fRad = D.fairing_radius * 1.15 * COVER_MARGIN;

  /* (y, r) profile, bottom → top. Same-y / different-r pairs form flat
     shoulder rings (e.g. the payload adapter where the body steps out
     to the wider fairing). */
  const raw = [
    [0,         R1],
    [m.s1Top,   R1],
    [m.is12Top, R2],
    [m.s2Top,   R2],
    [m.is23Top, R3],
    [m.fBot,    R3],
    [m.fBot,    fRad],
    [m.fBot + m.fCylH, fRad],
  ];
  const M = 40;
  for (let i = 1; i <= M; i++) {
    const s = i / M;
    const r = fRad * Math.sqrt(Math.max(1 - s * s, 0));
    raw.push([m.fBot + m.fCylH + s * m.fNoseH, Math.max(r, 0.001)]);
  }

  /* Enforce strictly-ascending Y so the lathe never self-inverts even
     if the geometry's relative heights come out unusual. */
  const pts = [];
  let prevY = -Infinity;
  for (const [yy, rr] of raw) {
    const y = yy <= prevY ? prevY + 1e-4 : yy;
    pts.push(new THREE.Vector2(Math.max(rr, 0.001), y));
    prevY = y;
  }
  const yMax = pts[pts.length - 1].y;

  /* Interpolate the outer radius at any height — used to lay the raised
     accents (raceway, base ring) just proud of the skin. */
  const radiusAt = (y) => {
    if (y <= pts[0].y) return pts[0].x;
    for (let i = 1; i < pts.length; i++) {
      if (y <= pts[i].y) {
        const span = pts[i].y - pts[i - 1].y || 1;
        const t = (y - pts[i - 1].y) / span;
        return pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
      }
    }
    return pts[pts.length - 1].x;
  };

  /* Mutable cover state: the active palette + cached decal images. */
  const state = {
    palette: COVER_PALETTES.white,
    logoImg: null,
    flagImg: null,
  };

  /* Livery texture. Bands sit on the two interstages; roll pattern
     covers the bottom ~5% of the vehicle. */
  const bands = [
    { y0: m.s1Top, y1: m.is12Top },
    { y0: m.s2Top, y1: m.is23Top },
  ];
  const livery = buildCoverLivery({
    yMax,
    bands,
    rollTop: yMax * 0.05,
    seams: 22,
  });

  /* Main skin lathe. Colour stays white so the baked texture shows
     through unmodulated; V remapped to normalised height so the livery
     lines up with real heights. */
  const material = makeDissolveMaterial(
    0xffffff,
    { rough: 0.5, metal: 0.12, coat: 0.2, coatR: 0.2, env: 0.4, double: true },
    { yMin: 0, yMax, noiseScale: 3.0, sweep: 0.55 },
  );
  material.map = livery.tex;

  const geo = new THREE.LatheGeometry(pts, SEG);
  const posAttr = geo.attributes.position;
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < posAttr.count; i++) {
    uvAttr.setY(i, posAttr.getY(i) / yMax);
  }
  uvAttr.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, material);
  mesh.userData.coverMember = true;

  const group = new THREE.Group();
  group.userData.cover = true;
  group.add(mesh);

  const materials = [material];
  const dissolveOpts = { yMin: 0, yMax, noiseScale: 3.0, sweep: 0.55 };

  /* Cable raceway — a raised conduit running the body length on one
     side, following the stepped radius. Built in absolute coordinates
     so its object-space Y is the true height and the dissolve sweep
     matches the skin. */
  const rcAngle = Math.PI * 0.82;
  const rcTop = m.fBot;
  const rcBot = yMax * 0.04;
  const rcPts = [];
  const RCN = 48;
  for (let i = 0; i <= RCN; i++) {
    const y = rcBot + (rcTop - rcBot) * (i / RCN);
    const r = radiusAt(y) * 1.004 + fRad * 0.006;
    rcPts.push(new THREE.Vector3(Math.cos(rcAngle) * r, y, Math.sin(rcAngle) * r));
  }
  const rcMat = makeDissolveMaterial(
    state.palette.raceway, { metal: 0.5, rough: 0.35, coat: 0.2 }, dissolveOpts,
  );
  group.add(new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rcPts), RCN, fRad * 0.022, 8, false),
    rcMat,
  ));
  materials.push(rcMat);

  /* Base structural ring. Geometry is translated so its Y is absolute
     (mesh stays at the origin), keeping the dissolve height correct. */
  const ringY = yMax * 0.03;
  const ringGeo = new THREE.TorusGeometry(R1 * 1.004, R1 * 0.02, 10, SEG);
  ringGeo.rotateX(Math.PI / 2);
  ringGeo.translate(0, ringY, 0);
  const ringMat = makeDissolveMaterial(
    state.palette.ringMetal, { metal: 0.6, rough: 0.3 }, dissolveOpts,
  );
  group.add(new THREE.Mesh(ringGeo, ringMat));
  materials.push(ringMat);

  /* ── decals: logo (tinted for contrast) stacked over the full-colour
     flag, mirrored at φ=0 and φ=π so a mark is always in view. Drawn on
     top of the base livery; re-stamped whenever the base is redrawn. ── */
  const logoCenterY = (m.is12Top + m.s2Top) / 2;
  const LOGO_ARC = 0.34;   // fraction of circumference (bumped up a touch)
  const FLAG_ARC = 0.15;

  const stampDecals = (palette) => {
    const { ctx, CW, CH, vToY } = livery;
    const boxHfor = (img, arc, fallbackAspect) => {
      const aspect = (img && img.naturalWidth && img.naturalHeight)
        ? img.naturalWidth / img.naturalHeight : fallbackAspect;
      const physH = (arc * 2 * Math.PI * R2) / aspect;
      return (physH / yMax) * CH;
    };
    const logoH = state.logoImg ? boxHfor(state.logoImg, LOGO_ARC, 4.59) : 0;
    const flagH = state.flagImg ? boxHfor(state.flagImg, FLAG_ARC, 1.4) : 0;
    const gap = state.logoImg && state.flagImg ? Math.max(logoH * 0.3, 8) : 0;
    const blockH = logoH + gap + flagH;
    /* Canvas Y grows downward, so the smallest Y is the TOP of the
       block → the logo sits above the flag on the vehicle. */
    let y = vToY(logoCenterY / yMax) - blockH / 2;

    if (state.logoImg) {
      const boxW = LOGO_ARC * CW;
      const tinted = tintImage(state.logoImg, palette.logoColor, boxW, logoH);
      for (const uc of [0.25, 0.75]) {
        ctx.drawImage(tinted, uc * CW - boxW / 2, y, boxW, logoH);
      }
      y += logoH + gap;
    }
    if (state.flagImg) {
      const boxW = FLAG_ARC * CW;
      for (const uc of [0.25, 0.75]) {
        ctx.drawImage(state.flagImg, uc * CW - boxW / 2, y, boxW, flagH);
      }
    }
  };

  /* Push the palette's finish onto the live materials (called on build
     and on every colour-mode change). */
  const applyFinish = (palette) => {
    material.roughness = palette.skinRough;
    material.metalness = palette.skinMetal;
    material.clearcoat = palette.skinCoat;
    material.envMapIntensity = palette.skinEnv;
    rcMat.color.set(palette.raceway);
    ringMat.color.set(palette.ringMetal);
  };

  /* First paint (decals stamp in later once their images load). */
  livery.drawBase(state.palette);
  applyFinish(state.palette);

  /* Async decal loader — caches the images then stamps them for the
     current palette. `isAlive` guards a torn-down scene. */
  const applyDecals = (isAlive) => {
    if (typeof window === 'undefined') return;
    Promise.all([
      loadImage(DECAL_LOGO_URL).catch(() => null),
      loadImage(DECAL_FLAG_URL).catch(() => null),
    ]).then(([logo, flag]) => {
      if (isAlive && !isAlive()) return;
      state.logoImg = logo;
      state.flagImg = flag;
      stampDecals(state.palette);
      livery.tex.needsUpdate = true;
    }).catch(() => { /* silent — decals are cosmetic */ });
  };

  /* Live colour-mode switch. */
  const setColorMode = (mode) => {
    const palette = COVER_PALETTES[mode];
    if (!palette) return;
    state.palette = palette;
    livery.drawBase(palette);
    stampDecals(palette);
    livery.tex.needsUpdate = true;
    applyFinish(palette);
  };

  return { group, materials, yMin: 0, yMax, applyDecals, setColorMode };
}

/* ---------- full rocket assembly with per-stage subgroups ----------
 *
 * Each stage / interstage / payload / fairing is assembled into its
 * own THREE.Group, parented to the same root group. Why? The
 * "Explode" toggle simply animates each subgroup's `position.y`
 * along the rocket's long axis — no geometry rebuild needed. The
 * outer shell + fins span multiple stages so they live on the root.
 */

function buildRocket(D) {
  const root = new THREE.Group();

  const stage1   = new THREE.Group();
  const inter12  = new THREE.Group();
  const stage2   = new THREE.Group();
  const inter23  = new THREE.Group();
  const stage3   = new THREE.Group();
  const payload  = new THREE.Group();
  const fairing  = new THREE.Group();
  const shell    = new THREE.Group();

  let y = 0;

  /* Stage 1 — its origin is at y=0; we just add into the subgroup
     directly. The stack heights track in `y` so we know where each
     subgroup ends/starts (used for explode offsets too). */
  const s1bot = 0;
  const s1Result = addStage12(stage1, D, 1, y);
  y = s1Result.y;
  const s1Top = y;

  /* Interstage 1-2 — truncated transparent cone with internal
     lattice struts visible through the wall. We deliberately do NOT
     add a "bottom ring" here: the stage's own top ring already
     marks the seam, and adding a second one at the same height
     causes the two rings to separate visibly when the user
     "explodes" the rocket (each ring lives in a different subgroup
     and travels at a different speed) — the user reads that as
     phantom new parts being produced. */
  const is12bot = y;
  let is12Mark = inter12.children.length;
  y = addCone(inter12, D.stage2_radius, D.stage1_radius,
    D.stage12_interstage_length, y, C.inter,
    { alpha: 0.25, double: true, metal: 0.3, rough: 0.35 });
  addInterstageStruts(inter12, is12bot, D.stage12_interstage_length, D.stage1_radius, D.stage2_radius, 6);
  addRCSPods(inter12, is12bot + D.stage12_interstage_length * 0.5, D.stage1_radius, 4);
  addSepBolts(inter12, is12bot, Math.max(D.stage1_radius, D.stage2_radius), 12);
  addRing(inter12, y, D.stage2_radius);
  addSepBolts(inter12, y, D.stage2_radius, 12);
  tagSince(inter12, is12Mark, infoInterstage(1, 2, D), { yBot: is12bot, yTop: y });
  const is12Top = y;

  /* Stage 2. */
  const s2bot = y;
  const s2Result = addStage12(stage2, D, 2, y);
  y = s2Result.y;
  const s2Top = y;

  /* Interstage 2-3 — same no-bottom-ring rule as inter12. */
  const is23bot = y;
  const is23Mark = inter23.children.length;
  y = addCone(inter23, D.stage3_radius, D.stage2_radius,
    D.stage23_interstage_length, y, C.inter,
    { alpha: 0.25, double: true, metal: 0.3, rough: 0.35 });
  addInterstageStruts(inter23, is23bot, D.stage23_interstage_length, D.stage2_radius, D.stage3_radius, 6);
  addRCSPods(inter23, is23bot + D.stage23_interstage_length * 0.5, D.stage2_radius, 4);
  addSepBolts(inter23, is23bot, Math.max(D.stage2_radius, D.stage3_radius), 12);
  addRing(inter23, y, D.stage3_radius);
  addSepBolts(inter23, y, D.stage3_radius, 12);
  tagSince(inter23, is23Mark, infoInterstage(2, 3, D), { yBot: is23bot, yTop: y });
  const is23Top = y;

  /* Stage 3 — spherical tanks, smaller engine. */
  const s3engBot = y;
  y = addStage3(stage3, D, y);
  const s3Top = y;

  /* Payload — golden MLI body with all the satellite details. */
  const plBot = y;
  const plMark = payload.children.length;
  y = addCyl(payload, D.payload_radius, D.payload_length, y, C.payload,
    { metal: 0.65, rough: 0.2, coat: 0.6, coatR: 0.1 });
  addPayloadDetails(payload, plBot, D.payload_length, D.payload_radius);
  addAntenna(payload, plBot + D.payload_length * 0.3, D.payload_radius, Math.PI / 2);
  addPatchAntenna(payload, plBot + D.payload_length * 0.6, D.payload_radius, -Math.PI / 2);
  addRing(payload, y, D.payload_radius);
  tagSince(payload, plMark, infoPayload(D), { yBot: plBot, yTop: y });
  const plTop = y;

  /* Fairing — cylinder + ogive nose closure, with seam lines and
     lightning protection strips. */
  const fBot = is23bot + D.stage23_interstage_length + sk(D, 3, 'engine_length') + GAP;
  const fRad = D.fairing_radius * 1.15;
  const fCylH = (plTop - fBot) + fRad * 0.4;
  const fNoseH = fRad * 1.6;
  const fLen = fCylH + fNoseH;
  const fTop = fBot + fLen;

  const fairingMark = fairing.children.length;
  const fPts = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const h = t * fLen;
    let r;
    if (h <= fCylH) {
      r = fRad;
    } else {
      const s = (h - fCylH) / fNoseH;
      r = fRad * Math.sqrt(1 - s * s);
    }
    fPts.push(new THREE.Vector2(Math.max(r, 0.001), h));
  }
  fPts.push(new THREE.Vector2(0.001, fLen));
  const fGeo = new THREE.LatheGeometry(fPts, SEG);
  const fM = new THREE.Mesh(fGeo, mat(C.fairing, { alpha: 0.22, double: true, rough: 0.25, coat: 0.3 }));
  fM.position.y = fBot;
  fairing.add(fM);

  /* Two seam lines (φ=0 and φ=π) so the fairing reads as separable. */
  const seamMat = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 });
  for (let s = 0; s < 2; s++) {
    const pts2 = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const fy = fBot + t * fLen;
      const h = t * fLen;
      let fr;
      if (h <= fCylH) { fr = fRad; }
      else { const q = (h - fCylH) / fNoseH; fr = fRad * Math.sqrt(1 - q * q); }
      fr = Math.max(fr, 0.001);
      const a = s * Math.PI;
      pts2.push(new THREE.Vector3(Math.cos(a) * fr, fy, Math.sin(a) * fr));
    }
    fairing.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts2), seamMat));
  }

  /* Lightning protection strips — three on top of the fairing nose. */
  const lpMat = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.3 });
  for (let s = 0; s < 3; s++) {
    const la = Math.PI * 0.5 + s * Math.PI * 0.67;
    const pts3 = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const fy = fBot + t * fLen;
      const h = t * fLen;
      let fr;
      if (h <= fCylH) { fr = fRad; }
      else { const q = (h - fCylH) / fNoseH; fr = fRad * Math.sqrt(1 - q * q); }
      fr = Math.max(fr, 0.001);
      pts3.push(new THREE.Vector3(Math.cos(la) * fr, fy, Math.sin(la) * fr));
    }
    fairing.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts3), lpMat));
  }
  /* Tag everything we just added to the fairing group as a single
     "Fairing" tooltip target — the lathe shell, the seam lines, and
     the lightning strips all read as one component to the user. */
  tagSince(fairing, fairingMark, infoFairing(D), { yBot: fBot, yTop: fTop });

  /* Outer transparent shell + stiffener rings + access panels.
     Spans the full stack rigidly. Tagged so the scene's tick loop
     can fade the whole envelope out as the rocket disassembles —
     otherwise it stays put and reads as ghost cylinders floating
     between the stages. */
  shell.userData.shell = true;
  const shellR = Math.max(D.stage1_radius, D.stage2_radius) + 0.02;
  const shellH = fBot - s1bot;
  const shellGeo = new THREE.CylinderGeometry(shellR, shellR, shellH, SEG, 1, true);
  const shellMat = mat(0xc0c0d0, { alpha: 0.14, double: true });
  const shellMesh = new THREE.Mesh(shellGeo, shellMat);
  shellMesh.position.y = s1bot + shellH / 2;
  shellMesh.userData.shellMember = true;
  shell.add(shellMesh);
  addStiffeners(shell, s1bot, shellH, shellR, 0.8);
  addAccessPanels(shell, s1bot, sk(D, 1, 'length'), shellR);
  addAccessPanels(shell, s2bot, sk(D, 2, 'length'), shellR);
  /* Tag every child of the shell group as a shell member so the
     fade-on-disassemble logic in setupRocketScene's tick() can
     find them all in one traverse. */
  shell.traverse((o) => { o.userData.shellMember = true; });

  /* Fins on each engine cluster. We parent each fin set to its
     OWN stage subgroup (not the root) so when that stage moves up
     during the Explode animation, its fins move with it. The
     previous version had all fins in a single root-level group,
     which left them visually stranded over the lower stage's tank
     once the stage above moved upward. */
  addFins(stage1, s1bot,    D.stage1_radius, 4, sk(D, 1, 'engine_length'));
  addFins(stage2, s2bot,    D.stage2_radius, 4, sk(D, 2, 'engine_length'));
  addFins(stage3, s3engBot, D.stage3_radius, 3, sk(D, 3, 'engine_length'));

  /* Removable outer cover — the opaque "finished rocket" aeroshell.
     Built from the axial milestones computed above and parented to the
     root so it spins / tilts with the vehicle. On by default; the modal
     dissolves it away to reveal the internals below. */
  const coverBuilt = buildCover(D, {
    s1Top, is12Top, s2Top, is23Top, fBot, fCylH, fNoseH,
  });

  /* Assemble root. */
  root.add(stage1);
  root.add(inter12);
  root.add(stage2);
  root.add(inter23);
  root.add(stage3);
  root.add(payload);
  root.add(fairing);
  root.add(shell);
  root.add(coverBuilt.group);

  /* ---------- equal-spacing disassemble offsets ----------
   *
   * Hand-tuned offsets gave visibly uneven gaps because the parts
   * have very different vertical extents and (for the fairing) wrap
   * around the payload geometrically. This version measures each
   * subgroup's actual bounding box and walks bottom→top, picking
   * each part's offset so every consecutive pair ends up with the
   * SAME visible gap `G` after disassembly.
   *
   *     visible_gap_i = (bbox_min_{i+1} + offset_{i+1})
   *                   - (bbox_max_i     + offset_i)        := G
   *  ⇒  offset_{i+1}  = offset_i + G - (bbox_min_{i+1} - bbox_max_i)
   *
   * For the fairing whose bbox starts BELOW the payload's top
   * (because the fairing wraps the payload in the assembled state),
   * `bbox_min - bbox_max` is negative — the formula naturally adds
   * extra distance so the fairing has to fly higher to clear the
   * payload by exactly G. The result reads as a perfectly even
   * exploded view rather than the previous tiered jump. */
  const partGroups = [stage1, inter12, stage2, inter23, stage3, payload, fairing];
  const bboxes = partGroups.map((g) => {
    const b = new THREE.Box3().setFromObject(g);
    return { minY: b.min.y, maxY: b.max.y };
  });
  /* Visible gap target. ~7% of total height looks balanced — large
     enough that each part reads as an isolated module, small enough
     that the disassembled rocket still feels like a single vehicle. */
  const G = 0.07; /* fraction of totalH */
  const totalH = fTop;
  const Gabs = G * totalH;
  const offsets = [0];
  for (let i = 1; i < partGroups.length; i++) {
    const originalGap = bboxes[i].minY - bboxes[i - 1].maxY;
    offsets.push(offsets[i - 1] + Gabs - originalGap);
  }
  const maxOffset = offsets[offsets.length - 1];

  /* Disassembled bbox midpoint, in world coords (post root shift).
     Used by setupRocketScene to slide the camera target up as the
     user disassembles, keeping the spread-out stack centered in
     frame instead of feeling bottom-heavy. */
  const disLow  = bboxes[0].minY + offsets[0];
  const disHigh = bboxes[partGroups.length - 1].maxY + offsets[partGroups.length - 1];
  const disMidLocal = (disLow + disHigh) / 2;
  const disMidWorld = disMidLocal - totalH / 2;

  /* The disassembled stack is taller than the assembled rocket by
     `maxOffset`. To keep it from spilling out of frame, the tick
     loop dollies the camera back proportionally — full disassemble
     pulls back roughly enough to compensate for the new height
     (with a small `0.85` factor so it stays cinematically tight
     rather than overly zoomed out). */
  const explodeDollyDelta = (maxOffset / totalH) * 0.85;

  /* Center the assembly vertically around y=0. */
  root.position.y = -totalH / 2;

  /* Largest radius anywhere on the vehicle — used to push the 3D
     dimension lines far enough off the body that they clear the
     widest section. Fairing geometry uses radius × 1.15, so factor
     that in. */
  const maxRadius = Math.max(
    (D.fairing_radius || 0) * 1.15,
    D.stage1_radius || 0,
    D.stage2_radius || 0,
    D.stage3_radius || 0,
    D.payload_radius || 0,
  );

  return {
    group: root,
    totalH,
    maxRadius,
    /* Removable outer cover — the group is toggled/faded by the tick
       loop via its material's `uDissolve` uniform. */
    coverGroup: coverBuilt.group,
    coverMaterials: coverBuilt.materials,
    /* Async decal baker for the cover livery — called by
       setupRocketScene with the scene's `running` guard. */
    applyCoverDecals: coverBuilt.applyDecals,
    /* Live cover colour-mode switch (white / black / darkblue / metal). */
    coverSetColorMode: coverBuilt.setColorMode,
    explodeTargets: partGroups.map((g, i) => ({ group: g, offset: offsets[i] })),
    /* Full-vehicle span for the "total length" dimension line.
       `bottom` is stage 1's base (offset 0, stays grounded);
       `topAssembled` is the fairing tip when assembled; `topOffset`
       is the fairing's explode offset, so the tick loop computes the
       live top as `topAssembled + topOffset * explodeCurrent`. */
    dimSpan: {
      bottom: bboxes[0].minY,
      topAssembled: bboxes[partGroups.length - 1].maxY,
      topOffset: offsets[partGroups.length - 1],
    },
    /* Camera target Y at full disassemble (world coords). The tick
       loop lerps from 0 (assembled center) to this value. */
    disassembledMidWorld: disMidWorld,
    /* Camera dolly factor delta — final dolly = 1 + delta when
       fully disassembled. Computed so the taller exploded stack
       fits on screen without manual zoom-out. */
    explodeDollyDelta,
    /* Bounding metadata for the modal's stats overlay. */
    meta: {
      totalHeight: totalH,
      stage1Top: s1Top,
      is12Top, s2Top, is23Top, s3Top, plTop, fTop,
    },
    /* Launch-sequence choreography data: each powered stage's group,
       its engine-exit height (root-local) and radius, so the launch
       controller can flare the right plume, hang a light at the right
       nozzle, and jettison the right parts in the right order. */
    launchParts: {
      stages: [
        { group: stage1, exitY: s1bot - sk(D, 1, 'engine_length') * 0.45, R: D.stage1_radius },
        { group: stage2, exitY: s2bot - sk(D, 2, 'engine_length') * 0.45, R: D.stage2_radius },
        { group: stage3, exitY: s3engBot - sk(D, 3, 'engine_length') * 0.45, R: D.stage3_radius },
      ],
      inter12, inter23, payload, fairing, shell,
    },
  };
}

/* ---------- space background (canvas texture) ---------- */

function buildSpaceBackground() {
  const S = 2048;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const x = c.getContext('2d');

  /* Deep-space gradient — noticeably darker than dark blue so the
     stars and planet horizon read with high contrast. */
  const bg = x.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0,   '#000003');
  bg.addColorStop(0.5, '#020207');
  bg.addColorStop(1,   '#000003');
  x.fillStyle = bg; x.fillRect(0, 0, S, S);

  /* Milky Way band — long slanted cloud across the field.
     Toned down (was 0.10 peak alpha) so it reads as a soft hint of
     galactic structure rather than a competing visual element. */
  x.save(); x.translate(S / 2, S / 2); x.rotate(-0.5);
  const mw = x.createLinearGradient(0, -S * 0.14, 0, S * 0.14);
  mw.addColorStop(0,   'rgba(0,0,0,0)');
  mw.addColorStop(0.3, 'rgba(50,40,70,0.035)');
  mw.addColorStop(0.5, 'rgba(70,60,95,0.06)');
  mw.addColorStop(0.7, 'rgba(50,40,70,0.035)');
  mw.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = mw; x.fillRect(-S, -S * 0.18, S * 2, S * 0.36); x.restore();

  /* Nebula tints — magenta and cyan blobs for cosmic flavor.
     Each one's peak is now ~half its old value: present but
     subliminal, so the rocket reads as the figure and space the
     ground rather than the other way around. */
  const nb1 = x.createRadialGradient(S * 0.72, S * 0.30, 0, S * 0.72, S * 0.30, S * 0.36);
  nb1.addColorStop(0,   'rgba(110,30,90,0.035)');
  nb1.addColorStop(0.5, 'rgba(60,20,75,0.012)');
  nb1.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = nb1; x.fillRect(0, 0, S, S);
  const nb2 = x.createRadialGradient(S * 0.18, S * 0.22, 0, S * 0.18, S * 0.22, S * 0.32);
  nb2.addColorStop(0,   'rgba(20,80,130,0.030)');
  nb2.addColorStop(0.5, 'rgba(15,50,100,0.010)');
  nb2.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = nb2; x.fillRect(0, 0, S, S);

  /* Distant sun glow at upper-right — softer now (was 0.18 core)
     so it whispers warmth into the frame rather than glaring. */
  const sg = x.createRadialGradient(S * 0.84, S * 0.13, 0, S * 0.84, S * 0.13, S * 0.20);
  sg.addColorStop(0,   'rgba(255,240,200,0.10)');
  sg.addColorStop(0.2, 'rgba(255,220,160,0.035)');
  sg.addColorStop(0.5, 'rgba(255,200,120,0.008)');
  sg.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = sg; x.fillRect(0, 0, S, S);

  /* Earth horizon glow at the bottom of the frame.
     Significantly toned down from the previous version (was 0.50
     core / 0.45 limb): we still want the "in-orbit" cue but it was
     blasting the rocket's lower stages with cyan and competing for
     attention. Now reads as a soft blue ambient at the very base
     of the frame instead of a dominant horizon. */
  const earthY = S + 700, earthR = 1100;
  const eg1 = x.createRadialGradient(S / 2, earthY, earthR * 0.65, S / 2, earthY, earthR);
  eg1.addColorStop(0,   'rgba(20,70,160,0.22)');
  eg1.addColorStop(0.4, 'rgba(30,100,200,0.11)');
  eg1.addColorStop(0.7, 'rgba(15,55,130,0.04)');
  eg1.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = eg1; x.fillRect(0, 0, S, S);
  /* Thin atmosphere line at the limb — kept narrower & dimmer so
     it reads as a delicate cyan thread, not a glowing band. */
  const eg2 = x.createRadialGradient(S / 2, earthY, earthR * 0.94, S / 2, earthY, earthR * 1.02);
  eg2.addColorStop(0,   'rgba(0,0,0,0)');
  eg2.addColorStop(0.5, 'rgba(140,200,255,0.22)');
  eg2.addColorStop(1,   'rgba(0,0,0,0)');
  x.fillStyle = eg2; x.fillRect(0, 0, S, S);

  /* Star field — 1500 stars with realistic brightness distribution
     and occasional warm/cool tints. */
  for (let i = 0; i < 1500; i++) {
    const sx = Math.random() * S, sy = Math.random() * S;
    const br = Math.random();
    const rad = br < 0.85 ? 0.5 : br < 0.95 ? 1.0 : br < 0.98 ? 1.6 : 2.4;
    const alpha = 0.22 + Math.random() * 0.65;
    const tint = br > 0.95 ? '160,190,255' : br > 0.88 ? '255,230,200' : br > 0.82 ? '255,200,180' : '255,255,255';
    x.beginPath(); x.arc(sx, sy, rad, 0, Math.PI * 2);
    x.fillStyle = `rgba(${tint},${alpha})`; x.fill();
    /* Bright stars get a soft halo. */
    if (rad > 1.2) {
      x.beginPath(); x.arc(sx, sy, rad * 2.8, 0, Math.PI * 2);
      x.fillStyle = `rgba(${tint},${alpha * 0.08})`; x.fill();
    }
  }

  return new THREE.CanvasTexture(c);
}

/* ---------- company logo + flag ----------
 *
 * The single-colour company mark (tinted for contrast) and the
 * full-colour national flag are baked into the cover's livery texture
 * by buildCover, stacked logo-over-flag on the stage-2 barrel. Both are
 * loaded lazily from webpack's import URLs so they bundle correctly in
 * dev/prod and survive subpath deploys.
 */

const DECAL_LOGO_URL = companyLogoUrl;
const DECAL_FLAG_URL = israelFlagUrl;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/* ---------- procedural launch audio (WebAudio, no assets) ----------
 *
 * Everything is synthesised: the engine rumble is looped brown noise
 * through a low-pass filter (cutoff + gain track the throttle), the
 * countdown blips are plain oscillators, and staging events fire a
 * band-passed noise burst. Created lazily inside the user's Launch
 * click so the AudioContext never hits autoplay restrictions.
 */
function createLaunchAudio() {
  let ctx = null;
  let rumbleGain = null;
  let rumbleFilter = null;
  let rumbleSrc = null;
  let muted = false;

  const ensure = () => {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    /* Brown noise buffer (2 s, looped). */
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = buf;
    rumbleSrc.loop = true;
    rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 60;
    rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleSrc.connect(rumbleFilter).connect(rumbleGain).connect(ctx.destination);
    rumbleSrc.start();
    return true;
  };

  return {
    setMuted(m) { muted = m; if (m && rumbleGain) rumbleGain.gain.value = 0; },
    isMuted() { return muted; },
    /** Engine rumble level 0..1 — gain and filter cutoff both track it. */
    setRumble(level) {
      if (!ensure() || muted) return;
      const l = Math.max(0, Math.min(1, level));
      rumbleGain.gain.setTargetAtTime(l * 0.55, ctx.currentTime, 0.08);
      rumbleFilter.frequency.setTargetAtTime(50 + l * 260, ctx.currentTime, 0.1);
    },
    /** Countdown blip; the final "zero" gets a higher, longer tone. */
    beep(final = false) {
      if (!ensure() || muted) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = final ? 1180 : 880;
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (final ? 0.5 : 0.16));
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + (final ? 0.55 : 0.2));
    },
    /** Staging thump — short band-passed noise burst. */
    burst() {
      if (!ensure() || muted) return;
      const len = ctx.sampleRate * 0.4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 180;
      f.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      src.connect(f).connect(g).connect(ctx.destination);
      src.start();
    },
    dispose() {
      try { rumbleSrc && rumbleSrc.stop(); } catch {}
      try { ctx && ctx.close(); } catch {}
      ctx = null;
    },
  };
}

/* ---------- exhaust particle system ----------
 *
 * A recycled pool of additive-blended points spawned at the active
 * engine's nozzle exit (world space — the pool is parented to the
 * scene so particles trail behind the moving rocket). Each particle
 * carries velocity + life; colour runs white-hot → orange → dark as
 * it ages via per-particle color attribute updates.
 */
function createExhaust(scene, count = 900) {
  const pos   = new Float32Array(count * 3);
  const col   = new Float32Array(count * 3);
  const vel   = new Float32Array(count * 3);
  const life  = new Float32Array(count);   // remaining life (s)
  const lifeT = new Float32Array(count);   // total life (s)
  for (let i = 0; i < count; i++) { life[i] = -1; pos[i * 3 + 1] = 1e6; }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  const mtl = new THREE.PointsMaterial({
    size: 0.16,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mtl);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let cursor = 0;
  /* Optional deck plane: particles that hit it deflect sideways —
     the classic flame-trench splash. Null = no floor (in flight). */
  let floorY = null;

  return {
    setScale(s) { mtl.size = 0.16 * s; },
    setFloor(y) { floorY = y; },
    /** Spawn `n` particles at world `origin`, biased along `dir`. */
    spawn(origin, dir, n, speed, spread) {
      points.visible = true;
      for (let k = 0; k < n; k++) {
        const i = cursor;
        cursor = (cursor + 1) % count;
        pos[i * 3]     = origin.x + (Math.random() - 0.5) * spread * 0.4;
        pos[i * 3 + 1] = origin.y + (Math.random() - 0.5) * spread * 0.4;
        pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * spread * 0.4;
        const s = speed * (0.6 + Math.random() * 0.8);
        vel[i * 3]     = dir.x * s + (Math.random() - 0.5) * spread * 3;
        vel[i * 3 + 1] = dir.y * s + (Math.random() - 0.5) * spread * 1.4;
        vel[i * 3 + 2] = dir.z * s + (Math.random() - 0.5) * spread * 3;
        lifeT[i] = life[i] = 0.5 + Math.random() * 0.9;
      }
    },
    update(dt) {
      if (!points.visible) return;
      let any = false;
      for (let i = 0; i < count; i++) {
        if (life[i] < 0) continue;
        any = true;
        life[i] -= dt;
        if (life[i] < 0) { pos[i * 3 + 1] = 1e6; continue; }
        pos[i * 3]     += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        /* Slight buoyant slowdown + turbulence. */
        vel[i * 3 + 1] *= (1 - 0.4 * dt);
        /* Deck splash: convert the impact speed into an outward
           horizontal fling along the particle's drift direction. */
        if (floorY != null && pos[i * 3 + 1] < floorY) {
          const impact = Math.abs(vel[i * 3 + 1]);
          const hx = vel[i * 3], hz = vel[i * 3 + 2];
          const hLen = Math.hypot(hx, hz) || 1;
          pos[i * 3 + 1] = floorY;
          vel[i * 3 + 1] = impact * 0.1;
          vel[i * 3]     = (hx / hLen) * impact * 0.75;
          vel[i * 3 + 2] = (hz / hLen) * impact * 0.75;
        }
        const a = life[i] / lifeT[i];   // 1 fresh → 0 dead
        if (a > 0.75) { col[i * 3] = 1.0; col[i * 3 + 1] = 0.95; col[i * 3 + 2] = 0.85; }
        else if (a > 0.4) { col[i * 3] = 1.0; col[i * 3 + 1] = 0.45 + a * 0.4; col[i * 3 + 2] = 0.12; }
        else { col[i * 3] = 0.55 * a + 0.2; col[i * 3 + 1] = 0.18 * a; col[i * 3 + 2] = 0.05 * a; }
      }
      if (!any) points.visible = false;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
    clear() {
      for (let i = 0; i < count; i++) { life[i] = -1; pos[i * 3 + 1] = 1e6; }
      geo.attributes.position.needsUpdate = true;
      points.visible = false;
    },
    dispose() { scene.remove(points); geo.dispose(); mtl.dispose(); },
  };
}

/* ---------- pad smoke (soft billow particles) ----------
 *
 * Separate from the orange exhaust: gray, normal-blended, soft round
 * sprites that rush horizontally out of the flame trench at ignition
 * and slowly rise/expand — the classic pad "steam wall". Over the
 * near-black backdrop, fading each particle's colour toward black is
 * visually identical to alpha fade but keeps the material simple.
 */
function createSmoke(scene, count = 520) {
  const pos   = new Float32Array(count * 3);
  const col   = new Float32Array(count * 3);
  const vel   = new Float32Array(count * 3);
  const life  = new Float32Array(count);
  const lifeT = new Float32Array(count);
  const bright = new Float32Array(count);
  for (let i = 0; i < count; i++) { life[i] = -1; pos[i * 3 + 1] = 1e6; }

  /* Soft radial sprite so the points read as puffs, not squares. */
  const spriteC = document.createElement('canvas');
  spriteC.width = spriteC.height = 64;
  const sx = spriteC.getContext('2d');
  const grad = sx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  sx.fillStyle = grad;
  sx.fillRect(0, 0, 64, 64);
  const sprite = new THREE.CanvasTexture(spriteC);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  const mtl = new THREE.PointsMaterial({
    size: 1,
    map: sprite,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mtl);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let cursor = 0;

  return {
    setScale(s) { mtl.size = s; },
    /** Radial ground burst centred on `origin`. */
    spawn(origin, n, speed) {
      points.visible = true;
      for (let k = 0; k < n; k++) {
        const i = cursor;
        cursor = (cursor + 1) % count;
        const a = Math.random() * Math.PI * 2;
        const sp = speed * (0.35 + Math.random() * 0.9);
        pos[i * 3]     = origin.x + Math.cos(a) * speed * 0.05;
        pos[i * 3 + 1] = origin.y + Math.random() * speed * 0.02;
        pos[i * 3 + 2] = origin.z + Math.sin(a) * speed * 0.05;
        vel[i * 3]     = Math.cos(a) * sp;
        vel[i * 3 + 1] = speed * (0.03 + Math.random() * 0.16);
        vel[i * 3 + 2] = Math.sin(a) * sp;
        lifeT[i] = life[i] = 2.2 + Math.random() * 2.4;
        bright[i] = 0.35 + Math.random() * 0.3;
      }
    },
    update(dt) {
      if (!points.visible) return;
      let any = false;
      for (let i = 0; i < count; i++) {
        if (life[i] < 0) continue;
        any = true;
        life[i] -= dt;
        if (life[i] < 0) { pos[i * 3 + 1] = 1e6; continue; }
        pos[i * 3]     += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        /* Horizontal drag so the wall of steam slows and hangs. */
        vel[i * 3]     *= (1 - 0.55 * dt);
        vel[i * 3 + 2] *= (1 - 0.55 * dt);
        const a = Math.max(life[i] / lifeT[i], 0);
        const c = bright[i] * a * a;
        col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c * 1.05;
      }
      if (!any) points.visible = false;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
    clear() {
      for (let i = 0; i < count; i++) { life[i] = -1; pos[i * 3 + 1] = 1e6; }
      geo.attributes.position.needsUpdate = true;
      points.visible = false;
    },
    dispose() { scene.remove(points); geo.dispose(); mtl.dispose(); sprite.dispose(); },
  };
}

/* ---------- launch pad ----------
 *
 * Concrete apron + flame trench, four lightning masts with blinking
 * beacons, a lattice-ish service tower, and hold-down arms that swing
 * back at liftoff. Only visible during a launch sequence, so the
 * showroom view stays a clean "vehicle in space" display.
 *
 * `padTopY` is the world height of the pad deck (rocket bell tip plus
 * a small stand-off); `R1` is stage 1's radius for sizing the arms.
 */
function buildLaunchPad(totalH, padTopY, R1) {
  const g = new THREE.Group();
  g.visible = false;

  /* Vast ground plane — reads as a night-time horizon during ascent. */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(totalH * 9, 48),
    new THREE.MeshStandardMaterial({ color: 0x05070b, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = padTopY - totalH * 0.045;
  g.add(ground);

  /* Concrete apron. */
  const apron = new THREE.Mesh(
    new THREE.CylinderGeometry(totalH * 0.46, totalH * 0.5, totalH * 0.04, 48),
    new THREE.MeshStandardMaterial({ color: 0x74777d, roughness: 0.92, metalness: 0.04 }),
  );
  apron.position.y = padTopY - totalH * 0.02;
  g.add(apron);

  /* Flame trench — dark recess under the vehicle. */
  const trench = new THREE.Mesh(
    new THREE.CylinderGeometry(R1 * 2.0, R1 * 2.0, totalH * 0.012, 32),
    new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 1 }),
  );
  trench.position.y = padTopY + 0.004;
  g.add(trench);

  /* Hazard ring painted around the trench. */
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(R1 * 2.6, R1 * 0.07, 6, 48),
    new THREE.MeshStandardMaterial({ color: 0x9a7a1d, roughness: 0.8 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = padTopY + 0.006;
  g.add(ring);

  /* Four lightning masts + blinking beacons. */
  const beacons = [];
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.55, metalness: 0.5 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const mx = Math.cos(a) * totalH * 0.38;
    const mz = Math.sin(a) * totalH * 0.38;
    const mastH = totalH * 0.66;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(totalH * 0.006, totalH * 0.01, mastH, 8),
      mastMat,
    );
    mast.position.set(mx, padTopY + mastH / 2, mz);
    g.add(mast);
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(totalH * 0.012, 8, 8), beaconMat);
    beacon.position.set(mx, padTopY + mastH + totalH * 0.012, mz);
    g.add(beacon);
    beacons.push({ mat: beaconMat, phase: i * 1.7 });
  }

  /* Service tower — column + cross-arms reaching toward the vehicle. */
  const towerA = Math.PI * 1.15;
  const tx = Math.cos(towerA) * totalH * 0.22;
  const tz = Math.sin(towerA) * totalH * 0.22;
  const towerH = totalH * 0.58;
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x565b64, roughness: 0.6, metalness: 0.45 });
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(totalH * 0.05, towerH, totalH * 0.05),
    towerMat,
  );
  tower.position.set(tx, padTopY + towerH / 2, tz);
  g.add(tower);
  for (let i = 0; i < 3; i++) {
    const armY = padTopY + towerH * (0.28 + i * 0.26);
    const armLen = totalH * 0.22 - R1 * 0.9;
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armLen, totalH * 0.014, totalH * 0.02),
      towerMat,
    );
    /* Point each cross-arm from the tower toward the pad centre. */
    arm.position.set(
      tx - Math.cos(towerA) * armLen * 0.5,
      armY,
      tz - Math.sin(towerA) * armLen * 0.5,
    );
    arm.rotation.y = -towerA;
    g.add(arm);
  }

  /* Hold-down arms — four clamps leaning on the base ring; their
     pivots rotate back/down at liftoff. Local -x points inward. */
  const armPivots = [];
  const clampMat = new THREE.MeshStandardMaterial({ color: 0x8a4a1f, roughness: 0.5, metalness: 0.55 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const rArm = R1 * 2.3;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * rArm, padTopY, Math.sin(a) * rArm);
    pivot.rotation.y = -a;
    const armLen = rArm - R1 * 0.92;
    const clamp = new THREE.Mesh(
      new THREE.BoxGeometry(armLen, R1 * 0.24, R1 * 0.3),
      clampMat,
    );
    clamp.position.set(-armLen / 2, R1 * 0.12, 0);
    pivot.add(clamp);
    g.add(pivot);
    armPivots.push(pivot);
  }

  return {
    group: g,
    /** Blink the mast beacons; `now` in ms. */
    tickBeacons(now) {
      for (const b of beacons) {
        const on = Math.sin(now * 0.004 + b.phase) > 0.35;
        b.mat.color.setRGB(on ? 1 : 0.12, on ? 0.13 : 0.02, on ? 0.13 : 0.02);
      }
    },
    /** 0 = clamped, 1 = fully swung back. */
    setArms(open) {
      for (const p of armPivots) p.rotation.z = open * 1.15;
    },
  };
}

/* ---------- ascent speed-lines ("warp streaks") ----------
 *
 * Vertical line segments in a cylinder around the rocket that rush
 * downward during the launch ascent — classic relative-motion trick:
 * the rocket holds frame while the streaks sell enormous velocity.
 * Each streak resets to the top with a new radial position when it
 * exits the bottom of the envelope.
 */
function createSpeedLines(scene, totalH, count = 140) {
  const pos = new Float32Array(count * 6);
  const seed = [];
  const RANGE = totalH * 5;
  const RAD_MIN = totalH * 0.65, RAD_MAX = totalH * 2.6;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = RAD_MIN + Math.random() * (RAD_MAX - RAD_MIN);
    seed.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: (Math.random() - 0.5) * RANGE * 2,
      len: totalH * (0.2 + Math.random() * 0.5),
      sp: 0.7 + Math.random() * 0.6,
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mtl = new THREE.LineBasicMaterial({
    color: 0xaaccff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mtl);
  lines.frustumCulled = false;
  lines.visible = false;
  scene.add(lines);

  return {
    /** `speed` in world units/s; `alpha` 0..1 overall visibility. */
    update(dt, speed, alpha) {
      mtl.opacity = alpha * 0.5;
      lines.visible = alpha > 0.01;
      if (!lines.visible) return;
      for (let i = 0; i < count; i++) {
        const s = seed[i];
        s.y -= speed * s.sp * dt;
        if (s.y < -RANGE) {
          s.y += RANGE * 2;
          const a = Math.random() * Math.PI * 2;
          const r = RAD_MIN + Math.random() * (RAD_MAX - RAD_MIN);
          s.x = Math.cos(a) * r; s.z = Math.sin(a) * r;
        }
        /* Streak length stretches with speed so faster == longer. */
        const L = s.len * (0.4 + Math.min(speed / (RANGE * 0.4), 2.2));
        pos[i * 6]     = s.x; pos[i * 6 + 1] = s.y;      pos[i * 6 + 2] = s.z;
        pos[i * 6 + 3] = s.x; pos[i * 6 + 4] = s.y + L;  pos[i * 6 + 5] = s.z;
      }
      geo.attributes.position.needsUpdate = true;
    },
    dispose() { scene.remove(lines); geo.dispose(); mtl.dispose(); },
  };
}

/* ---------- X-Ray hologram material ----------
 *
 * A fresnel-rim shader: faces viewed edge-on glow bright cyan, faces
 * viewed head-on are nearly transparent — the whole vehicle reads as
 * a volumetric engineering hologram. Additive blending means
 * overlapping internals build up brightness, which is exactly the
 * "densitogram" look X-ray imaging has.
 */
function createXRayMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor:  { value: new THREE.Color(0x36c7ff) },
      uRim:    { value: new THREE.Color(0xbdf3ff) },
      uPower:  { value: 2.1 },
    },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform vec3 uRim;
      uniform float uPower;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewW))), uPower);
        vec3 col = mix(uColor * 0.10, uRim, f);
        gl_FragColor = vec4(col, 0.045 + f * 0.85);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/* ---------- public entrypoint ----------
 *
 * Builds the scene inside `container` and starts the rAF render
 * loop. Returns a control object — call `.dispose()` when the user
 * closes the modal so we cancel rAF and free GPU resources.
 *
 * Options:
 *   `autoRotate` (default true)
 *   `pixelRatioCap` (default 1.5) — capped DPR to stay smooth on
 *                                   retina screens with bloom
 *   `cinematicIntro` (default true) — dolly-in entrance animation
 */
export function setupRocketScene(container, data, options = {}) {
  const {
    autoRotate: initialAutoRotate = true,
    pixelRatioCap = 1.5,
    cinematicIntro = true,
  } = options;

  /* `running` doubles as a "scene-still-mounted" guard. Async
     callbacks (decal image loads, etc.) check it before touching
     the scene to avoid wiring stuff into a torn-down renderer. */
  let running = true;

  const scene = new THREE.Scene();
  scene.background = buildSpaceBackground();

  /* Star particles — three concentric shells at different distances
     so dragging the camera produces parallax. */
  function addStars(count, range, size, opacity, color) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * range * 2;
      pos[i * 3 + 1] = (Math.random() - 0.5) * range * 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * range * 2;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
      color: color || 0xffffff,
      size,
      transparent: true,
      opacity,
      sizeAttenuation: true,
    })));
  }
  addStars(2500, 320, 0.045, 0.5);
  addStars(450,  280, 0.13,  0.75);
  addStars(70,   220, 0.30,  0.9);
  addStars(150,  300, 0.085, 0.55, 0xaabbff);
  addStars(80,   280, 0.085, 0.45, 0xffddaa);

  /* Build the rocket — full mechanical detail, per-stage subgroups. */
  const built = buildRocket(data);
  const rocketInner          = built.group;
  const totalH               = built.totalH;
  const coverGroup           = built.coverGroup;
  const coverMaterials       = built.coverMaterials || [];
  const coverSetColorMode    = built.coverSetColorMode;
  const explodeTargets       = built.explodeTargets;
  const stageMeta            = built.meta;
  const disassembledMidWorld = built.disassembledMidWorld;
  const explodeDollyDelta    = built.explodeDollyDelta;
  const dimMaxRadius         = built.maxRadius;
  const launchParts          = built.launchParts;

  const rocket = new THREE.Group();
  rocket.add(rocketInner);
  scene.add(rocket);

  /* Bake the company logo + national flag onto the cover's livery,
     mirrored on both sides. Loaded asynchronously — `running` doubles
     as a "still mounted?" guard so an SVG that finishes decoding after
     the user closes the modal doesn't touch a torn-down scene. */
  built.applyCoverDecals?.(() => running);

  /* The outer shell + its stiffener rings + access panels are a
     single rigid root-level group that wraps the whole vehicle.
     During disassemble it would otherwise stay put and read as
     "leftover cylinders" between separating stages. Cache every
     shell-tagged material's pristine opacity so the tick loop can
     fade them out proportionally to the disassemble progress. */
  const fadeTargets = [];
  rocketInner.traverse((o) => {
    if (!o.userData?.shellMember) return;
    if (o.material) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        m.transparent = true;
        fadeTargets.push({ mat: m, baseOpacity: m.opacity });
      }
    }
  });

  /* Lighting — warm sun key + cool fills + rim. */
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  scene.add(new THREE.HemisphereLight(0x4466aa, 0x111118, 0.32));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
  sun.position.set(8, 14, 6); scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8899cc, 0.32);
  fill.position.set(-6, 3, -8); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x99aadd, 0.30);
  rim.position.set(-2, -6, 10); scene.add(rim);
  const kick = new THREE.DirectionalLight(0xffeedd, 0.18);
  kick.position.set(3, -8, -4); scene.add(kick);

  /* Camera. 40° vertical FOV (slightly tighter than before — the
     long-lens look is more flattering for tall objects) at a
     comfortable distance so the rocket fills the frame with a touch
     of negative space top and bottom rather than clipping at the
     edges. The previous 1.0× multiplier put the camera at
     ≈0.74×totalH, which only revealed the middle ~57% of the
     vehicle through a 42° FOV — the top and bottom were being cut
     off. The new 1.7× multiplier puts the camera at ≈1.27×totalH,
     so the assembled rocket fits with a small margin and the
     disassemble dolly-out can grow into it cleanly. */
  const w = container.clientWidth || 1200;
  const h = container.clientHeight || 800;
  const cam = new THREE.PerspectiveCamera(40, w / h, 0.05, totalH * 14);
  const finalDist = totalH * 1.7;
  const finalPos = {
    x: finalDist * 0.55,
    y: totalH * 0.04,
    z: finalDist * 0.5,
  };
  /* Cinematic intro: start far + slightly to the side, fly in
     over ~2.4s. The longer duration (was 1.8s) and the side-bias
     in the start position give the dolly a sense of arc rather
     than a pure straight push, which feels more film-like.
     Otherwise just drop straight to the final position. */
  if (cinematicIntro) {
    const k = 2.6;     /* was 4.2 — at the new larger finalDist, 2.6 still
                          reads as a dramatic far-to-near push but keeps
                          the rocket visibly recognisable from frame one
                          rather than being a pinprick on the horizon. */
    const sideBias = 1.18;
    cam.position.set(
      finalPos.x * k * sideBias,
      finalPos.y * k - totalH * 0.05,
      finalPos.z * k,
    );
  } else {
    cam.position.set(finalPos.x, finalPos.y, finalPos.z);
  }
  /* Look-at point is in the rocket's horizontal-default world
     frame — same `(totalH * 0.02, 0, 0)` long-axis bias that
     `ctrl.target` starts at, so the intro's manual lookAt and the
     orbit controls' target match exactly when the intro hands off. */
  cam.lookAt(totalH * 0.02, 0, 0);

  /* Renderer — ACES tone mapping, capped DPR. */
  const ren = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  ren.setSize(w, h);
  ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  ren.toneMapping = THREE.ACESFilmicToneMapping;
  ren.toneMappingExposure = 1.0;
  ren.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(ren.domElement);

  /* Component-tooltip overlay.
   *
   * A dedicated DOM div sits over the canvas. A raycaster runs on
   * mousemove against `rocketInner` and walks up the parent chain
   * to find a mesh tagged with `userData.tooltipInfo`. When one
   * stays hovered for `TOOLTIP_HOVER_DELAY_MS`, the tooltip fades
   * in next to the cursor with the component's title + parameters.
   *
   * Why an HTML overlay (not a Three.js Sprite or HUD): native HTML
   * gets crisp text rendering, system fonts, accessibility, and
   * trivially follows the cursor without per-frame projection math.
   *
   * Pointer-events: none on the bubble itself so it never steals
   * raycasts from the canvas underneath when it's positioned over
   * a component.
   */
  const TOOLTIP_HOVER_DELAY_MS = 1000;
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'RVM-3d-tooltip';
  tooltipEl.setAttribute('role', 'tooltip');
  tooltipEl.style.opacity = '0';
  /* Container needs `position: relative` for the absolutely-
     positioned tooltip to anchor against. Set defensively here
     instead of relying on the modal's CSS, so the tooltip works
     even if this scene is mounted into a plain div. */
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(tooltipEl);

  const raycaster = new THREE.Raycaster();
  const ndcMouse  = new THREE.Vector2();
  let hoveredInfo  = null;
  /* `shownInfo` is the info object whose tooltip is *currently
     visible* (after the hover delay has elapsed). The 3D dimension
     lines key off this — they appear with the tooltip and vanish
     with it. `hoveredInfo` by contrast updates the instant the
     cursor crosses a component, before the delay. */
  let shownInfo    = null;
  let hoverTimer   = null;
  /* Cache the cursor's last canvas-relative position so timer-fires
     can position the bubble even if the mouse is held still after
     the timer started. */
  let lastClientX = 0;
  let lastClientY = 0;

  const renderTooltipHtml = (info) => {
    const safe = (s) => String(s).replace(/[<>&]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const items = (info.items || []).map((it) =>
      `<div class="RVM-3d-tt-row">
         <span class="RVM-3d-tt-key">${safe(it.label)}</span>
         <span class="RVM-3d-tt-val">${safe(it.value)}</span>
       </div>`,
    ).join('');
    return (
      `<div class="RVM-3d-tt-title">${safe(info.title)}</div>` +
      (items ? `<div class="RVM-3d-tt-rows">${items}</div>` : '')
    );
  };

  const positionTooltip = () => {
    const rect = ren.domElement.getBoundingClientRect();
    const cw = rect.width;
    const ch = rect.height;
    const localX = lastClientX - rect.left;
    const localY = lastClientY - rect.top;
    const bubbleW = tooltipEl.offsetWidth || 220;
    const bubbleH = tooltipEl.offsetHeight || 80;
    /* Offset 28 px from the cursor (was 16) — a little farther so
       the cursor area, the dimension-line ticks, and the tooltip
       card don't crowd each other. Flips to the other side if it
       would clip the canvas edge. */
    let x = localX + 28;
    let y = localY + 28;
    if (x + bubbleW > cw - 8) x = localX - bubbleW - 28;
    if (y + bubbleH > ch - 8) y = localY - bubbleH - 28;
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top  = `${y}px`;
  };

  const hideTooltip = () => {
    hoveredInfo = null;
    shownInfo = null;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    tooltipEl.style.opacity = '0';
  };

  /* When the rocket is fully assembled (explodeCurrent ≈ 0), the
     parts visually overlap — hovering one stage's hull would tend
     to land on whichever mesh is in front, which the user reads as
     arbitrary / glitchy. The tooltips are only meaningful once the
     stages have spread apart enough to be individually selectable.
     Threshold sits at 0.15 so the ramp-up looks deliberate: the
     tooltip system "comes online" as the disassemble progresses. */
  const TOOLTIP_EXPLODE_THRESHOLD = 0.15;

  const onMouseMove = (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;

    /* Suppress tooltips while the rocket is assembled. Mid-explode
       (parts moving apart) we already have a useful hit-target so
       allow the tooltips through. Re-assembling reverses the ramp. */
    if (explodeCurrent < TOOLTIP_EXPLODE_THRESHOLD) {
      hideTooltip();
      return;
    }

    const rect = ren.domElement.getBoundingClientRect();
    ndcMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndcMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(ndcMouse, cam);
    const hits = raycaster.intersectObject(rocketInner, true);

    /* Find the topmost hit whose mesh (or any ancestor) carries a
       tooltipInfo payload. Skip anything that isn't currently
       visible — the shell / fade-out logic sets `material.opacity`
       on disassemble, but `mesh.visible` stays true; we still want
       skipped because their meshes may obscure the parts behind. */
    let info = null;
    for (const hit of hits) {
      let obj = hit.object;
      while (obj && !obj.userData?.tooltipInfo) obj = obj.parent;
      if (obj?.userData?.tooltipInfo) {
        info = obj.userData.tooltipInfo;
        break;
      }
    }

    if (info !== hoveredInfo) {
      hoveredInfo = info;
      tooltipEl.style.opacity = '0';
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      shownInfo = null;
      if (info && introDone) {
        hoverTimer = setTimeout(() => {
          tooltipEl.innerHTML = renderTooltipHtml(info);
          /* Position AFTER innerHTML so offsetWidth/Height reflect
             the new content; otherwise the first paint can land
             slightly off the cursor. */
          positionTooltip();
          tooltipEl.style.opacity = '1';
          /* Now that the tooltip is actually visible, light up the
             3D dimension lines for this component (+ the total). */
          shownInfo = info;
        }, TOOLTIP_HOVER_DELAY_MS);
      }
    } else if (info && tooltipEl.style.opacity === '1') {
      /* Already showing — track the cursor so the bubble drifts
         along with the user's pointer instead of locking in place. */
      positionTooltip();
    }
  };

  ren.domElement.addEventListener('mousemove', onMouseMove);
  ren.domElement.addEventListener('mouseleave', hideTooltip);

  /* ── 3D dimension line ────────────────────────────────────────
   *
   * A single component dimension line, rendered in WORLD space
   * (child of the scene, NOT the spinning rocket) and recomputed
   * every frame: it spans the hovered component's axial extent.
   *
   * Why world-space + per-frame recompute rather than parenting to
   * the rocket: if the line were a child of the spinning rocket
   * it'd orbit out of view. Instead each frame we:
   *   1. find the component's two endpoints ON the long axis, in
   *      world coords (same tilt math the camera-target uses), and
   *   2. offset them perpendicular to the long axis, toward
   *      screen-UP — so the line floats *above* the rocket body on
   *      screen, clear of the cursor / tooltip (which sit down-right
   *      of the pointer). It stays parallel to the component and
   *      faces the camera regardless of spin/tilt/explode.
   * `depthTest:false` + high renderOrder keeps it readable even
   * when a component is behind other geometry.
   *
   * The rocket's self-spin is paused while a tooltip is up (see the
   * tick loop) so the measurement isn't sliding under a static line.
   */
  const DIM_UP = new THREE.Vector3(0, 1, 0);
  const dimRad  = Math.max(totalH * 0.0022, 0.004);
  const dimTick = Math.max(dimMaxRadius * 0.45, totalH * 0.012);
  const dimOff  = dimMaxRadius * 1.7 + totalH * 0.02;

  function makeDimLine(color) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0,
      depthTest: false, toneMapped: false,
    });
    const mk = () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat);
      m.renderOrder = 999;
      m.visible = false;
      scene.add(m);
      return m;
    };
    return { mat, shaft: mk(), t1: mk(), t2: mk() };
  }
  const compLine = makeDimLine(0x6fc2ee);   // accent blue

  const mkDimLabel = () => {
    const el = document.createElement('div');
    el.className = 'RVM-3d-dim-label';
    el.style.opacity = '0';
    container.appendChild(el);
    return el;
  };
  const compLabel = mkDimLabel();

  let dimOpacity = 0;

  /* Scratch vectors — reused each frame to avoid per-frame allocs. */
  const _A = new THREE.Vector3();
  const _B = new THREE.Vector3();
  const _mid = new THREE.Vector3();
  const _long = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _sideN = new THREE.Vector3();
  const _proj = new THREE.Vector3();

  /* Long-axis point at root-local height `s`, in world coords.
     Mirrors the camera-target math: a point on the axis maps to
     ( -(s - totalH/2)·sinθ, (s - totalH/2)·cosθ, 0 ), θ = tilt. */
  const axisPointWorld = (s, out) => {
    const hh = s - totalH / 2;
    return out.set(-hh * Math.sin(tiltCurrent), hh * Math.cos(tiltCurrent), 0);
  };

  /* Place the dimension line spanning root-local [yBot, yTop],
     floated toward screen-up so it sits above the rocket body.
     Returns the world-space midpoint + length for the HTML label,
     or null when hidden. */
  const placeDimLine = (line, yBot, yTop, opacity) => {
    if (opacity < 0.01 || yTop - yBot < 1e-5) {
      line.shaft.visible = line.t1.visible = line.t2.visible = false;
      return null;
    }
    axisPointWorld(yBot, _A);
    axisPointWorld(yTop, _B);
    _mid.copy(_A).add(_B).multiplyScalar(0.5);
    _long.copy(_B).sub(_A);
    const len = _long.length();
    _long.normalize();

    /* Offset direction = the camera's screen-up axis, projected to
       be perpendicular to the long axis. This lifts the line above
       the rocket on screen (away from the cursor/tooltip) while
       keeping it parallel to the component. Camera world-up is
       column 1 of its world matrix. Degenerate (long axis ≈ screen
       up) → fall back to world +X. */
    const e = cam.matrixWorld.elements;
    _camUp.set(e[4], e[5], e[6]).normalize();
    _side.copy(_camUp).addScaledVector(_long, -_camUp.dot(_long));
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();
    _sideN.copy(_side);
    _side.multiplyScalar(dimOff);

    _A.add(_side); _B.add(_side); _mid.add(_side);

    line.shaft.visible = line.t1.visible = line.t2.visible = true;
    line.shaft.position.copy(_mid);
    line.shaft.quaternion.setFromUnitVectors(DIM_UP, _long);
    line.shaft.scale.set(dimRad, len, dimRad);

    line.t1.position.copy(_A);
    line.t1.quaternion.setFromUnitVectors(DIM_UP, _sideN);
    line.t1.scale.set(dimRad, dimTick, dimRad);
    line.t2.position.copy(_B);
    line.t2.quaternion.setFromUnitVectors(DIM_UP, _sideN);
    line.t2.scale.set(dimRad, dimTick, dimRad);

    line.mat.opacity = opacity;
    return { x: _mid.x, y: _mid.y, z: _mid.z, len };
  };

  const placeDimLabel = (el, mid, opacity) => {
    if (!mid || opacity < 0.01) { el.style.opacity = '0'; return; }
    _proj.set(mid.x, mid.y, mid.z).project(cam);
    if (_proj.z > 1) { el.style.opacity = '0'; return; }
    const rect = ren.domElement.getBoundingClientRect();
    el.style.left = `${(_proj.x * 0.5 + 0.5) * rect.width}px`;
    el.style.top  = `${(-_proj.y * 0.5 + 0.5) * rect.height}px`;
    el.textContent = `${mid.len.toFixed(2)} m`;
    el.style.opacity = `${opacity}`;
  };

  /* Called once per frame from the tick loop. */
  const updateDimLines = () => {
    /* Only show the line for components that have an axial bound
       (spheres pass null). It rides the part's live explode offset
       so it travels with the stage during disassemble. */
    const showComp = !!(shownInfo && shownInfo.bounds);
    const dimTarget = showComp ? 1 : 0;
    dimOpacity += (dimTarget - dimOpacity) * 0.15;

    if (dimOpacity < 0.01 || !showComp) {
      placeDimLine(compLine, 0, 0, 0);
      placeDimLabel(compLabel, null, 0);
      return;
    }

    const off = shownInfo.subgroup ? shownInfo.subgroup.position.y : 0;
    placeDimLabel(
      compLabel,
      placeDimLine(compLine, shownInfo.bounds.yBot + off, shownInfo.bounds.yTop + off, dimOpacity),
      dimOpacity,
    );
  };

  /* PMREM-baked environment — soft studio-style reflections so
     metallic surfaces don't read flat. Higher sigma blurs the env
     map more, which makes reflections diffuse and less mirror-y
     (i.e. less "shiny"). Combined with the lowered envMapIntensity
     in `mat()`, surfaces now read as matte engineering finishes
     rather than chrome plating. */
  const pmrem = new THREE.PMREMGenerator(ren);
  pmrem.compileEquirectangularShader();
  const envScene = new RoomEnvironment(ren);
  const envTex = pmrem.fromScene(envScene, 0.12).texture;
  scene.environment = envTex;
  pmrem.dispose();

  /* Post-processing: a *light* bloom pass — strong enough that the
     engine glow ring + exhaust plume halo, but not so strong that
     every metallic highlight glows. Threshold is high (0.92) so
     only the explicitly-emissive engine layers cross it. */
  const composer = new EffectComposer(ren);
  composer.setSize(w, h);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    0.40,   // strength    (was 0.85)
    0.35,   // radius      (was 0.55)
    0.92,   // threshold   (was 0.78 — only the brightest pixels bloom)
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* Controls — orbit + damping. The orbital auto-rotate (camera
     flying around the rocket) is intentionally OFF: we replaced it
     with a self-rotation of the rocket around its own long axis,
     which is more cinematic for a horizontal "vehicle on display"
     framing. `dampingFactor` softer than default so user-initiated
     drags coast more smoothly to a stop. `maxDistance` grows to
     4× to leave headroom for the disassemble dolly and any manual
     zoom-out the user wants. */
  const ctrl = new OrbitControls(cam, ren.domElement);
  ctrl.enableDamping = true; ctrl.dampingFactor = 0.045;
  ctrl.autoRotate = false;
  ctrl.minDistance = totalH * 0.10;
  ctrl.maxDistance = totalH * 4;
  /* Initial target in the rocket's horizontal-default world frame.
     The tick loop projects `focusTarget` onto the rocket's current
     long-axis direction; we mirror that math here so the very
     first frame already has the target in the right place and
     the lerp doesn't do a visible "slide-into-position" on frame
     two. The tiny `0.02 * totalH` bias is the same cinematic
     "look slightly along the body" offset used for vertical mode,
     just rotated into the horizontal frame. */
  ctrl.target.set(totalH * 0.02, 0, 0);

  /* User interaction pauses the rocket's self-spin so the user can
     inspect a side without it sliding past — auto-resumes 4 s after
     they release. Same UX semantics as the previous orbital
     auto-rotate, just driving the rocket's own rotation now. */
  let resumeTimer = null;
  const onPointerDown = () => {
    spinEnabled = false;
    if (resumeTimer) clearTimeout(resumeTimer);
  };
  const onPointerUp = () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { spinEnabled = true; }, 4000);
  };
  ren.domElement.addEventListener('pointerdown', onPointerDown);
  ren.domElement.addEventListener('pointerup',   onPointerUp);

  /* Tilt + focus state.
     Default orientation is horizontal (tiltTarget = -π/2 around Z),
     because lying horizontally reads as "vehicle on display"
     immediately — non-engineers recognise it as a rocket faster
     than they parse a tall vertical silhouette through perspective.
     `tiltCurrent` starts equal to `tiltTarget` so there's no
     animated tip-over on first paint; we land already horizontal. */
  let tiltTarget = -Math.PI / 2;
  let tiltCurrent = -Math.PI / 2;
  const focusMin = -totalH / 2;
  const focusMax =  totalH / 2;
  /* `focusTarget` is the user's slider position interpreted as an
     offset along the rocket's *long axis* (orientation-independent).
     The tick projects it onto whichever world direction the long
     axis currently points. Initialised to the same `0.02 × totalH`
     "slightly along the body" cinematic bias used elsewhere — set
     explicitly rather than read from ctrl.target.y, since
     ctrl.target now starts in horizontal coordinates where Y = 0. */
  let focusTarget = totalH * 0.02;

  /* Long-axis self-rotation ("rotisserie") state.
     Replaces the OrbitControls auto-rotate (which flew the camera
     around the rocket). Spinning the rocket itself feels like a
     showroom display: the camera holds its frame while the model
     turns to reveal every side. The angular velocity is moderate
     — about one revolution every 60 seconds — so the eye can
     actually track surface detail rather than getting motion-sick.

     `spinEnabled` is gated until the cinematic intro lands, then
     follows the autoRotate toggle. `spinCurrent` is the smoothly-
     ramped angular velocity (rad/s) so toggling on/off feels like
     coasting rather than snapping. We rotate `rocketInner` (a
     child of `rocket`) around its own local Y axis — that axis is
     the rocket's long axis regardless of `rocket.rotation.z` tilt,
     so the spin works correctly in any orientation. */
  const SPIN_RATE_RAD_PER_SEC = 0.105;   // ≈ 60 s per full rotation
  let spinEnabled = false;               /* enabled at end of intro */
  let spinCurrent = 0;                   /* lerped current rate */

  /* Explode mode. `progress` lerps 0 → 1 toward the per-stage
     offsets stored on `explodeTargets`. `lastDolly` tracks the
     current camera dolly multiplier from the explode pull-back so
     the per-frame scale is incremental — preserves the user's
     manual zoom rather than overriding it. */
  let explodeTarget = 0;
  let explodeCurrent = 0;
  let lastDolly = 1;

  /* Outer-cover dissolve. `coverTarget` 0 = cover fully present
     (finished rocket), 1 = fully dissolved (internals revealed).
     `coverCurrent` chases it with a slow lerp so the noise erosion +
     glowing edge reads as a deliberate reveal. Starts at 0 → the
     vehicle opens covered. `pendingCover` defers re-forming the shell
     until a disassembled rocket has finished reassembling, so the cover
     never wraps a spread-out stack. */
  let coverTarget = 0;
  let coverCurrent = 0;
  let pendingCover = false;

  /* Is the cover currently on (or on its way on)? */
  const coverIsOn = () => coverTarget < 0.5 || pendingCover;

  /* Drive the cover on/off. Turning it ON always reassembles first;
     if the rocket is still visibly exploded, the shell is deferred
     (via `pendingCover`) until the tick sees it closed. */
  const applyCover = (on) => {
    if (on) {
      explodeTarget = 0;
      if (explodeCurrent > 0.06) {
        pendingCover = true;
        coverTarget = 1;
      } else {
        pendingCover = false;
        coverTarget = 0;
      }
    } else {
      pendingCover = false;
      coverTarget = 1;
    }
  };

  /* Manual pan offset (world space). The tick loop normally drives
     `ctrl.target` from the focus slider + explode shift; if pan just
     wrote to `ctrl.target` directly, that lerp would yank it back
     within a few frames. Instead pan accumulates here and the tick
     adds it on top of the computed target, so a panned view sticks. */
  const panOffset = new THREE.Vector3(0, 0, 0);

  /* Cinematic intro animation. We track the start time and lerp
     the camera from its initial faraway position to `finalPos`
     using a smoothstep curve. */
  const introStart = performance.now();
  const introDuration = 2400;
  const introStartPos = cam.position.clone();
  let introDone = !cinematicIntro;
  if (introDone) spinEnabled = initialAutoRotate;

  /* ════════════════════════════════════════════════════════════════
   *  LAUNCH SEQUENCE
   *
   *  A self-contained timeline that takes over the camera and drives
   *  a full mission profile: countdown → ignition (plume flare,
   *  exhaust particles, engine light, screen shake, WebAudio rumble)
   *  → liftoff with a chase camera → skin burn-away → stage 1 & 2
   *  separations tumbling away → fairing jettison → SECO → payload
   *  deploy. Progress is reported to the modal through an event
   *  callback so the HUD (countdown digits, callouts, telemetry) is
   *  plain DOM/React on top of the canvas.
   * ════════════════════════════════════════════════════════════════ */

  const audio = createLaunchAudio();
  const exhaust = createExhaust(scene);
  exhaust.setScale(totalH * 0.10);
  const speedLines = createSpeedLines(scene, totalH);
  const smoke = createSmoke(scene);
  smoke.setScale(totalH * 0.16);

  /* Launch pad — deck sits just under stage 1's bell tip. Visible
     only while a launch runs so the showroom stays a clean display. */
  const padTopY = -totalH / 2 + launchParts.stages[0].exitY - totalH * 0.015;
  const pad = buildLaunchPad(totalH, padTopY, launchParts.stages[0].R);
  scene.add(pad.group);
  const padCenter = new THREE.Vector3(0, padTopY + totalH * 0.012, 0);

  const engineLight = new THREE.PointLight(0xff7733, 0, totalH * 3.2, 2);
  engineLight.visible = false;
  scene.add(engineLight);

  /* Collect each powered stage's plume meshes (tagged in addNozzle)
     with their rest-state transforms so flares are fully reversible. */
  const stagePlumes = launchParts.stages.map(({ group }) => {
    const list = [];
    group.traverse((o) => {
      if (!o.userData?.plume) return;
      list.push({
        mesh: o,
        kind: o.userData.plume,
        baseY: o.position.y,
        baseOpacity: o.material.opacity ?? 1,
        h: o.geometry?.parameters?.height || 1,
      });
    });
    return list;
  });

  /* Mach diamonds — three flickering shock cells hanging in each
     stage's plume, visible only while that stage burns. Parented to
     the stage group so they travel (and jettison) with it. */
  const stageDiamonds = launchParts.stages.map((st, i) => {
    const inner = stagePlumes[i].find((p) => p.kind === 'inner');
    const engLen = inner ? inner.h * 4 : st.R * 2;
    const list = [];
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(Math.max(st.R * (0.17 - k * 0.04), st.R * 0.05), 0),
        new THREE.MeshBasicMaterial({
          color: 0xffe2b8, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      m.scale.y = 2.3;
      m.position.y = st.exitY - engLen * (0.6 + k * 0.55);
      m.visible = false;
      st.group.add(m);
      list.push(m);
    }
    return list;
  });

  /* Flare a stage's exhaust: stretch the plume cones downward, crank
     their opacity, swell the glow ring, and flicker the mach
     diamonds. k = 0 rest → 1 full burn. */
  const applyFlare = (stageIdx, k) => {
    for (const p of stagePlumes[stageIdx]) {
      if (p.kind === 'ring') {
        const s = 1 + k * 0.6;
        p.mesh.scale.set(s, s, s);
      } else {
        const sy = 1 + k * (p.kind === 'inner' ? 7 : 9);
        p.mesh.scale.set(1 + k * 0.5, sy, 1 + k * 0.5);
        p.mesh.position.y = p.baseY - ((sy - 1) * p.h) / 2;
        p.mesh.material.opacity = p.baseOpacity + k * (p.kind === 'inner' ? 0.6 : 0.2);
      }
    }
    const diamonds = stageDiamonds[stageIdx];
    for (let d = 0; d < diamonds.length; d++) {
      const m = diamonds[d];
      m.visible = k > 0.12;
      if (m.visible) {
        m.material.opacity = k * (0.7 - d * 0.16) * (0.8 + Math.random() * 0.25);
      }
    }
  };

  /* Jettisoned parts get wrapped in a pivot at their own centre so
     they can tumble around themselves while falling away. Restored
     (reparented + transforms zeroed) by endLaunch behind the fade. */
  const jettisoned = [];
  const _jc = new THREE.Vector3();
  const jettison = (group, kick = 1) => {
    const box = new THREE.Box3().setFromObject(group);
    box.getCenter(_jc);
    rocketInner.worldToLocal(_jc);
    const pivot = new THREE.Group();
    pivot.position.copy(_jc);
    rocketInner.add(pivot);
    pivot.attach(group);
    jettisoned.push({
      pivot,
      group,
      vy: -totalH * (0.18 + Math.random() * 0.1) * kick,
      vx: (Math.random() - 0.5) * totalH * 0.14 * kick,
      vz: (Math.random() - 0.5) * totalH * 0.14 * kick,
      wx: (Math.random() - 0.5) * 1.1,
      wz: (Math.random() - 0.5) * 1.4,
    });
  };

  /* Launch state. `launch.t` is seconds since the Launch click. */
  const launch = {
    active: false,
    t: 0,
    countdownShown: null,
    fired: new Set(),
    cb: null,
    flareTargets: [0, 0, 0],
    flareCurrent: [0, 0, 0],
    activeStage: -1,
    shakeTarget: 0,
    shakeCurrent: 0,
    vVis: 0,
    sceneY: 0,
    camAng: 0.9,
    camPos: new THREE.Vector3(),
    camLook: new THREE.Vector3(),
    /* When set, the next camera frame snaps instead of lerping —
       used for webcast-style "camera cuts" at staging events. */
    cutPending: false,
    /* Fake-but-plausible telemetry integrators. */
    vel: 0,
    alt: 0,
    accel: 0,
    throttle: 0,
    telemetryClock: 0,
  };

  const emitLaunch = (evt) => { try { launch.cb && launch.cb(evt); } catch {} };

  const LIFTOFF_T = 6.4;

  /* Fire `fn` once when the timeline crosses `at`. */
  const onceAt = (at, key, fn) => {
    if (launch.t >= at && !launch.fired.has(key)) {
      launch.fired.add(key);
      fn();
    }
  };

  const startLaunch = (cb) => {
    if (launch.active || tour.active) return false;
    if (xray.on) setXRay(false);
    launch.active = true;
    launch.t = 0;
    launch.countdownShown = null;
    launch.fired = new Set();
    launch.cb = cb || null;
    launch.flareTargets = [0, 0, 0];
    launch.flareCurrent = [0, 0, 0];
    launch.activeStage = 0;
    launch.shakeTarget = 0;
    launch.shakeCurrent = 0;
    launch.vVis = 0;
    launch.sceneY = 0;
    launch.vel = 0; launch.alt = 0; launch.accel = 0; launch.throttle = 0;
    launch.camPos.copy(cam.position);
    launch.camLook.copy(ctrl.target);
    launch.camAng = Math.atan2(cam.position.z, cam.position.x);

    launch.cutPending = false;

    introDone = true;   /* launching mid-intro must not resume the intro after */
    hideTooltip();
    ctrl.enabled = false;
    spinEnabled = false;
    tiltTarget = 0;               /* upright on the pad */
    explodeTarget = 0;
    applyCover(true);             /* launch the finished vehicle */
    pad.group.visible = true;
    pad.setArms(0);
    exhaust.setFloor(padTopY + totalH * 0.006);
    audio.setRumble(0);
    emitLaunch({ type: 'start' });
    return true;
  };

  /** Restore every launch-touched system. Safe to call at any time —
   *  the modal invokes it behind a fade so the snap is invisible. */
  const endLaunch = () => {
    if (!launch.active) return;
    launch.active = false;
    for (const j of jettisoned) {
      rocketInner.attach(j.group);
      j.group.position.set(0, 0, 0);
      j.group.rotation.set(0, 0, 0);
      rocketInner.remove(j.pivot);
    }
    jettisoned.length = 0;
    for (let i = 0; i < 3; i++) applyFlare(i, 0);
    exhaust.clear();
    exhaust.setFloor(null);
    smoke.clear();
    speedLines.update(0, 0, 0);
    pad.group.visible = false;
    pad.setArms(0);
    engineLight.visible = false;
    engineLight.intensity = 0;
    audio.setRumble(0);
    rocket.position.set(0, 0, 0);
    rocketInner.rotation.y = 0;
    doResetView();
  };

  const _exitWorld = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _shk = new THREE.Vector3();

  const launchTick = (dt) => {
    launch.t += dt;
    const t = launch.t;

    /* ── countdown 5…1 ── */
    if (t < 5) {
      const n = 5 - Math.floor(t);
      if (n !== launch.countdownShown) {
        launch.countdownShown = n;
        audio.beep(false);
        emitLaunch({ type: 'countdown', n });
      }
    }

    /* Random webcast-style camera cut. */
    const cutCamera = () => {
      launch.camAng += (Math.random() > 0.5 ? 1 : -1) * (1.1 + Math.random() * 1.2);
      launch.cutPending = true;
    };

    onceAt(3.4, 'rumble-pre', () => { launch.shakeTarget = 0.15; });
    onceAt(5, 'ignition', () => {
      audio.beep(true);
      emitLaunch({ type: 'countdown', n: 0 });
      emitLaunch({ type: 'callout', label: 'IGNITION', sub: 'Main engine start' });
      emitLaunch({ type: 'flash' });
      launch.flareTargets[0] = 1;
      launch.shakeTarget = 0.8;
      engineLight.visible = true;
    });
    onceAt(LIFTOFF_T, 'liftoff', () => {
      emitLaunch({ type: 'callout', label: 'LIFTOFF', sub: 'Vehicle has cleared the tower' });
      launch.shakeTarget = 1.0;
    });
    onceAt(12.5, 'maxq', () => {
      emitLaunch({ type: 'callout', label: 'MAX-Q', sub: 'Peak aerodynamic pressure' });
      launch.shakeTarget = 0.9;
    });
    onceAt(13.5, 'skin', () => { coverTarget = 1; pendingCover = false; });
    onceAt(14.5, 'shake-down', () => { launch.shakeTarget = 0.4; });
    onceAt(16, 'meco', () => {
      emitLaunch({ type: 'callout', label: 'MECO', sub: 'Stage 1 separation confirmed' });
      launch.flareTargets[0] = 0;
      jettison(launchParts.stages[0].group, 1.15);
      jettison(launchParts.inter12, 0.9);
      launch.activeStage = -1;
      audio.burst();
      launch.shakeTarget = 0.5;
      cutCamera();
    });
    onceAt(16.8, 's2-ign', () => {
      emitLaunch({ type: 'callout', label: 'STAGE 2 IGNITION', sub: 'Vacuum engine burn' });
      launch.flareTargets[1] = 1;
      launch.activeStage = 1;
      launch.shakeTarget = 0.35;
    });
    onceAt(21.5, 's2-sep', () => {
      emitLaunch({ type: 'callout', label: 'STAGE 2 SEPARATION', sub: 'Second stage away' });
      launch.flareTargets[1] = 0;
      jettison(launchParts.stages[1].group, 1);
      jettison(launchParts.inter23, 0.85);
      launch.activeStage = -1;
      audio.burst();
      cutCamera();
    });
    onceAt(22.3, 's3-ign', () => {
      emitLaunch({ type: 'callout', label: 'STAGE 3 IGNITION', sub: 'Kick stage burn' });
      launch.flareTargets[2] = 1;
      launch.activeStage = 2;
      launch.shakeTarget = 0.25;
    });
    onceAt(24.5, 'fairing', () => {
      emitLaunch({ type: 'callout', label: 'FAIRING JETTISON', sub: 'Payload exposed' });
      jettison(launchParts.fairing, 0.7);
      audio.burst();
      cutCamera();
    });
    onceAt(29, 'seco', () => {
      emitLaunch({ type: 'callout', label: 'SECO', sub: 'Orbital velocity achieved' });
      launch.flareTargets[2] = 0;
      launch.activeStage = -1;
      launch.shakeTarget = 0;
    });
    onceAt(31, 'deploy', () => {
      emitLaunch({ type: 'callout', label: 'PAYLOAD DEPLOYED', sub: 'Mission nominal — congratulations' });
      /* Spent kick stage drifts away so the payload floats alone. */
      jettison(launchParts.stages[2].group, 0.35);
      audio.burst();
    });
    onceAt(34.5, 'done', () => { emitLaunch({ type: 'done' }); });

    /* ── flare lerps + exhaust + light ── */
    let flareMax = 0;
    for (let i = 0; i < 3; i++) {
      launch.flareCurrent[i] += (launch.flareTargets[i] - launch.flareCurrent[i]) * (launch.flareTargets[i] > launch.flareCurrent[i] ? 0.14 : 0.1);
      applyFlare(i, launch.flareCurrent[i]);
      flareMax = Math.max(flareMax, launch.flareCurrent[i]);
    }
    const act = launch.activeStage;
    if (act >= 0 && launch.flareCurrent[act] > 0.05) {
      const st = launchParts.stages[act];
      _exitWorld.set(0, st.exitY + st.group.position.y, 0);
      rocketInner.localToWorld(_exitWorld);
      engineLight.position.copy(_exitWorld);
      engineLight.intensity = launch.flareCurrent[act] * totalH * 7;
      engineLight.visible = true;
      const n = Math.round(140 * dt * launch.flareCurrent[act] * (act === 0 ? 1 : 0.55));
      exhaust.spawn(_exitWorld, _down, n, totalH * 0.9, st.R * 1.1);
    } else {
      engineLight.intensity *= (1 - 3 * dt);
      if (engineLight.intensity < 0.01) engineLight.visible = false;
    }
    exhaust.update(dt);
    audio.setRumble(flareMax * 0.85 + launch.shakeCurrent * 0.15);

    /* ── pad life: blinking beacons, hold-down arms swinging back at
          liftoff, and the wall of trench smoke during first burn ── */
    pad.tickBeacons(performance.now());
    const armOpen = Math.max(0, Math.min(1, (t - (LIFTOFF_T - 0.3)) / 0.9));
    pad.setArms(armOpen * armOpen * (3 - 2 * armOpen));   /* smoothstep */
    if (t >= 5 && t < 11.5 && launch.flareCurrent[0] > 0.1) {
      smoke.spawn(padCenter, Math.round(110 * dt * launch.flareCurrent[0]) + 1, totalH * 0.5);
    }
    smoke.update(dt);

    /* ── visual ascent (rocket climbs, then holds while speed lines
          carry the sense of velocity) ── */
    if (t > LIFTOFF_T) {
      const ta = t - LIFTOFF_T;
      const ramp = Math.min(1, ta / 3);
      launch.vVis = Math.min(launch.vVis + totalH * 0.10 * ramp * ramp * dt, totalH * 0.5);
      launch.sceneY = Math.min(launch.sceneY + launch.vVis * dt, totalH * 1.25);
      rocket.position.y = launch.sceneY;

      const slAlpha = Math.max(0, Math.min(1, (ta - 3.5) / 3.5)) * (t > 30 ? Math.max(0, 1 - (t - 30) / 3) : 1);
      speedLines.update(dt, launch.vVis * 2.4, slAlpha);
    }

    /* ── jettisoned parts fall + tumble away ── */
    for (const j of jettisoned) {
      j.vy -= totalH * 0.16 * dt;
      j.pivot.position.y += j.vy * dt;
      j.pivot.position.x += j.vx * dt;
      j.pivot.position.z += j.vz * dt;
      j.pivot.rotation.x += j.wx * dt;
      j.pivot.rotation.z += j.wz * dt;
    }

    /* ── telemetry (plausible numbers, ~10 Hz to the HUD) ──
       The visual timeline is ~35 s but a real ascent takes minutes,
       so the physics integrate on a compressed mission clock
       (TIME_SCALE× real time). That lands the numbers in credible
       territory — MECO near T+2 min at ~2.5 km/s and ~100 km. */
    const TIME_SCALE = 12;
    let a = 0, thr = 0;
    if (t >= LIFTOFF_T && t < 16)      { a = 14 + 1.9 * (t - LIFTOFF_T); thr = 100; }
    else if (t >= 16 && t < 16.8)      { a = -9.0; thr = 0; }
    else if (t >= 16.8 && t < 21.5)    { a = 24;  thr = 98; }
    else if (t >= 21.5 && t < 22.3)    { a = -8.5; thr = 0; }
    else if (t >= 22.3 && t < 29)      { a = 15;  thr = 92; }
    if (t >= LIFTOFF_T) {
      launch.vel = Math.max(0, launch.vel + a * dt * TIME_SCALE);
      launch.alt += launch.vel * dt * TIME_SCALE;
    }
    launch.accel = a; launch.throttle = thr;
    launch.telemetryClock += dt;
    if (launch.telemetryClock > 0.1) {
      launch.telemetryClock = 0;
      emitLaunch({
        type: 'telemetry',
        tSign: t < LIFTOFF_T ? '-' : '+',
        tAbs: t < LIFTOFF_T ? LIFTOFF_T - t : (t - LIFTOFF_T) * TIME_SCALE,
        alt: launch.alt,
        vel: launch.vel,
        mach: launch.vel / (launch.alt < 11000 ? 340 : 296),
        throttle: thr,
        g: thr > 0 ? (a + 9.81) / 9.81 : 0,
      });
    }

    /* ── camera: pad view during countdown, chase cam during ascent ── */
    launch.camAng += 0.055 * dt;
    let px, py, pz, lx, ly, lz;
    if (t < LIFTOFF_T) {
      const r = totalH * 1.15;
      px = Math.cos(launch.camAng) * r;
      pz = Math.sin(launch.camAng) * r;
      py = -totalH * 0.24;
      lx = 0; ly = -totalH * 0.12; lz = 0;
    } else {
      const climb = rocket.position.y;
      const r = totalH * (1.35 - 0.25 * Math.min(1, (t - LIFTOFF_T) / 14));
      px = Math.cos(launch.camAng) * r;
      pz = Math.sin(launch.camAng) * r;
      py = climb * 0.9 - totalH * 0.12;
      lx = 0; ly = climb + totalH * 0.06; lz = 0;
    }
    if (launch.cutPending) {
      /* Hard cut — snap to the new angle like a broadcast camera
         switch instead of swinging the whole way around. */
      launch.cutPending = false;
      launch.camPos.set(px, py, pz);
      launch.camLook.set(lx, ly, lz);
    } else {
      const cl = 1 - Math.pow(0.04, dt);   /* frame-rate independent lerp */
      launch.camPos.x += (px - launch.camPos.x) * cl;
      launch.camPos.y += (py - launch.camPos.y) * cl;
      launch.camPos.z += (pz - launch.camPos.z) * cl;
      launch.camLook.x += (lx - launch.camLook.x) * cl;
      launch.camLook.y += (ly - launch.camLook.y) * cl;
      launch.camLook.z += (lz - launch.camLook.z) * cl;
    }

    /* Screen shake — random jitter scaled by the current intensity. */
    launch.shakeCurrent += (launch.shakeTarget - launch.shakeCurrent) * 0.06;
    _shk.set(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
    ).multiplyScalar(launch.shakeCurrent * totalH * 0.0065);

    cam.position.copy(launch.camPos).add(_shk);
    cam.lookAt(launch.camLook);
  };

  /* ════════════════════════════════════════════════════════════════
   *  CINEMATIC TOUR
   *
   *  A ~31 s choreographed flight: orbit the finished vehicle →
   *  dissolve the skin → climb the internals bottom-to-top →
   *  disassemble in motion → orbit the exploded stack → reassemble
   *  and land back at the showroom framing. Captions stream to the
   *  modal for the letterboxed film look. Cancel by clicking the
   *  canvas or via the modal's Skip button.
   * ════════════════════════════════════════════════════════════════ */

  const tour = {
    active: false,
    t: 0,
    fired: new Set(),
    cb: null,
    ang: 0,
    camPos: new THREE.Vector3(),
    camLook: new THREE.Vector3(),
  };
  const TOUR_LEN = 31;

  const emitTour = (evt) => { try { tour.cb && tour.cb(evt); } catch {} };
  const tourOnce = (at, key, fn) => {
    if (tour.t >= at && !tour.fired.has(key)) { tour.fired.add(key); fn(); }
  };

  const startTour = (cb) => {
    if (launch.active || tour.active) return false;
    if (xray.on) setXRay(false);
    tour.active = true;
    tour.t = 0;
    tour.fired = new Set();
    tour.cb = cb || null;
    tour.ang = Math.atan2(cam.position.z, cam.position.x);
    tour.camPos.copy(cam.position);
    tour.camLook.copy(ctrl.target);
    introDone = true;
    hideTooltip();
    ctrl.enabled = false;
    spinEnabled = false;
    tiltTarget = 0;
    explodeTarget = 0;
    applyCover(true);
    emitTour({ type: 'start' });
    return true;
  };

  const endTour = (completed) => {
    if (!tour.active) return;
    tour.active = false;
    emitTour({ type: completed ? 'done' : 'cancelled' });
    doResetView();
  };

  const tourTick = (dt) => {
    tour.t += dt;
    const t = tour.t;

    tourOnce(0.3,  'c1', () => emitTour({ type: 'caption', text: 'Launch vehicle — outer mold line' }));
    tourOnce(6.5,  'c2', () => { coverTarget = 1; pendingCover = false; emitTour({ type: 'caption', text: 'Structural reveal' }); });
    tourOnce(9.5,  'c3', () => emitTour({ type: 'caption', text: 'Stage 1 — propulsion & propellant' }));
    tourOnce(13,   'c4', () => emitTour({ type: 'caption', text: 'Stage 2 & interstage hardware' }));
    tourOnce(15.5, 'c5', () => emitTour({ type: 'caption', text: 'Payload & fairing' }));
    tourOnce(17,   'c6', () => { explodeTarget = 1; emitTour({ type: 'caption', text: 'Exploded configuration' }); });
    tourOnce(25,   'c7', () => { applyCover(true); emitTour({ type: 'caption', text: 'Reassembly' }); });
    tourOnce(TOUR_LEN, 'end', () => endTour(true));
    if (!tour.active) return;

    /* Camera choreography — piecewise orbit/climb, smoothed by the
       same frame-rate-independent lerp the launch camera uses. */
    let px, py, pz, lx, ly, lz;
    if (t < 9) {
      /* Wide hero orbit. */
      tour.ang += 0.35 * dt;
      const r = totalH * (1.45 - 0.04 * t);
      px = Math.cos(tour.ang) * r; pz = Math.sin(tour.ang) * r;
      py = totalH * (0.05 + 0.08 * Math.sin(t * 0.35));
      lx = 0; ly = 0; lz = 0;
    } else if (t < 17) {
      /* Close climb along the internals, bottom → top. */
      tour.ang += 0.22 * dt;
      const k = (t - 9) / 8;
      const h = -totalH * 0.45 + k * totalH * 0.9;
      const r = Math.max(dimMaxRadius * 4.2, totalH * 0.34);
      px = Math.cos(tour.ang) * r; pz = Math.sin(tour.ang) * r;
      py = h + totalH * 0.04;
      lx = 0; ly = h; lz = 0;
    } else if (t < 25) {
      /* Pull back and orbit the exploded stack. */
      tour.ang += 0.18 * dt;
      const k = Math.min(1, (t - 17) / 3);
      const r = totalH * (0.9 + k * 1.35);
      px = Math.cos(tour.ang) * r; pz = Math.sin(tour.ang) * r;
      py = disassembledMidWorld * explodeCurrent + totalH * 0.12;
      lx = 0; ly = disassembledMidWorld * explodeCurrent; lz = 0;
    } else {
      /* Return to the showroom frame (tilting back to horizontal). */
      tiltTarget = -Math.PI / 2;
      px = finalPos.x; py = finalPos.y; pz = finalPos.z;
      lx = totalH * 0.02; ly = 0; lz = 0;
    }
    const cl = 1 - Math.pow(0.035, dt);
    tour.camPos.x += (px - tour.camPos.x) * cl;
    tour.camPos.y += (py - tour.camPos.y) * cl;
    tour.camPos.z += (pz - tour.camPos.z) * cl;
    tour.camLook.x += (lx - tour.camLook.x) * cl;
    tour.camLook.y += (ly - tour.camLook.y) * cl;
    tour.camLook.z += (lz - tour.camLook.z) * cl;
    cam.position.copy(tour.camPos);
    cam.lookAt(tour.camLook);
  };

  /* Clicking the canvas cancels a running tour (a "let me drive"
     escape hatch), matching how video players yield to interaction. */
  const onTourCancelPointer = () => { if (tour.active) endTour(false); };
  ren.domElement.addEventListener('pointerdown', onTourCancelPointer);

  /* ════════════════════════════════════════════════════════════════
   *  X-RAY MODE — swap every internal PBR material for a shared
   *  fresnel hologram shader. Fully reversible; the original
   *  materials are cached on first toggle.
   * ════════════════════════════════════════════════════════════════ */

  const xray = { on: false, swaps: null, mat: null };
  coverGroup?.traverse((o) => { o.userData.coverMember = true; });

  const setXRay = (on) => {
    if (on === xray.on) return xray.on;
    if (on) {
      if (!xray.mat) xray.mat = createXRayMaterial();
      if (!xray.swaps) {
        xray.swaps = [];
        rocketInner.traverse((o) => {
          if (!o.isMesh) return;
          if (o.userData.coverMember || o.userData.plume) return;
          if (!o.material || !o.material.isMeshPhysicalMaterial) return;
          xray.swaps.push({ mesh: o, orig: o.material });
        });
      }
      for (const s of xray.swaps) s.mesh.material = xray.mat;
      applyCover(false);
    } else {
      if (xray.swaps) for (const s of xray.swaps) s.mesh.material = s.orig;
    }
    xray.on = on;
    return xray.on;
  };

  /* Shared full-state reset used by resetView / endLaunch / endTour. */
  const doResetView = () => {
    setXRay(false);
    tiltTarget = -Math.PI / 2;
    focusTarget = totalH * 0.02;
    explodeTarget = 0;
    coverTarget = 0;
    pendingCover = false;
    lastDolly = 1;
    panOffset.set(0, 0, 0);
    rocketInner.rotation.y = 0;
    ctrl.target.set(totalH * 0.02, 0, 0);
    cam.position.set(finalPos.x, finalPos.y, finalPos.z);
    cam.lookAt(totalH * 0.02, 0, 0);
    ctrl.enabled = true;
    spinEnabled = true;
  };

  /* Resize observer. */
  const onResize = () => {
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw < 2 || ch < 2) return;
    cam.aspect = cw / ch;
    cam.updateProjectionMatrix();
    ren.setSize(cw, ch, false);
    composer.setSize(cw, ch);
    bloom.setSize(cw, ch);
  };
  const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', onResize);

  /* Animation loop. */
  let raf = 0;
  let lastTime = performance.now();
  const tick = () => {
    if (!running) return;
    raf = requestAnimationFrame(tick);

    /* Per-frame delta time, capped to avoid giant jumps after a
       backgrounded tab regains focus. Used by the rocket self-spin
       so its angular velocity is frame-rate-independent. */
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    /* Cinematic intro lerp. Smoothstep (3t² - 2t³) for that satisfying
       deceleration into the final framing. */
    const sequenceActive = launch.active || tour.active;
    if (!introDone && !sequenceActive) {
      const t = Math.min(1, (now - introStart) / introDuration);
      const e = t * t * (3 - 2 * t);
      cam.position.set(
        introStartPos.x + (finalPos.x - introStartPos.x) * e,
        introStartPos.y + (finalPos.y - introStartPos.y) * e,
        introStartPos.z + (finalPos.z - introStartPos.z) * e,
      );
      cam.lookAt(totalH * 0.02, 0, 0);
      if (t >= 1) {
        introDone = true;
        spinEnabled = initialAutoRotate;
      }
    }

    /* Tilt lerp. */
    tiltCurrent += (tiltTarget - tiltCurrent) * 0.06;
    rocket.rotation.z = tiltCurrent;

    /* Long-axis self-rotation. Smoothly ramp `spinCurrent` toward
       its enabled/disabled target, then advance the inner rocket
       around its own local Y axis. Because rocketInner is parented
       to `rocket` and its local Y is the rocket's long axis, this
       rotation is correct in any tilt: vertical → spins in place
       like a turntable, horizontal → rolls like a rotisserie. */
    /* Pause the self-spin while a component tooltip is up, so the
       dimension lines aren't measuring a rocket that's sliding past
       underneath them. Resumes automatically when the tooltip is
       dismissed. */
    const targetSpin = (spinEnabled && !shownInfo) ? SPIN_RATE_RAD_PER_SEC : 0;
    spinCurrent += (targetSpin - spinCurrent) * 0.05;
    rocketInner.rotation.y += spinCurrent * dt;

    /* Explode lerp. Parts the launch sequence has jettisoned are
       reparented under tumble pivots — skip them so this per-frame
       write doesn't yank them back onto the stack. */
    const explodePrev = explodeCurrent;
    explodeCurrent += (explodeTarget - explodeCurrent) * 0.08;
    for (const e of explodeTargets) {
      if (e.group.parent !== rocketInner) continue;
      e.group.position.y = e.offset * explodeCurrent;
    }

    /* Once a deferred re-cover's rocket has finished reassembling, let
       the shell start forming back over the closed vehicle. */
    if (pendingCover && explodeCurrent < 0.06) {
      pendingCover = false;
      coverTarget = 0;
    }

    /* Cover dissolve lerp. Push the current progress into every cover
       material's `uDissolve`; hide the group once fully dissolved so it
       stops costing draw calls / raycasts against the internals. */
    coverCurrent += (coverTarget - coverCurrent) * 0.045;
    for (const cm of coverMaterials) {
      const sh = cm.userData?.dissolveShader;
      if (sh) sh.uniforms.uDissolve.value = coverCurrent;
    }
    if (coverGroup) coverGroup.visible = coverCurrent < 0.999;

    /* If we just dropped below the tooltip-availability threshold
       (rocket is reassembling), hide any active component tooltip
       even if the mouse hasn't moved — without this, the bubble
       would linger on screen during a Reassemble until the user
       happened to wiggle the cursor. */
    if (
      explodePrev >= TOOLTIP_EXPLODE_THRESHOLD &&
      explodeCurrent < TOOLTIP_EXPLODE_THRESHOLD
    ) {
      hideTooltip();
    }

    /* Launch / tour timelines own the camera completely while they
       run — the orbit-controls target lerp + explode dolly below
       would fight their per-frame camera writes, so both are gated
       behind `sequenceActive`. */
    if (launch.active) {
      launchTick(dt);
    } else if (tour.active) {
      tourTick(dt);
    }

    /* Focus lerp + disassemble center shift.
       When the rocket is disassembled, stage 1 stays grounded while
       the fairing flies far above the payload (along the rocket's
       local +Y, the long axis). We lerp the camera target toward
       the bbox-derived disassembled midpoint, *projected onto the
       rocket's current world-space long-axis direction* — so when
       the rocket lies horizontal the target slides along world X
       instead of stubbornly climbing up Y. Long-axis direction
       after a Z-rotation by `tiltCurrent`: rotating (0,1,0) by Z=θ
       gives (-sin θ, cos θ, 0). The user's focusSlider stacks onto
       the explode shift, both interpreted as "long-axis offset". */
    if (!sequenceActive) {
      const tiltSin = Math.sin(tiltCurrent);
      const tiltCos = Math.cos(tiltCurrent);
      const longAxisOffset = focusTarget + disassembledMidWorld * explodeCurrent;
      /* `panOffset` rides on top of the computed long-axis target so a
         manually-panned view persists instead of being lerped back. */
      const targetXdesired = longAxisOffset * (-tiltSin) + panOffset.x;
      const targetYdesired = longAxisOffset * tiltCos + panOffset.y;
      const targetZdesired = panOffset.z;
      ctrl.target.x += (targetXdesired - ctrl.target.x) * 0.08;
      ctrl.target.y += (targetYdesired - ctrl.target.y) * 0.08;
      ctrl.target.z += (targetZdesired - ctrl.target.z) * 0.08;

      /* Dolly the camera out proportionally to the disassemble
         progress. Without this, the taller exploded stack spills out
         of frame and feels cramped. We scale the camera's offset from
         the look-at target by `desiredDolly / lastDolly` each frame —
         the user's manual zoom is preserved, we only add to it.
         Gated on `introDone` so the cinematic intro's per-frame
         `cam.position.set()` doesn't fight with the dolly's own
         per-frame writes during the opening dolly-in. */
      if (introDone) {
        const desiredDolly = 1 + explodeDollyDelta * explodeCurrent;
        if (Math.abs(desiredDolly - lastDolly) > 1e-4) {
          const dollyOffset = cam.position.clone().sub(ctrl.target);
          dollyOffset.multiplyScalar(desiredDolly / lastDolly);
          cam.position.copy(ctrl.target).add(dollyOffset);
          lastDolly = desiredDolly;
        }
      }
    }

    /* Fade the outer shell out as the rocket disassembles. The
       multiplier reaches 0 at explode = 0.20, so by the time the
       stages have separated visibly the shell + its stiffeners +
       access panels have already disappeared and don't read as
       phantom cylinders between the parts. During a launch the shell
       instead fades with the skin burn-away — otherwise it would be
       left hanging as a ghost envelope when the stages jettison. */
    const shellMul = launch.active
      ? Math.min(Math.max(0, 1 - explodeCurrent * 5), 1 - coverCurrent)
      : Math.max(0, 1 - explodeCurrent * 5);
    for (const f of fadeTargets) {
      f.mat.opacity = f.baseOpacity * shellMul;
    }

    /* Component + total dimension lines (and their HTML labels).
       Runs last so it reads the freshest tilt / explode / camera
       state computed above this frame. */
    updateDimLines();

    /* OrbitControls.update() re-asserts its own camera orientation
       from its target, which would undo the launch/tour cameras'
       lookAt — skip it while a sequence is driving. */
    if (!sequenceActive) ctrl.update();
    composer.render();
  };
  tick();

  /* Public control API for the modal. */
  return {
    meta: stageMeta,
    /** Toggle the rocket's long-axis self-rotation (the "showroom"
     *  spin). Returns the new on/off state for UI sync. */
    toggleAutoRotate() {
      spinEnabled = !spinEnabled;
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      return spinEnabled;
    },
    /** Flip between horizontal (default) and vertical tilt. Returns
     *  whether the new state is horizontal (true) or vertical (false). */
    toggleHorizontal() {
      const goingHorizontal = tiltTarget === 0;
      tiltTarget = goingHorizontal ? -Math.PI / 2 : 0;
      return goingHorizontal;
    },
    setFocus(frac) {
      const f = Math.max(0, Math.min(1, frac));
      focusTarget = focusMin + f * (focusMax - focusMin);
    },
    /** Dolly the camera toward (factor < 1) or away from (factor > 1)
     *  the look-at target, clamped to the orbit min/max distance.
     *  Pairs with the on-screen zoom +/− buttons. */
    zoom(factor) {
      const offset = cam.position.clone().sub(ctrl.target);
      let d = offset.length() * factor;
      d = Math.max(ctrl.minDistance, Math.min(ctrl.maxDistance, d));
      offset.setLength(d);
      cam.position.copy(ctrl.target).add(offset);
    },
    /** Pan the view by a fraction of the viewport along the camera's
     *  screen axes. `dxFrac` +right, `dyFrac` +up. Moves the camera
     *  immediately and records the shift in `panOffset` so the
     *  target-lerp keeps it (rather than snapping back). */
    pan(dxFrac, dyFrac) {
      const offset = cam.position.clone().sub(ctrl.target);
      const dist = offset.length();
      const worldPerFrac = 2 * dist * Math.tan((cam.fov * Math.PI) / 360);
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up    = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const delta = new THREE.Vector3()
        .addScaledVector(right, dxFrac * worldPerFrac * cam.aspect)
        .addScaledVector(up,    dyFrac * worldPerFrac);
      cam.position.add(delta);
      panOffset.add(delta);
    },
    /** `on` toggles between assembled (0) and exploded (1). Smooth lerp.
     *  Disassembling auto-dissolves the outer cover first — you can't
     *  meaningfully pull apart a rocket that's still wrapped in its
     *  skin, so the reveal rides along with the explode. */
    setExploded(on) {
      explodeTarget = on ? 1 : 0;
      if (on) { coverTarget = 1; pendingCover = false; }
    },
    /** Show (`on = true`) or dissolve away (`on = false`) the outer
     *  cover. Turning it on reassembles first (see applyCover). */
    setCover(on) {
      applyCover(on);
    },
    /** Toggle the outer cover. Returns the new on/off state (true =
     *  cover present / on its way on) so the modal can sync its label. */
    toggleCover() {
      const next = !coverIsOn();
      applyCover(next);
      return next;
    },
    /** Recolour the cover: 'white' | 'black' | 'darkblue' | 'metal'.
     *  Re-draws the livery, re-stamps the decals with a contrast-safe
     *  logo, and retints the skin finish. */
    setColorMode(mode) {
      coverSetColorMode?.(mode);
    },
    /** Reset the camera to the cinematic landing position, plus
     *  unhide everything (cancel explode / focus / X-ray, and any
     *  running launch or tour sequence). Tilt resets to the
     *  horizontal default so "Reset" lands the user back at the
     *  same showroom framing they started with. */
    resetView() {
      if (launch.active) { endLaunch(); return; }
      if (tour.active)   { endTour(false); return; }
      doResetView();
    },
    /** Kick off the full launch sequence. `cb` receives timeline
     *  events: {type:'countdown'|'callout'|'telemetry'|'done'|'start'}.
     *  Returns false if another sequence is already running. */
    startLaunch(cb) { return startLaunch(cb); },
    /** Abort a running launch and restore the showroom state. The
     *  modal fades to black around this call so the snap is hidden. */
    abortLaunch() { endLaunch(); },
    /** Play the ~31 s cinematic tour. `cb` receives
     *  {type:'caption'|'done'|'cancelled'|'start'} events. */
    startTour(cb) { return startTour(cb); },
    /** Cancel a running tour (also triggered by clicking the canvas). */
    skipTour() { endTour(false); },
    /** Toggle the X-ray hologram view. Returns the new state. */
    toggleXRay() {
      if (launch.active || tour.active) return xray.on;
      const next = setXRay(!xray.on);
      /* Restoring normal view re-forms the cover only if the user had
         it on before? Simpler contract: X-ray off returns to the
         internals view (cover stays dissolved) — one less surprise. */
      return next;
    },
    /** Mute / unmute the launch audio. Returns the new muted state. */
    toggleAudio() {
      audio.setMuted(!audio.isMuted());
      return audio.isMuted();
    },
    /** Capture the current frame as a PNG data-URL (composited with
     *  bloom). Rendered synchronously right before capture so the
     *  drawing buffer is guaranteed fresh. */
    snapshot() {
      composer.render();
      return ren.domElement.toDataURL('image/png');
    },
    /** Whether a camera-owning sequence (launch/tour) is running. */
    isSequenceActive() { return launch.active || tour.active; },
    dispose() {
      running = false;
      launch.active = false;
      tour.active = false;
      audio.dispose();
      exhaust.dispose();
      smoke.dispose();
      speedLines.dispose();
      if (xray.mat) xray.mat.dispose();
      if (raf) cancelAnimationFrame(raf);
      if (resumeTimer) clearTimeout(resumeTimer);
      if (hoverTimer)  clearTimeout(hoverTimer);
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      ren.domElement.removeEventListener('pointerdown', onTourCancelPointer);
      ren.domElement.removeEventListener('pointerdown', onPointerDown);
      ren.domElement.removeEventListener('pointerup',   onPointerUp);
      ren.domElement.removeEventListener('mousemove',  onMouseMove);
      ren.domElement.removeEventListener('mouseleave', hideTooltip);
      try { tooltipEl.parentNode && tooltipEl.parentNode.removeChild(tooltipEl); } catch {}
      try { compLabel.parentNode && compLabel.parentNode.removeChild(compLabel); } catch {}
      ctrl.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of ms) {
            for (const k of Object.keys(m)) {
              const v = m[k];
              if (v && typeof v === 'object' && v.isTexture) v.dispose();
            }
            m.dispose();
          }
        }
      });
      if (scene.background && scene.background.isTexture) scene.background.dispose();
      if (envTex) envTex.dispose();
      composer.passes.forEach((p) => { try { p.dispose && p.dispose(); } catch {} });
      ren.dispose();
      try { ren.domElement.parentNode && ren.domElement.parentNode.removeChild(ren.domElement); } catch {}
    },
  };
}
