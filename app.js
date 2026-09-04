// 装配：config ← URL → field/world/colony → renderer → loop → 输入/inspector/panel/HUD。

import { SCHEMA, values, get, set, toQuery, applyQuery, seedFromQuery } from './core/config.js';
import { rng, hashSeed, randomSeed } from './core/rng.js';
import { Loop } from './core/loop.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { SpatialHash } from './sim/spatialHash.js';
import { WebGL2Backend } from './render/webgl2.js';
import { Canvas2DBackend } from './render/canvas2d.js';
import { Panel } from './ui/panel.js';
import { Inspector } from './ui/inspector.js';

const $ = (id) => document.getElementById(id);

// ---------- 可重建状态 ----------
let seed = (new URL(location.href)).searchParams.get('seed') || String(randomSeed());
let world, field, colony, hash, stats;

function buildWorldParams() {
  const w = get('worldW'), h = get('worldH'), cell = get('gridCell');
  world = new World(w, h);
  field = new Field(w, h, cell);
  hash = new SpatialHash(Math.max(40, cell * 6), w, h);
  return { r: rng(hashSeed(seed)), w, h };
}

function reset() {
  const { r, w, h } = buildWorldParams();
  const nestR = get('nestRadius');
  colony = new Colony(get('antCount'), { rng: r, world, nestRadius: nestR });
  inspector && (inspector.colony = colony);
  // 默认放一块离巢适当距离的食物，方便一进来就看到成道
  const fx = w * (0.55 + r() * 0.2);
  const fy = h * (0.55 + r() * 0.2);
  world.addFood(fx, fy, 30, 200);
  stats = { firstFood: null, startT: performance.now(), loadedMax: 0 };
}

function step(dt) {
  // 信息素扩散/衰减
  field.step(get('diffuseWeight'), Math.pow(get('decayRate'), dt));
  // 蚂蚁推进
  colony.step(field, world, values, dt);
  // 首次发现食物计时
  if (stats.firstFood === null && colony.firstFoodAnt >= 0) {
    stats.firstFood = (performance.now() - stats.startT) / 1000;
  }
  if (colony.firstFoodAnt >= 0) {
    stats.loadedMax = Math.max(stats.loadedMax, colony.loadedCount());
  }
}

// ---------- 渲染装配 ----------
const canvas = $('canvas');
let backend;
try {
  const w = new WebGL2Backend();
  if (w.init(canvas)) backend = w;
} catch (err) { console.warn('WebGL2 启动失败:', err); }
if (!backend) {
  const c = new Canvas2DBackend();
  c.init(canvas);
  backend = c;
}

const HUD = $('hud');
const toast = $('toast');
let toastTimer = 0;
function showToast(msg) {
  toast.textContent = msg;
  toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.style.opacity = 0), 1800);
}

// ---------- 相机 ----------
const camera = { cx: get('worldW') / 2, cy: get('worldH') / 2, zoom: 0.5 };
let fitZoom = 0.5;
function refit() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  fitZoom = Math.min(w / get('worldW'), h / get('worldH')) * 0.92;
  camera.zoom = fitZoom;
  camera.cx = get('worldW') / 2;
  camera.cy = get('worldH') / 2;
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  backend.resize(w, h);
  inspector.resize(w, h);
}
function worldToScreen(x, y) {
  return [(x - camera.cx) * camera.zoom + canvas.clientWidth / 2,
          (y - camera.cy) * camera.zoom + canvas.clientHeight / 2];
}
function screenToWorld(sx, sy) {
  return [(sx - canvas.clientWidth / 2) / camera.zoom + camera.cx,
          (sy - canvas.clientHeight / 2) / camera.zoom + camera.cy];
}

// ---------- URL 还原(先于 panel,让绑定反映 URL) ----------
applyQuery(new URLSearchParams(location.search));

function buildHref() {
  const q = toQuery();
  return location.pathname + '?' + q + (q ? '&' : '') + 'seed=' + seed;
}
function pushUrl() { history.replaceState(null, '', buildHref()); }

// ---------- inspector & panel ----------
const inspector = new Inspector(document.body, {
  colony, getTransform: worldToScreen, trailLen: 200,
});

