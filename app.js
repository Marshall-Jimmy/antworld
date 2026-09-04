// 装配：config ← URL → field/world/colony → renderer → loop → 输入/inspector/panel/HUD。

import { SCHEMA, values, get, set, toQuery, applyQuery, seedFromQuery } from './core/config.js';
import { rng, hashSeed, randomSeed } from './core/rng.js';
import { Loop } from './core/loop.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';
import { SpatialHash } from './sim/spatialHash.js';
import { WebGL2Backend } from './render/webgl2.js';
import { Canvas2DBackend } from './render/canvas2d.js';
import { Panel } from './ui/panel.js';
import { Inspector } from './ui/inspector.js';

const $ = (id) => document.getElementById(id);

// ---------- 可重建状态 ----------
let seed = (new URL(location.href)).searchParams.get('seed') || String(randomSeed());
let world, field, alarmField, colony, hash, stats;
// 昼夜与天气(P2.3): 环境层独立于 sim。两个开关都关时 envNow 恒为 null,
// sim/场 收到的算式与旧版逐位一致; 打开时也只改时长与衰减指数, 不碰蚂蚁随机流。
let weather = null, envNow = null;
const actHist = new Array(40).fill(1);   // HUD 活动度曲线(滚动缓冲, 每 10 步采一点)

function buildWorldParams() {
  const w = get('worldW'), h = get('worldH'), cell = get('gridCell');
  // world.cell 与 field.cellSize 保持一致: 墙掩码/渲染/查询全部对齐同一套格子
  world = new World(w, h, cell);
  field = new Field(w, h, cell);
  alarmField = new Field(w, h, cell);   // 报警信息素场(P2.2): 同网格独立衰减, 危险过去几秒即散
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
  // 换种子即换天气随机流: 同一个 seed 的风暴排期完全可复现
  weather = new Weather(seed);
  envNow = null;
  actHist.fill(1);
}

// 报警信息素活动门控(P2.2): 有捕食者、或最近 100s 内有捕杀喷溅才推进 alarm 场。
// 报警源只有捕杀喷溅, 无新喷溅后 field 自行衰减(半衰期 ~13s, 散尽约 1 分钟)——
// 门控只负责散尽后停掉空转。关闭时 colony.step 收到 null alarmField:
// sim 层零开销、行为与 P2.1 完全一致。
const ALARM_LINGER = 6000; // 100s @60Hz: 覆盖报警从喷溅到散尽的全过程
function alarmActive() {
  return !!world.predator || colony.stepCount - colony.lastAlarmStep < ALARM_LINGER;
}

function step(dt) {
  // 环境层推进(每逻辑步一次)。关闭时不构造对象, 也不掷任何随机数。
  envNow = weatherActive(values) ? weather.step(dt, values) : null;
  if (envNow && colony.stepCount % 10 === 0) {
    actHist.copyWithin(0, 1);
    actHist[actHist.length - 1] = envNow.emig;
  }
  // 雨水/风对信息素场是**时间加速器**: 衰减指数乘 wash, 场值连续塌落而非一步抹平。
  // wash=1 时 dt*1 === dt 精确成立, 未开天气 → pow 结果 bit 级不变。
  const wash = envNow ? envNow.wash : 1;
  // 信息素扩散/衰减(有墙时把墙格清零——信息素不渗不透墙)
  const hot = alarmActive();
  field.step(get('diffuseWeight'), Math.pow(get('decayRate'), dt * wash),
             world.wallCount > 0 ? world.walls : null);
  if (hot) {
    alarmField.step(get('diffuseWeight'), Math.pow(get('alarmDecay'), dt * wash),
                    world.wallCount > 0 ? world.walls : null);
  }
  // 蚂蚁推进(alarm 未启用时传 null: 不采样不沉积, bit 级等价旧机制)
  colony.step(field, world, values, dt, hot ? alarmField : null, envNow);
  // 首次发现食物计时
  if (stats.firstFood === null && colony.firstFoodAnt >= 0) {
    stats.firstFood = (performance.now() - stats.startT) / 1000;
  }
  if (colony.firstFoodAnt >= 0) {
    stats.loadedMax = Math.max(stats.loadedMax, colony.loadedCount());
  }
}

