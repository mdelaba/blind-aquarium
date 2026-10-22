import * as THREE from 'three';

// ---------- constants ----------
const TILE = 3, WALL_H = 3.6, N = 9, W = 2 * N + 1;
const PING_SPEED = 14, PING_LIFE = 4.6, PING_CD = 2.4;
const PEARLS = 5;
const $ = id => document.getElementById(id);

// ---------- renderer ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 120);
scene.add(camera);
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------- sonar shader ----------
const shared = {
  uPings: { value: [0, 1, 2].map(() => new THREE.Vector4(0, 0, 0, -1)) },
  uGlow: { value: [0, 1].map(() => new THREE.Vector4(0, 0, 0, 0)) },
  uPlayer: { value: new THREE.Vector3() },
  uTime: { value: 0 },
};
const VERT = `
varying vec3 vW; varying vec3 vN;
void main(){
  vec4 wp = vec4(position,1.0); vec3 n = normal;
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp; n = mat3(instanceMatrix) * n;
  #endif
  wp = modelMatrix * wp; n = mat3(modelMatrix) * n;
  vW = wp.xyz; vN = n;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = `
uniform sampler2D uMap; uniform float uUseMap, uTexScale, uMonster, uTime;
uniform vec3 uTint, uPlayer; uniform vec4 uPings[3]; uniform vec4 uGlow[2];
varying vec3 vW; varying vec3 vN;
void main(){
  vec3 n = normalize(vN); vec3 an = abs(n);
  vec2 uv = an.y > .5 ? vW.xz : (an.x > .5 ? vW.zy : vW.xy);
  vec3 base = uUseMap > .5 ? texture2D(uMap, uv * uTexScale).rgb : vec3(.9);
  base *= uTint;
  float lit = 0., edge = 0.;
  for (int i = 0; i < 3; i++) {
    float age = uPings[i].w; if (age < 0.) continue;
    vec3 o = uPings[i].xyz; float d = distance(vW, o);
    float rf = 1. - smoothstep(16., 34., d);
    float passed = age - d / ${PING_SPEED.toFixed(1)};
    if (passed > 0.) {
      float facing = .45 + .55 * max(dot(n, normalize(o - vW)), 0.);
      lit += exp(-passed * 1.0) * rf * facing;
    }
    edge += exp(-pow((d - age * ${PING_SPEED.toFixed(1)}) / .45, 2.)) * rf;
  }
  float amb = exp(-distance(vW, uPlayer) * 1.1) * .10;
  vec3 pc = mix(vec3(.3,.85,1.), vec3(1.,.22,.18), uMonster);
  vec3 col = base * (lit * 1.1 + amb) * pc + pc * edge * .5;
  for (int i = 0; i < 2; i++) {
    float g = uGlow[i].w;
    if (g > 0.) {
      vec3 gc = i == 0 ? vec3(.7,1.,.95) : vec3(1.,.78,.3);
      col += base * gc * g * exp(-distance(vW, uGlow[i].xyz) * .7) * 1.2;
    }
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const texLoader = new THREE.TextureLoader();
function loadTex(name) {
  const t = texLoader.load(`assets/tex/${name}/${name}_1K-JPG_Color.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const TEX = { concrete: loadTex('Concrete034'), rust: loadTex('Rust004'), moss: loadTex('Moss002'), tile: loadTex('Tiles074') };
function sonarMat(map, tint = [1, 1, 1], monster = 0) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      ...shared, uMap: { value: map }, uUseMap: { value: map ? 1 : 0 }, uTexScale: { value: 1 / 3 },
      uTint: { value: new THREE.Vector3(...tint) }, uMonster: { value: monster },
    },
  });
}
const MAT = {
  concrete: sonarMat(TEX.concrete, [1, 1, 1]), rust: sonarMat(TEX.rust, [1, .9, .8]),
  moss: sonarMat(TEX.moss, [.9, 1, .9]), floor: sonarMat(TEX.tile, [1, 1, 1]),
  ceil: sonarMat(TEX.concrete, [.55, .6, .6]), monster: sonarMat(null, [1, 1, 1], 1),
};

// ---------- audio (synth + one CC0 drone) ----------
const A = { ctx: null };
function initAudio() {
  if (A.ctx) return;
  const ctx = A.ctx = new (window.AudioContext || window.webkitAudioContext)();
  A.master = ctx.createGain(); A.master.gain.value = 0.9; A.master.connect(ctx.destination);
  const len = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  A.rev = ctx.createConvolver(); A.rev.buffer = ir;
  const rg = ctx.createGain(); rg.gain.value = 0.55; A.rev.connect(rg); rg.connect(A.master);
  A.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = A.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const mkPan = (ref = 2) => { const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = 1.3; p.maxDistance = 80; p.connect(A.master); p.connect(A.rev); return p; };
  A.monPan = mkPan(); A.pearlPan = mkPan(1.5);
  // pearl hum
  A.hum = ctx.createOscillator(); A.hum.type = 'triangle'; A.hum.frequency.value = 330;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 5; const lg = ctx.createGain(); lg.gain.value = 0.5;
  A.humG = ctx.createGain(); A.humG.gain.value = 0; lfo.connect(lg); lg.connect(A.humG.gain);
  A.hum.connect(A.humG); A.humG.connect(A.pearlPan); A.hum.start(); lfo.start();
  // CC0 drone
  const el = new Audio('assets/audio/manaosdrone1_0.ogg'); el.loop = true; el.volume = 0.5;
  ctx.createMediaElementSource(el).connect(A.master); el.play().catch(() => {});
}
function burst({ dur = .1, f = 1000, q = 1, type = 'lowpass', g = .4, dest, t0 = 0 }) {
  const ctx = A.ctx; if (!ctx) return;
  const s = ctx.createBufferSource(); s.buffer = A.noise; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  const gn = ctx.createGain(), t = ctx.currentTime + t0; gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(fl); fl.connect(gn); gn.connect(dest || A.master); s.start(t, Math.random() * .5, dur + .05);
}
function tone({ f0, f1, dur = .5, g = .3, type = 'sine', dest, t0 = 0 }) {
  const ctx = A.ctx; if (!ctx) return;
  const o = ctx.createOscillator(); o.type = type; const gn = ctx.createGain(), t = ctx.currentTime + t0;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
  gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(gn); gn.connect(dest || A.master); o.start(t); o.stop(t + dur + .05);
}
const sfx = {
  ping() { tone({ f0: 1500, f1: 260, dur: 1.2, g: .35 }); tone({ f0: 750, f1: 130, dur: 1.6, g: .2, type: 'triangle' }); burst({ dur: .5, f: 2500, g: .15, dest: A.rev }); },
  step(loud) { burst({ dur: .09, f: loud ? 700 : 400, g: loud ? .35 : .18 }); },
  click(pan) { burst({ dur: .03, f: 3200, type: 'highpass', g: .9, dest: pan }); burst({ dur: .05, f: 900, g: .5, dest: pan, t0: .01 }); },
  pearl() { [660, 880, 1320, 1760].forEach((f, i) => tone({ f0: f, f1: f * .99, dur: 1.4, g: .18, t0: i * .09 })); },
  clink(pos) { tone({ f0: 3200, f1: 2800, dur: .5, g: .3, dest: tmpPan(pos) }); tone({ f0: 4300, f1: 4000, dur: .35, g: .2, dest: tmpPan(pos), t0: .08 }); },
  thump() { tone({ f0: 70, f1: 38, dur: .22, g: .8 }); },
  scare() { burst({ dur: 1.4, f: 1800, g: 1, type: 'bandpass', q: .6 }); tone({ f0: 900, f1: 90, dur: 1.2, g: .5, type: 'sawtooth' }); tone({ f0: 1400, f1: 140, dur: 1.2, g: .3, type: 'square' }); },
  win() { [392, 523, 659, 784, 1047].forEach((f, i) => tone({ f0: f, f1: f, dur: 2, g: .2, t0: i * .15 })); },
};
function tmpPan(pos) {
  const p = A.ctx.createPanner(); p.panningModel = 'HRTF'; p.refDistance = 2; p.rolloffFactor = 1.2;
  p.positionX.value = pos.x; p.positionY.value = 0.3; p.positionZ.value = pos.z; p.connect(A.master); p.connect(A.rev); return p;
}
function setPanPos(p, x, y, z) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
function updateListener() {
  const l = A.ctx.listener, f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  l.positionX.value = camera.position.x; l.positionY.value = camera.position.y; l.positionZ.value = camera.position.z;
  l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
}

// ---------- level ----------
let seen, grid, levelGroup, pearls, start, exitPos, monster;
const rnd = n => Math.floor(Math.random() * n);
const solid = (tx, ty) => tx < 0 || ty < 0 || tx >= W || ty >= W || grid[ty][tx] === 1;
const tileOf = v => Math.floor(v / TILE);
const center = t => (t + .5) * TILE;

function genMaze() {
  grid = Array.from({ length: W }, () => Array(W).fill(1));
  const stack = [[1, 1]]; grid[1][1] = 0;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const nb = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx > 0 && ny > 0 && nx < W - 1 && ny < W - 1 && grid[ny][nx] === 1; });
    if (!nb.length) { stack.pop(); continue; }
    const [dx, dy] = nb[rnd(nb.length)]; grid[y + dy / 2][x + dx / 2] = 0; grid[y + dy][x + dx] = 0; stack.push([x + dx, y + dy]);
  }
  // loops, so you can circle the Listener
  for (let k = 0, tries = 0; k < 16 && tries < 400; tries++) {
    const x = 1 + rnd(W - 2), y = 1 + rnd(W - 2);
    if (grid[y][x] === 1 && (x + y) % 2 === 1 && ((grid[y][x - 1] === 0 && grid[y][x + 1] === 0) || (grid[y - 1][x] === 0 && grid[y + 1][x] === 0))) { grid[y][x] = 0; k++; }
  }
  // a few open halls (flooded plazas)
  for (let k = 0; k < 3; k++) { const x = 3 + 2 * rnd(N - 3), y = 3 + 2 * rnd(N - 3); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grid[y + dy][x + dx] = 0; }
}
function distField(sx, sy) {
  const d = Array.from({ length: W }, () => Array(W).fill(-1)); d[sy][sx] = 0; const q = [[sx, sy]];
  for (let i = 0; i < q.length; i++) { const [x, y] = q[i]; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (!solid(nx, ny) && d[ny][nx] < 0) { d[ny][nx] = d[y][x] + 1; q.push([nx, ny]); } } }
  return d;
}

const pearlTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(160,255,240,.6)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
const mkSprite = col => new THREE.Sprite(new THREE.SpriteMaterial({ map: pearlTex, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));

function buildMonster() {
  const g = new THREE.Group(), m = MAT.monster;
  const add = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); g.add(o); return o; };
  add(new THREE.CylinderGeometry(.2, .36, 1.1, 10), 0, 1.95, 0);                      // torso
  const legs = [-.14, .14].map(x => add(new THREE.CylinderGeometry(.05, .07, 1.5, 6), x, .75, 0));
  add(new THREE.SphereGeometry(.3, 12, 10), 0, 2.8, .05).scale.set(.85, 1.3, .95);   // head
  add(new THREE.ConeGeometry(.2, .6, 8), 0, 2.35, .12, Math.PI, 0, 0);               // gaping jaw
  [-1, 1].forEach(s => { add(new THREE.ConeGeometry(.24, .9, 6), s * .42, 3.0, 0, 0, 0, -s * .5); });  // great ears
  const arms = [-1, 1].map(s => {
    const a = new THREE.Group(); a.position.set(s * .38, 2.35, 0);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(.04, .06, 1.7, 6), m); up.position.y = -.85; a.add(up);
    for (let i = -1; i <= 1; i++) { const c = new THREE.Mesh(new THREE.ConeGeometry(.025, .35, 4), m); c.position.set(i * .06, -1.85, 0); c.rotation.x = Math.PI; a.add(c); }
    g.add(a); return a;
  });
  g.userData = { arms, legs };
  return g;
}

function buildLevel() {
  if (levelGroup) { scene.remove(levelGroup); levelGroup.traverse(o => o.isInstancedMesh && o.dispose()); }
  levelGroup = new THREE.Group(); scene.add(levelGroup);
  genMaze(); seen = Array.from({ length: W }, () => Array(W).fill(0));
  const box = new THREE.BoxGeometry(TILE, WALL_H, TILE), groups = { concrete: [], rust: [], moss: [] };
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (grid[y][x]) {
    const border = x === 0 || y === 0 || x === W - 1 || y === W - 1;
    groups[border ? 'moss' : Math.random() < .22 ? 'rust' : 'concrete'].push([x, y]);
  }
  const m4 = new THREE.Matrix4();
  for (const k in groups) {
    const im = new THREE.InstancedMesh(box, MAT[k], groups[k].length); im.frustumCulled = false;
    groups[k].forEach(([x, y], i) => { m4.setPosition(center(x), WALL_H / 2, center(y)); im.setMatrixAt(i, m4); });
    levelGroup.add(im);
  }
  const size = W * TILE;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), MAT.floor); floor.rotation.x = -Math.PI / 2; floor.position.set(size / 2, 0, size / 2);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(size, size), MAT.ceil); ceil.rotation.x = Math.PI / 2; ceil.position.set(size / 2, WALL_H, size / 2);
  floor.frustumCulled = ceil.frustumCulled = false; levelGroup.add(floor, ceil);

  start = { x: center(1), z: center(1) }; exitPos = new THREE.Vector3(start.x, 0.2, start.z);
  const d = distField(1, 1), cells = [];
  for (let y = 1; y < W; y += 2) for (let x = 1; x < W; x += 2) if (d[y][x] >= 0) cells.push([x, y, d[y][x]]);
  cells.sort(() => Math.random() - .5);
  const picks = [];
  for (const c of cells) { if (picks.length >= PEARLS) break; if (c[2] >= 9 && picks.every(p => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) >= 6)) picks.push(c); }
  for (const c of cells) { if (picks.length >= PEARLS) break; if (!picks.includes(c) && c[2] >= 5) picks.push(c); }
  pearls = picks.map(([x, y]) => ({ pos: new THREE.Vector3(center(x), 1.0, center(y)), got: false, sprite: mkSprite(0xaaffee) }));
  pearls.forEach(p => { p.sprite.position.copy(p.pos); p.sprite.scale.setScalar(.9); levelGroup.add(p.sprite); });
  const beacon = mkSprite(0xffcc55); beacon.position.set(start.x, 1.2, start.z); beacon.scale.setScalar(2.2); levelGroup.add(beacon); exitPos.beacon = beacon;
  // the Listener starts in the farthest cell
  const far = cells.reduce((a, b) => (b[2] > a[2] ? b : a));
  if (!monster) monster = { mesh: buildMonster() };
  levelGroup.add(monster.mesh);
  Object.assign(monster, { x: center(far[0]), z: center(far[1]), state: 'patrol', target: null, speed: 2, searchT: 0, repath: 0, nextTile: null, clickT: 1, ang: 0, boost: 0 });
}

// ---------- player / state ----------
const P = { x: 0, z: 0, yaw: 0, pitch: 0, crouch: 0, bob: 0, stride: 0, vx: 0, vz: 0 };
const G = { state: 'menu', pings: [], pingCd: 0, shells: 3, noiseR: 0, noiseShow: 0, hb: 0, dead: 0, msgT: 0, lastNoise: 0, mapT: 0, mapX: 0, mapZ: 0 };
const keys = {};
const cam = camera;

function resetGame() {
  buildLevel();
  P.x = start.x; P.z = start.z; P.yaw = Math.PI / 2 * (Math.random() < .5 ? 0 : 1); P.pitch = 0; P.crouch = 0;
  // face an open direction
  for (const [yaw, dx, dy] of [[Math.PI, 0, 1], [-Math.PI / 2, 1, 0]]) if (!solid(1 + dx, 1 + dy)) { P.yaw = yaw; break; }
  monster.mesh.scale.setScalar(1); G.pings = []; G.mapT = 0; G.pingCd = 0; G.shells = 3; G.dead = 0; G.hb = 0; G.scareStart = 0;
  for (let i = 0; i < 3; i++) shared.uPings.value[i].w = -1;
  updateHud(); G.state = 'play';
  say('Something clicks in the dark…  Ping to see. Be quiet to live.', 5);
}
function say(t, s = 3) { const e = $('say'); e.textContent = t; e.style.opacity = 1; G.msgT = s; }
function updateHud() {
  $('pearls').textContent = pearls.map(p => (p.got ? '●' : '○')).join('');
  $('shells').textContent = '●'.repeat(G.shells) + '○'.repeat(3 - G.shells);
}

function noiseEvent(x, z, radius, hot = false) {
  const dx = monster.x - x, dz = monster.z - z;
  if (dx * dx + dz * dz < radius * radius) { monster.target = { x, z }; monster.state = 'investigate'; monster.repath = 0; if (hot) monster.boost = 4; }
}
function ping() {
  if (G.pingCd > 0 || G.state !== 'play') return;
  G.pingCd = PING_CD; sfx.ping();
  let slot = G.pings.length < 3 ? G.pings.length : G.pings.indexOf(G.pings.reduce((a, b) => (a.age > b.age ? a : b)));
  G.pings[slot] = { x: cam.position.x, y: cam.position.y, z: cam.position.z, age: 0 };
  noiseEvent(P.x, P.z, 60, true); G.noiseShow = 1; G.mapT = MAP_TIME; G.mapX = P.x; G.mapZ = P.z;
}
function throwShell() {
  if (G.shells <= 0 || G.state !== 'play') return;
  G.shells--; updateHud();
  const dx = -Math.sin(P.yaw), dz = -Math.cos(P.yaw); let x = P.x, z = P.z;
  for (let d = 0; d < 20; d += .25) { const nx = P.x + dx * d, nz = P.z + dz * d; if (solid(tileOf(nx), tileOf(nz))) break; x = nx; z = nz; }
  setTimeout(() => { sfx.clink({ x, z }); noiseEvent(x, z, 24); }, 350 + Math.hypot(x - P.x, z - P.z) * 25);
}

// ---------- minimap ----------
const mini = $('mini'), mctx = mini.getContext('2d'), CELL = mini.width / W;
const MAP_TIME = 5, MAP_R = 7;
function drawMinimap(t) {
  mctx.clearRect(0, 0, mini.width, mini.height);
  const px = P.x / TILE * CELL, pz = P.z / TILE * CELL;
  if (G.mapT > 0) {
    const cx = G.mapX / TILE * CELL, cz = G.mapZ / TILE * CELL, r = MAP_R * CELL;
    mctx.save(); mctx.globalAlpha = Math.min(1, G.mapT);
    mctx.beginPath(); mctx.arc(cx, cz, r, 0, 7); mctx.clip();
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { mctx.fillStyle = grid[y][x] ? '#1a5a78' : '#0a2433'; mctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
    if (pearls.every(p => p.got)) { mctx.fillStyle = '#fc4'; mctx.fillRect(exitPos.x / TILE * CELL - 2, exitPos.z / TILE * CELL - 2, 4, 4); }
    mctx.fillStyle = '#bff';
    for (const p of pearls) if (!p.got) { mctx.beginPath(); mctx.arc(p.pos.x / TILE * CELL, p.pos.z / TILE * CELL, 2.5, 0, 7); mctx.fill(); }
    mctx.restore();
    mctx.save(); mctx.globalAlpha = Math.min(1, G.mapT) * .6; mctx.strokeStyle = '#5ac'; mctx.beginPath(); mctx.arc(cx, cz, r, 0, 7); mctx.stroke(); mctx.restore();
  }
  mctx.save(); mctx.translate(px, pz); mctx.rotate(-P.yaw); mctx.fillStyle = '#fff';
  mctx.beginPath(); mctx.moveTo(0, -5); mctx.lineTo(3.5, 4); mctx.lineTo(-3.5, 4); mctx.closePath(); mctx.fill(); mctx.restore();
}

// ---------- input ----------
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); ping(); }
  if (e.code === 'KeyF' && !e.repeat) throwShell();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousedown', e => { if (G.state === 'play' && document.pointerLockElement) ping(); });
addEventListener('mousemove', e => {
  if (!document.pointerLockElement || G.state === 'dead') return;
  P.yaw -= e.movementX * .0022; P.pitch = Math.max(-1.4, Math.min(1.4, P.pitch - e.movementY * .0022));
});
function engage() { initAudio(); A.ctx.resume(); canvas.requestPointerLock(); }
const overlays = ['title', 'pause', 'dead', 'win'];
function show(id) { overlays.forEach(o => $(o).classList.toggle('hide', o !== id)); }
$('title').onclick = () => { engage(); resetGame(); show(null); };
$('pause').onclick = () => { engage(); G.state = 'play'; show(null); };
$('dead').onclick = () => { engage(); resetGame(); show(null); };
$('win').onclick = () => { engage(); resetGame(); show(null); };
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && G.state === 'play') { G.state = 'paused'; show('pause'); } });

// ---------- simulation ----------
function collides(x, z, r = .42) { return solid(tileOf(x - r), tileOf(z - r)) || solid(tileOf(x + r), tileOf(z - r)) || solid(tileOf(x - r), tileOf(z + r)) || solid(tileOf(x + r), tileOf(z + r)); }

function updatePlayer(dt) {
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const sneak = keys.KeyC || keys.ControlLeft, run = (keys.ShiftLeft || keys.ShiftRight) && !sneak && f > 0;
  P.crouch += ((sneak ? 1 : 0) - P.crouch) * Math.min(1, dt * 8);
  const spd = run ? 4.6 : sneak ? 1.3 : 2.6, moving = f || s;
  let mx = 0, mz = 0;
  if (moving) { const l = Math.hypot(f, s); const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw); mx = (fx * f + rx * s) / l * spd; mz = (fz * f + rz * s) / l * spd; }
  P.vx += (mx - P.vx) * Math.min(1, dt * 10); P.vz += (mz - P.vz) * Math.min(1, dt * 10);
  const nx = P.x + P.vx * dt, nz = P.z + P.vz * dt;
  if (!collides(nx, P.z)) P.x = nx; if (!collides(P.x, nz)) P.z = nz;
  const sp = Math.hypot(P.vx, P.vz);
  P.stride += sp * dt; P.bob += sp * dt * 2.2;
  if (P.stride > (run ? 1.7 : 2.3)) { P.stride = 0; if (!sneak) sfx.step(run); }
  G.noiseR = sp < .3 ? 0 : run ? 11 : sneak ? 0 : 5.5;
  // footstep noise is continuous: the Listener tracks whatever it can hear
  if (G.noiseR > 0) noiseEvent(P.x, P.z, G.noiseR);
  G.noiseShow = Math.max(G.noiseShow - dt * .6, G.noiseR / 11);
  cam.position.set(P.x, 1.65 - P.crouch * .7 + Math.sin(P.bob) * .025 * (sp > .3 ? 1 : 0), P.z);
  cam.rotation.set(P.pitch, P.yaw, 0, 'YXZ');
}

function nextStep(sx, sy, tx, ty) {
  const d = distField(tx, ty); let best = null, bd = d[sy][sx];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = sx + dx, ny = sy + dy; if (!solid(nx, ny) && d[ny][nx] >= 0 && d[ny][nx] < bd) { bd = d[ny][nx]; best = [nx, ny]; } }
  return best;
}
function randomCell() { for (;;) { const x = 1 + 2 * rnd(N), y = 1 + 2 * rnd(N); if (!solid(x, y)) return { x: center(x), z: center(y) }; } }

function updateMonster(dt, t) {
  const M = monster, got = pearls.filter(p => p.got).length;
  M.boost = Math.max(0, M.boost - dt);
  const dist = Math.hypot(P.x - M.x, P.z - M.z);
  let spd = 0;
  if (M.state === 'patrol') { spd = 1.7 + got * .1; if (!M.target || Math.hypot(M.target.x - M.x, M.target.z - M.z) < .7) M.target = randomCell(); }
  else if (M.state === 'investigate') {
    spd = 3.0 + got * .3 + (M.boost > 0 ? .6 : 0);
    if (Math.hypot(M.target.x - M.x, M.target.z - M.z) < .8) { M.state = 'search'; M.searchT = 3.5; }
  } else if (M.state === 'search') { spd = 0; M.searchT -= dt; if (M.searchT <= 0) { M.state = 'patrol'; M.target = null; } }
  if (spd > 0 && M.target) {
    M.repath -= dt;
    const mt = [tileOf(M.x), tileOf(M.z)], tt = [tileOf(M.target.x), tileOf(M.target.z)];
    if (M.repath <= 0 || !M.nextTile) { M.nextTile = (mt[0] === tt[0] && mt[1] === tt[1]) ? null : nextStep(mt[0], mt[1], tt[0], tt[1]); M.repath = .25; }
    const tx = M.nextTile ? center(M.nextTile[0]) : M.target.x, tz = M.nextTile ? center(M.nextTile[1]) : M.target.z;
    const dx = tx - M.x, dz = tz - M.z, l = Math.hypot(dx, dz) || 1, st = Math.min(spd * dt, l);
    M.x += dx / l * st; M.z += dz / l * st; M.ang = Math.atan2(dx, dz);
  }
  // mesh
  const m = M.mesh, u = m.userData;
  m.position.set(M.x, 0, M.z); m.rotation.y += (((M.state === 'search' ? M.ang + Math.sin(t * 1.3) * 1.2 : M.ang) - m.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 6);
  const sw = spd > 0 ? Math.sin(t * spd * 3.2) : Math.sin(t * 2) * .05;
  u.arms[0].rotation.x = sw * .5; u.arms[1].rotation.x = -sw * .5; u.legs[0].rotation.x = -sw * .35; u.legs[1].rotation.x = sw * .35;
  m.position.y = Math.abs(sw) * .04;
  // catch: it only needs to be this close
  if (dist < 1.25 && G.state === 'play') caught();
  // clicking: it echolocates, faster when it's nearer / hunting
  M.clickT -= dt;
  if (M.clickT <= 0) {
    const near = Math.min(1, dist / 22);
    M.clickT = (M.state === 'patrol' ? .9 : .5) * (.25 + .75 * near) + Math.random() * .15; sfx.click(A.monPan);
  }
  setPanPos(A.monPan, M.x, 1.6, M.z);
  // heartbeat
  if (dist < 14) { G.hb -= dt; if (G.hb <= 0) { G.hb = .35 + dist / 14 * .8; sfx.thump(); setTimeout(sfx.thump, 160); } }
  return dist;
}

function caught() {
  G.state = 'dead'; G.dead = 0; sfx.scare();
  const M = monster, m = M.mesh;
  m.position.set(P.x - Math.sin(P.yaw) * 1.0, 0, P.z - Math.cos(P.yaw) * 1.0); m.rotation.y = P.yaw + Math.PI; m.scale.setScalar(1.15);
  G.pings[0] = { x: cam.position.x, y: cam.position.y, z: cam.position.z - 0, age: .35 };
  shared.uPings.value[0].set(cam.position.x, cam.position.y, cam.position.z, .35);
  P.pitch = .25; cam.rotation.set(P.pitch, P.yaw, 0, 'YXZ');
  $('deadmsg').textContent = ['It was listening the whole time.', 'Your heartbeat was loud enough.', 'Silence is a kind of light.', 'It did not need eyes.'][rnd(4)];
}

function updatePearls(dt, t) {
  let nearest = null, nd = 1e9;
  const got = pearls.filter(p => p.got).length, allGot = got === PEARLS;
  for (const p of pearls) {
    if (p.got) continue;
    const d = Math.hypot(p.pos.x - P.x, p.pos.z - P.z);
    if (d < 1.1) { p.got = true; p.sprite.visible = false; sfx.pearl(); updateHud(); const left = PEARLS - (got + 1); say(left ? `Pearl taken. ${left} more… it's getting restless.` : 'All pearls taken. Return to the drain where you began.', 4); monster.state = 'investigate'; monster.target = { x: P.x, z: P.z }; monster.boost = 3; continue; }
    if (d < nd) { nd = d; nearest = p; }
    let flash = 0;
    for (const pg of G.pings) { const dd = Math.hypot(p.pos.x - pg.x, p.pos.z - pg.z), pass = pg.age - dd / PING_SPEED; if (pass > 0 && pass < 1.4 && dd < 32) flash = Math.max(flash, 1 - pass / 1.4); }
    p.sprite.material.opacity = Math.max(Math.max(0, 1 - d / 7) * (.55 + .45 * Math.sin(t * 4 + p.pos.x)), flash);
  }
  // hum + glow guide to nearest pearl (or the drain once all are taken)
  const tgt = allGot ? exitPos : nearest && nearest.pos;
  if (tgt) {
    const d = Math.hypot(tgt.x - P.x, tgt.z - P.z);
    setPanPos(A.pearlPan, tgt.x, 1, tgt.z); A.hum.frequency.value = allGot ? 196 : 330 + (1 - Math.min(1, d / 30)) * 180;
    A.humG.gain.value = Math.max(0, .5 * (1 - d / 32)) * .32 + .02;
    const k = Math.max(0, 1 - d / 9) * (.6 + .4 * Math.sin(t * 3));
    shared.uGlow.value[allGot ? 1 : 0].set(tgt.x, 1, tgt.z, k * (allGot ? 1.5 : 1));
    shared.uGlow.value[allGot ? 0 : 1].w = 0;
  }
  exitPos.beacon.material.opacity = allGot ? .6 + .4 * Math.sin(t * 3) : 0;
  if (allGot && Math.hypot(exitPos.x - P.x, exitPos.z - P.z) < 1.6 && G.state === 'play') { G.state = 'win'; sfx.win(); document.exitPointerLock(); show('win'); }
}

// ---------- main loop ----------
const clock = new THREE.Clock(); let T = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), .05);
  if (G.state === 'play' || G.state === 'dead') {
    T += dt; shared.uTime.value = T;
    if (G.state === 'play') {
      updatePlayer(dt); G.pingCd = Math.max(0, G.pingCd - dt);
      const dist = updateMonster(dt, T); updatePearls(dt, T); G.mapT = Math.max(0, G.mapT - dt); drawMinimap(T);
      $('noise').firstElementChild.nextElementSibling.firstElementChild.style.width = Math.min(100, G.noiseShow * 100) + '%';
      $('pingb').firstElementChild.nextElementSibling.firstElementChild.style.width = (1 - G.pingCd / PING_CD) * 100 + '%';
      if (G.msgT > 0 && (G.msgT -= dt) <= 0) $('say').style.opacity = 0;
    } else {
      G.dead += dt;
      cam.position.x = P.x + (Math.random() - .5) * .08; cam.position.y = 1.65 + (Math.random() - .5) * .08;
      if (G.dead > 1.6 && $('dead').classList.contains('hide')) { document.exitPointerLock(); show('dead'); }
    }
    // pings
    G.pings.forEach(p => { p.age += dt; });
    G.pings = G.pings.filter(p => p.age < PING_LIFE);
    for (let i = 0; i < 3; i++) { const p = G.pings[i], u = shared.uPings.value[i]; if (p) u.set(p.x, p.y, p.z, p.age); else u.w = -1; }
    shared.uPlayer.value.set(cam.position.x, cam.position.y, cam.position.z);
    if (A.ctx) updateListener();
  }
  renderer.render(scene, camera);
}
buildLevel(); frame();