const panel = new Panel({
  onChange() {
    // 结构性参数变化需要重建
    if (['worldW', 'worldH', 'gridCell', 'antCount'].includes(arguments[0])) {
      reset();
      refit();
    }
    pushUrl();
  },
  onResetStats() {
    stats.firstFood = null; stats.startT = performance.now(); stats.loadedMax = 0;
    showToast('搜索计时已清零');
  },
  onSeed() {
    seed = String(randomSeed());
    reset(); refit();
    pushUrl();
  },
  onShare() {
    navigator.clipboard.writeText(location.origin + buildHref()).then(
      () => showToast('分享链接已复制'),
      () => showToast('复制失败')
    );
  },
});

// ---------- 初始化世界(inspector 已声明,reset 才能挂 colony) ----------
reset();
refit();
pushUrl();

// ---------- 输入 ----------
let dragging = false, moved = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => {
  dragging = true; moved = false;
  lastX = e.clientX; lastY = e.clientY;
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  camera.cx -= dx / camera.zoom;
  camera.cy -= dy / camera.zoom;
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (moved) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  if (e.button === 2 || e.ctrlKey) {
    // 右键：移除/吃光食物
    if (world.removeFoodAt(wx, wy)) showToast('已移除食物');
    inspector.select(-1);
    return;
  }
  // 左键：先找蚂蚁检视，没有就放食物
  hash.build(colony.px, colony.py, colony.count);
  const nearR = Math.max(14 / camera.zoom, get('gridCell') * 2);
  const idx = hash.nearest(wx, wy, nearR);
  if (idx >= 0) {
    inspector.select(idx);
    setTimeout(() => inspector.record(), 0);
  } else {
    const dist = Math.hypot(wx - world.nestX, wy - world.nestY);
    if (dist > get('nestRadius') * 1.5) {
      world.addFood(wx, wy, 26, 120);
      inspector.select(-1);
    } else {
      showToast('太靠近巢了，往远点放');
    }
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.pow(1.0015, -e.deltaY);
  const nz = camera.zoom * factor;
  if (nz < fitZoom * 0.3 || nz > fitZoom * 60) return;
  const [mx, my] = screenToWorld(e.clientX, e.clientY);
  camera.zoom = nz;
  // 保持鼠标下的世界点不动
  const [sx, sy] = screenToWorld(e.clientX, e.clientY);
  camera.cx += mx - sx; camera.cy += my - sy;
}, { passive: false });

// 键盘：1/2/3/4 = 1/8·1·4·64 倍速, 0 = 暂停/继续
window.addEventListener('keydown', (e) => {
  const map = { '1': 0.125, '2': 1, '3': 4, '4': 64 };
  if (map[e.key]) { loop.setSpeed(map[e.key]); showToast(`速度 ${map[e.key]}x`); }
  if (e.key === '0') { loop.setSpeed(loop.timeScale ? 0 : 1); }
});

// ---------- 主循环 ----------
let frameTime = 0;
let fitted = false;
const loop = new Loop({
  step: 1 / 60,
  onStep: step,
  onFrame: (dt) => {
    if (!fitted && canvas.clientWidth > 0) { refit(); fitted = true; }
    resize();
    renderFrame();
    composeHUD();
  },
});
function renderFrame() {
  backend.setCamera(camera.cx, camera.cy, camera.zoom);
  backend.render({
    field, foodPatches: world.foodPatches,
    nestX: world.nestX, nestY: world.nestY, nestRadius: get('nestRadius'),
    colony,
  });
  inspector.record();
  inspector.draw();
  frameTime = loop.fps;
}
function composeHUD() {
  const speed = loop.timeScale === 0 ? '暂停' : loop.timeScale + 'x';
  const loaded = colony.loadedCount();
  const mode = get('sensorMode') === 'physarum' ? 'physarum(三触角)' : 'diff(双触角)';
  HUD.textContent =
    `Antworld · fps ${loop.fps.toFixed(0)}\n` +
    `蚂蚁 ${colony.count} · 负重 ${loaded} · 空手返巢 ${colony.aborts} · 感知 ${mode}\n` +
    `首次发现食物 ${stats.firstFood === null ? '—' : stats.firstFood.toFixed(1) + 's'}\n` +
    `速度 ${speed}  (1/2/3/4   0=暂停)\n` +
    `左键:点击蚂蚁检视 / 空地放食物  右键:移除食物  滚轮:缩放\n` +
    `seed ${seed.slice(0, 10)}`;
}

// 启动
window.addEventListener('resize', resize);
resize();
loop.start();