// ---------- 渲染装配 ----------
let canvas = $('canvas');
let backend;
try {
  const w = new WebGL2Backend();
  if (w.init(canvas)) backend = w;
} catch (err) { console.warn('WebGL2 启动失败:', err); }
if (!backend) {
  // 画布一旦拿到过 webgl2 上下文, 再要 getContext('2d') 永远返回 null(规范行为):
  // 兜底必须换一块干净的画布, 否则任何 WebGL 故障都会变成整屏黑 + fillStyle 崩溃。
  const fresh = document.createElement('canvas');
  fresh.id = canvas.id;
  canvas.replaceWith(fresh);
  canvas = fresh;
  const c = new Canvas2DBackend();
  c.init(canvas);
  backend = c;
}
// 渲染层必须自证(P2.3.1 教训15): P2.3 起 6 处 `uniform vec3 uAmbient;;` 让 WebGL2 编译失败并被静默兜底,
// 期间浏览器里跑的一直是 Canvas2D 兜底(而兜底又因画布已被占用而黑屏)。无 warn 不等于活着: 后端名直接上 HUD。
const RENDER_BACKEND = backend instanceof Canvas2DBackend ? 'Canvas2D(兜底)' : 'WebGL2';
console.info(`渲染后端: ${RENDER_BACKEND}`);

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
  onStorm() { doStorm(); },
  onJumpClock() { doJumpClock(); },
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
// 工具(P2.1/P2.2): food=左键检视/放食物(默认), wall=左键拖动画墙, erase=左键拖动擦墙,
// predator=左键单击放置/移除捕食者。右键拖动任何模式下都平移; 右键单击仍是移除食物。
let tool = 'food';
const TOOL_LABEL = { food: '食物', wall: '画墙', erase: '擦墙', predator: '捕食者' };
const WALL_BRUSH = 22;   // 墙刷半径(世界单位) ≈ 5~6 格宽, 蚂蚁不会从对角缝里挤过去
const PREDATOR_R = 45;   // 捕食者捕杀半径(世界单位)
function setTool(t) { tool = t; showToast(`工具: ${TOOL_LABEL[t]}(F/W/E/P 切换, X 清墙)`); }

let dragging = false, moved = false, lastX = 0, lastY = 0;
let painting = false, lastWX = 0, lastWY = 0;
canvas.addEventListener('mousedown', (e) => {
  dragging = true; moved = false;
  lastX = e.clientX; lastY = e.clientY;
  if (e.button === 0 && (tool === 'wall' || tool === 'erase')) {
    painting = true;
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    lastWX = wx; lastWY = wy;
    world.paintWall(wx, wy, WALL_BRUSH, tool === 'wall');
  }
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (painting) {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    // 沿拖动轨迹插值补点(步长≈刷子半径/2), 快速甩动不留断口
    const d = Math.hypot(wx - lastWX, wy - lastWY);
    const steps = Math.max(1, Math.ceil(d / (WALL_BRUSH * 0.5)));
    const on = tool === 'wall';
    for (let k = 1; k <= steps; k++) {
      world.paintWall(lastWX + (wx - lastWX) * k / steps,
                      lastWY + (wy - lastWY) * k / steps, WALL_BRUSH, on);
    }
    lastWX = wx; lastWY = wy;
    moved = true;
    return;
  }
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  camera.cx -= dx / camera.zoom;
  camera.cy -= dy / camera.zoom;
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (painting) { painting = false; return; }
  if (moved) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  if (e.button === 2 || e.ctrlKey) {
    // 右键：移除/吃光食物
    if (world.removeFoodAt(wx, wy)) showToast('已移除食物');
    inspector.select(-1);
    return;
  }
  if (tool === 'predator') {
    // 捕食者: 单击切换。就位后半径内蚂蚁被捕杀并原地喷报警信息素。
    if (world.predator) { world.removePredator(); showToast('捕食者已移除,险情将在几秒内消散'); }
    else { world.placePredator(wx, wy, PREDATOR_R); showToast('捕食者已就位:半径内蚂蚁被捕杀'); }
    return;
  }
  if (tool !== 'food') return;   // wall/erase 的单击已在 mousedown 处理
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

// 键盘：1/2/3/4 = 1/8·1·4·64 倍速, 0 = 暂停/继续, F/W/E/P = 切工具, X = 清墙
// R=来一场雨, N=把时钟推到对面。按钮与快捷键走同两个函数, 保证行为一致。
// 刻意不改参数值: 参数只由面板与 URL 拥有, 按键顺手改会和分享链接不一致。
function doStorm() {
  if (get('weather') <= 0) { showToast('先把「天气强度」调到 >0,再按 R'); return; }
  showToast(weather.forceStorm(values)
    ? '气压开始下跌——约 40 秒后起雨,看蚂蚁抢收'
    : '已经在这场风暴里了');
}
function doJumpClock() {
  if (get('dayNight') <= 0) { showToast('先把「昼夜节律强度」调到 >0,再按 N'); return; }
  weather.jumpClock();
  showToast('时钟推到对面: 昼行↔夜行互换');
}

window.addEventListener('keydown', (e) => {
  const map = { '1': 0.125, '2': 1, '3': 4, '4': 64 };
  if (map[e.key]) { loop.setSpeed(map[e.key]); showToast(`速度 ${map[e.key]}x`); }
  if (e.key === '0') { loop.setSpeed(loop.timeScale ? 0 : 1); }
  if (e.key === 'f' || e.key === 'F') setTool('food');
  if (e.key === 'w' || e.key === 'W') setTool('wall');
  if (e.key === 'e' || e.key === 'E') setTool('erase');
  if (e.key === 'p' || e.key === 'P') setTool('predator');
  if (e.key === 'r' || e.key === 'R') doStorm();
  if (e.key === 'n' || e.key === 'N') doJumpClock();
  if (e.key === 'x' || e.key === 'X') {
    const n = world.wallCount;
    world.clearWalls();
    if (n > 0) showToast('墙已全部清除');
  }
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
    // 障碍墙(P2.1): 有墙才传, 后端按 wallVersion 缓存顶点
    walls: world.wallCount > 0
      ? { buf: world.walls, gw: world.gw, gh: world.gh, cell: world.cell, count: world.wallCount, version: world.wallVersion }
      : null,
    // 报警信息素(P2.2): 活动时叠一层红色, 静默时不传
    alarm: alarmActive() ? { field: alarmField, peak: get('alarmPeak') } : null,
    // 捕食者(P2.2): 红圈实体
    predator: world.predator ? { x: world.predator.x, y: world.predator.y, r: world.predator.r } : null,
    // 昼夜与天气(P2.3): 后端据此做环境光染色 + 雨丝。null = 完全不改变画面。
    env: envNow ? {
      tint: envNow.tint, rain: envNow.rain, wind: envNow.wind, windDir: envNow.windDir,
      light: envNow.light, t: colony.stepCount / 60,
    } : null,
  });
  inspector.record();
  inspector.draw();
  frameTime = loop.fps;
}
function composeHUD() {
  const speed = loop.timeScale === 0 ? '暂停' : loop.timeScale + 'x';
  const loaded = colony.loadedCount();
  const mode = get('sensorMode') === 'physarum' ? 'physarum(三触角)' : 'diff(双触角)';
  // 环境读数: 钟点按 dayLength 折算(phase 0=正午), 活性=出巢率乘子 emig, 曲线为其 40 点历史
  let wxLine = '';
  if (envNow) {
    const hour = (((envNow.phase + 0.5) % 1) * 24 + 24) % 24;
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const sky = envNow.rain > 0.02 ? `雨${Math.round(envNow.rain * 100)}%`
      : envNow.pre > 0.02 ? `低压${Math.round(envNow.pressure)}`
      : envNow.wind > 0.15 ? `风${Math.round(envNow.wind * 100)}%`
      : '晴';
    let spark = '';
    for (let i = 0; i < actHist.length; i++) {
      const v = Math.min(1, Math.max(0, actHist[i] / 3));
      spark += '▁▂▄▆█'[v < 0.25 ? 0 : v < 0.45 ? 1 : v < 0.65 ? 2 : v < 0.85 ? 3 : 4];
    }
    wxLine = `时刻 ${hh}:${mm} · ${envNow.temp.toFixed(1)}°C · 活性 ${envNow.emig.toFixed(2)}× · ${sky}\n` +
             `${spark}  (R=来一场雨 N=推时钟)\n`;
  }
  HUD.textContent =
    `Antworld · fps ${loop.fps.toFixed(0)} · 渲染 ${RENDER_BACKEND}\n` +
    wxLine +
    `蚂蚁 ${colony.count} · 负重 ${loaded} · 空手返巢 ${colony.aborts} · 感知 ${mode}` +
    (colony.kills > 0 ? ` · 被捕杀 ${colony.kills}` : '') + `\n` +
    `首次发现食物 ${stats.firstFood === null ? '—' : stats.firstFood.toFixed(1) + 's'}\n` +
    `速度 ${speed}  (1/2/3/4   0=暂停)\n` +
    `工具 ${TOOL_LABEL[tool]}(F/W/E/P) · 墙 ${world.wallCount} 格(X清墙)` +
    (world.predator ? ` · 捕食者就位` : '') + `\n` +
    `左键:检视/放食物/画墙/捕食者  右键:移除食物·拖动平移  滚轮:缩放\n` +
    `seed ${seed.slice(0, 10)}`;
}

// 启动
window.addEventListener('resize', resize);
resize();
loop.start();
