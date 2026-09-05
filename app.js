// 装配：config ← URL → field/world/colony → renderer → loop → 输入/inspector/panel/HUD。

import { SCHEMA, values, get, set, toQuery, applyQuery, seedFromQuery } from './core/config.js';
import { rng, hashSeed, randomSeed } from './core/rng.js';
import { Loop, paceText } from './core/loop.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';
import { SpatialHash } from './sim/spatialHash.js';
import { WebGL2Backend } from './render/webgl2.js';
import { Canvas2DBackend } from './render/canvas2d.js';
import { updateExposure, effPeak, exposure, resetExposure } from './render/exposure.js';
// P2.3.4 侧抑制: 屏幕该画什么、曝光该锚在什么上,都由这**一个**函数决定(见其注释)。
import { displayField, perception, resetPerception } from './render/perception.js';
import { Panel } from './ui/panel.js';
import { Inspector } from './ui/inspector.js';
// P2.4b 交互层四件套: 滑窗统计 / 场景预设 / 个体事件观察 / 曲线面板 + 录像。
// 共同点: **全部只读 sim**(见 stats_check S3「开着量具跑 ≡ 一次都不读」的逐位证明)。
import { ColonyStats, spark } from './core/stats.js';
import { PRESETS, presetById, applyPresetParams, buildPresetWorld, buildDefaultFoods, handFoodDose } from './core/presets.js';
import { AntObserver, EVENT_KINDS, eventKind } from './core/observe.js';
import { Graph } from './ui/graph.js';
import { Hud } from './ui/hud.js';
import { Recorder, recorderSupported, sizeText } from './ui/recorder.js';

const $ = (id) => document.getElementById(id);

// ---------- 可重建状态 ----------
let seed = (new URL(location.href)).searchParams.get('seed') || String(randomSeed());
let world, field, alarmField, colony, hash, stats;
// 昼夜与天气(P2.3): 环境层独立于 sim。两个开关都关时 envNow 恒为 null,
// sim/场 收到的算式与旧版逐位一致; 打开时也只改时长与衰减指数, 不碰蚂蚁随机流。
let weather = null, envNow = null;
const actHist = new Array(40).fill(1);   // HUD 活动度曲线(滚动缓冲, 每 10 步采一点)
// ---- P2.4b 交互层状态 ----
const statsWin = new ColonyStats({ stepHz: 60, periodSec: 1, cap: 60 });  // 最近 60 秒
const story = new AntObserver({ trailCap: 300, eventCap: 60, crumbEvery: 8 });
let presetId = null;        // null = 出厂默认布局(reset() 原样, 一个字节都不改)
let followIdx = -1;         // 跟随镜头指向的蚁号(-1 = 不跟随)
let simSec = 0;             // 仿真内时钟(秒): 曲线与事件时间轴都以它为准, 不用墙钟——倍速下两者差 64 倍

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
  const { r } = buildWorldParams();
  const nestR = get('nestRadius');
  colony = new Colony(get('antCount'), { rng: r, world, nestRadius: nestR });
  resetExposure(); resetPerception();   // 换一窝/换种子就把曝光表归零:上一窝的剂量水平对这一窝没有参考价值
  inspector && (inspector.colony = colony);
  // 出厂散粮(一近一主两块): 布局与剂量标定都在 core/presets.js 的 buildDefaultFoods 里, 与门禁同源。
  // ?food=<总剂量> 覆盖出厂总剂量(P2.4 的语义不变, 只是现在它管的是两块源的总量而不是那一块):
  // 个体路线记忆是个要看多日循环的慢变量, 食源先没了就只能看到路线废弃、看不到熟路复用。
  const FOOD0 = Number(new URLSearchParams(location.search).get('food'));
  buildDefaultFoods(world, r, FOOD0);
  stats = { firstFood: null, startT: performance.now(), loadedMax: 0 };
  // 换种子即换天气随机流: 同一个 seed 的风暴排期完全可复现
  weather = new Weather(seed);
  envNow = null;
  actHist.fill(1);
  // ---- P2.4b: 换一窝就把交互层的三块历史一起清掉 ----
  // 不清的后果不是崩, 是**假读数**: 曲线会把上一窝的卸货率接在这一窝的开头,
  // 跟拍的面包屑会指着上一窝那只蚁走过的路(同一只蚁的编号在两窝里是完全不同的两只)。
  simSec = 0;
  statsWin.reset();
  story.nestRadius = nestR;
  story.select(followIdx >= colony.population ? -1 : followIdx, colony);
  // 跟拍状态以观察器为准: 换一窝之后"第 7 号"是完全不同的另一只蚁, 跟不动就停镜头,
  // 不许默默跟着一个仍然在范围内的旧下标(那是把别人的故事安在它头上)。
  if (followIdx >= 0) {
    followIdx = story.idx;
    showToast(followIdx >= 0 ? "跟拍对象已随新 colony 重置" : "跟拍的那只蚁不在了, 镜头停下(G 跟下一只)");
  }
  // 预设布局在 reset 之后重放: reset() 会按出厂布局摆那块默认食源, 预设要把它换成自己的场景。
  if (presetId && presetId !== 'default') {
    const rep = buildPresetWorld(presetId, world);
    console.info(`预设 ${presetId} 重建: 墙 ${rep.wallCount} 格 · 食源 ${rep.foods} 块 · 剂量 ${rep.dose}`);
  }
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
  simSec += dt;               // 仿真内时钟: 曲线/事件时间轴用它, 不用墙钟(倍速下两者差 64 倍)
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
  // ---- P2.4b 量具: 每逻辑步读一次(stats/observe 都是只读, 见 stats_check S3 的逐位证明) ----
  statsWin.sample(colony, world);
  if (followIdx >= 0) {
    story.observe(colony, world, colony.stepCount, simSec);
    // 观察器按 uid 自己解析下标(P2.5): 被收尸压缩搬动 → story.idx 变了; 那只蚁死了 → 变成 -1。
    // 回读而不是各算各的, 免得"跟拍的那只"在镜头/检视面板/故事线三处指向三只不同的蚁。
    if (story.idx !== followIdx) {
      const gone = story.idx < 0;
      followIdx = story.idx;
      inspector.select(followIdx);
      if (gone) showToast('跟拍的那只蚁已经死了(镜头停下, G 可跟下一只)');
    }
  }
}

// ---------- 渲染装配 ----------
let canvas = $('canvas');
let backend;
// 兜底必须自报原因(P2.3.5 事故): 一个四参 max() 让 WebGL2 编译失败并被静默兜底, 而 console.warn 在浏览器里
// 没人看得见 —— 后端名会上 HUD 是 P2.3.1 立的规矩, 但只说「兜底」不说为什么, 等于让人自己去翻控制台。
let backendFail = '未尝试';
try {
  const w = new WebGL2Backend();
  if (w.init(canvas)) { backend = w; backendFail = ''; }
  else backendFail = w.failReason || 'init()=false';
} catch (err) {
  backendFail = String((err && err.message) || err).split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 70);
  console.warn('WebGL2 启动失败:', err);
}
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
const RENDER_BACKEND = backend instanceof Canvas2DBackend
  ? 'Canvas2D(兜底: ' + backendFail + ')'
  : 'WebGL2';
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
// P2.4b: HUD 换成分层组件(三层 + 每层只在自己变了的时候写 DOM)。
// 原来这里是每帧把 8 行拼成一个大字符串赋给 textContent——倍速时那是白送的一次整块重排。
const hud = new Hud(HUD);
const graph = new Graph(document.body, statsWin);
// 录像: 主画布 + 检视覆盖层合成成一路 webm(不录覆盖层的话, 跟拍视频里看不见面包屑)
const recorder = new Recorder(() => [canvas, inspector.cv]);

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
let renderScaleShown = 1;          // 真正生效的那一档(HUD 要报它, 不能报用户要的那一档)
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  const rs = effRenderScale();
  renderScaleShown = rs;
  // ⚠ 检视覆盖层【不跟着缩】: 它是文字与面包屑, 缩了会糊成一片, 而它的填充率只有主画布的零头。
  backend.resize(w, h, rs);
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

// ---------- 跟随镜头(P2.4b) ----------
// 相机是纯渲染层状态: 挪它不影响任何 sim 算术(perf_check 逐位不变已经证明)。
const FOLLOW_ZOOM = () => Math.min(60, Math.max(camera.zoom * 3.2, 1.4));
let followZoom = 0;
function setFollow(idx) {
  const n = idx === -1 ? -1 : (idx >= 0 && idx < colony.population ? idx : -1);
  followIdx = n;
  story.nestRadius = get('nestRadius');
  story.select(n, colony);            // 换对象即清历史(两只蚁的故事不许缝成一只)
  inspector.select(n);                // 检视与跟拍同一个对象: 面板读瞬时量, 时间线读故事
  if (n >= 0) {
    followZoom = FOLLOW_ZOOM();
    inspector.infoRight();
  }
  return n;
}
// 环面寻址是这里的关键细节: 世界是环面, 蚂蚁从 x=1990 迈一步到 x=2 是**正常走 straight**,
// 但按普通坐标差算相机要往回追 1988 个单位。所以位移一律取半宽内的最短差, 相机也按最短差插值。
function updateFollow(dt) {
  if (followIdx < 0 || followIdx >= colony.population) return;
  const W = get('worldW'), H = get('worldH');
  let dx = colony.px[followIdx] - camera.cx, dy = colony.py[followIdx] - camera.cy;
  if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
  if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
  const k = Math.min(1, dt * 6);          // 一阶跟随: 6/s 时间常数, 镜头「追」而不是「粘」
  camera.cx = (camera.cx + dx * k + W) % W;
  camera.cy = (camera.cy + dy * k + H) % H;
  if (followZoom > 0 && Math.abs(camera.zoom - followZoom) > 1e-3) {
    camera.zoom += (followZoom - camera.zoom) * Math.min(1, dt * 4);
  }
}

// ---------- URL 还原(先于 panel,让绑定反映 URL) ----------
applyQuery(new URLSearchParams(location.search));

// 只生效一次的调试读数(?food 加大开局食源 / ?inspect 指到某一只蚁)不属于参数面板, 但必须原样带回
// 新 URL: 否则刷新一次或点"复制分享链接", 花力气摆好的验收视角就没了。
const PASSTHROUGH = (() => {
  const known = new Set(SCHEMA.map((d) => d.key));
  const out = [];
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (k !== 'seed' && !known.has(k)) out.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return out;
})();
function buildHref() {
  const q = toQuery();
  return location.pathname + '?' + q + (q ? '&' : '') + PASSTHROUGH.concat('seed=' + seed).join('&');
}
function pushUrl() { history.replaceState(null, '', buildHref()); }

// ---------- inspector & panel ----------
const inspector = new Inspector(document.body, {
  colony, getTransform: worldToScreen, trailLen: 200,
  observer: story,
});

// ---------- 预设加载(P2.4b) ----------
// 顺序是这里的全部内容: 先撤上一个预设的参数增量并落下新的 → 记下当前预设 →
// reset()(它会按出厂方式重建 world/colony, 并在末尾重放当前预设的布局) → 同步面板与 URL。
// 为什么必须走 reset(): 换场景等于换一窝的命案现场, 留着上一场景铺好的走廊讲不出新故事。
function loadPreset(id, opts = {}) {
  const p = presetById(id);
  if (!p) { showToast(`没有这个预设: ${id}`); return false; }
  applyPresetParams(id);
  presetId = id;
  reset();
  refit();
  panel.syncValues();          // 参数增量要显示回滑杆, 否则面板写着 30 而仿真正在用 120
  panel.setPreset(id);
  pushUrl();
  if (!opts.quiet) {
    // 只**读**当下世界的布局做报告。这里绝不能再调一次 buildPresetWorld:
    // reset() 末尾已经重放过了, 再放一遍等于把同一堵墙重画一次, 报告还会把「重放」说成「新增」。
    let dose = 0;
    for (const f of world.foodPatches) if (f.amount > 0) dose += f.amount;
    showToast(`预设「${p.name}」已加载 · 墙 ${world.wallCount} 格 / 食源 ${world.foodPatches.length} 块 / 剂量 ${dose}\n${p.desc}`);
  }
  return true;
}

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
  onPreset(id) { loadPreset(id); },
  onFollow() { toggleFollow(); },
  onGraph() { toggleGraph(); },
  onRecord() { toggleRecord(); },
  // 与 H 键同语义: 不带参数进来就是「切下一档」(0→1→2→0)。若沿用 setLevel(undefined),
    // 面板按钮会把 HUD 打回「精简」而不是循环, 鼠标与键盘就不等价了。
    onHud() { showToast(`界面详略: ${hud.setLevel((hud.level + 1) % 3)}`); },
    onQuality() { cycleRenderScale(); },
});

// ---------- 初始化世界(inspector 已声明,reset 才能挂 colony) ----------
reset();
refit();
// ?inspect=N 直接检视第 N 只蚁(P2.4): 记忆航点链是个慢变量(要等这只蚁真的走完一趟并咬到食物
// 才提交路线), 手点验收很痛苦; 让 URL 就能指到某一只蚁, 截图验收与分享都方便。非法/越界静默忽略。
const QRY = new URLSearchParams(location.search);
// ---------- 出画分辨率(P2.4d · 倍速性能) ----------
// 为什么需要它: frame_check 量到渲染侧【JS】只有 0.47 ms/帧, 而浏览器里 64× 时一个 tick 的墙钟
// ≈ 47 ms(仿真预算 40 ms + 出画与合成 ~7 ms) ⇒ 贵的那一份不在 JS 里, 在 GPU 填充率与合成里,
// 无头量具看不见它。填充率 = 像素数, 所以「少画点像素」是唯一能量到它的开关。
// 语义: 1 = 出厂(与今天逐字节相同)。CSS 尺寸不变 ⇒ 鼠标换算不受影响; 录像会跟着降(诚实的代价)。
const RENDER_SCALE_Q = (() => {
  const raw = QRY.get('renderScale');
  const v = Number(raw);
  return raw !== null && Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
})();
// 面板/快捷键「画质 Q」的手动档(P2.4d): 0 = 没按过, 交给 URL 与自动档。为什么要能当场切:
// 出画分辨率是唯一砍得动 GPU 填充率的开关, 而它只藏在地址栏里等于没有 —— 倍速卡成 19 fps 时,
// 用户应该两秒内试出「少画一半像素能不能救回来」。三档循环, 最后一档回到 100%(=出厂)。
let renderScaleManual = 0;
const QUALITY_STEPS = [1, 0.75, 0.55];
function effRenderScale() {
  if (renderScaleManual) return renderScaleManual;    // 当场按的比 URL 新
  if (RENDER_SCALE_Q !== 1) return RENDER_SCALE_Q;      // URL 显式指定 ⇒ 一切照它(浏览器 A/B 用)
  // 自动档: 只在高 DPI 机器上收 —— 那里 backing store 是 CSS 尺寸的 dpr² 倍(2 倍屏 = 4 倍像素),
  // 倍速时把它压回 1 倍几乎看不出, 省下的填充率却是实打实的。dpr=1 的机器上这条是恒等式(实测本机 dpr=1)。
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return loop.timeScale >= 16 ? 1 / dpr : 1;
}
// 切一档出画分辨率, 并写回地址栏的 ?renderScale=: PASSTHROUGH 是开局对 location.search 拍的快照,
// 不改它的话「复制分享链接」会把这一档丢掉, 一次手调就变成不可复现的东西(能分享的才是证据)。
function cycleRenderScale() {
  const cur = effRenderScale();
  const at = QUALITY_STEPS.findIndex((v) => Math.abs(v - cur) < 0.02);
  renderScaleManual = QUALITY_STEPS[(at + 1) % QUALITY_STEPS.length];   // at=-1(自动档/怪值)回到 100%
  const pct = Math.round(renderScaleManual * 100);
  const px = Math.round(renderScaleManual * renderScaleManual * 100);
  const entry = "renderScale=" + renderScaleManual;
  const i = PASSTHROUGH.findIndex((s) => s.indexOf("renderScale=") === 0);
  if (i >= 0) PASSTHROUGH[i] = entry; else PASSTHROUGH.push(entry);
  pushUrl();
  resize();
  showToast(pct >= 100 ? '出画分辨率 100%(出厂画质, 逐像素)' : `出画分辨率 ${pct}%(像素量为出厂的 ${px}%, 再按 Q 回出厂)`);
}
// 注意必须先判参数存在: Number(null) 等于 0, 直接 Number() 会把「没带参数」当成「检视 0 号蚁」。
const INSPECT0 = QRY.get('inspect') === null ? -1 : Number(QRY.get('inspect'));
if (Number.isInteger(INSPECT0) && INSPECT0 >= 0 && INSPECT0 < colony.population) inspector.select(INSPECT0);
// ?preset=maze 让验收图/分享链接直接落在某个场景上; ?follow=N 直接跟拍第 N 只蚁。
// 两者都只在 URL 明确带着时才生效——不带就等于出厂路径, 一个字节都不变(红线 2)。
const PRESET0 = QRY.get('preset');
if (PRESET0) loadPreset(PRESET0);
const FOLLOW0 = QRY.get('follow') === null ? -1 : Number(QRY.get('follow'));
if (Number.isInteger(FOLLOW0) && FOLLOW0 >= 0 && FOLLOW0 < colony.population) setFollow(FOLLOW0);
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
    // 右键：移除/吃光食物, 顺带停掉跟拍(右键本来就是「取消选中」)
    if (world.removeFoodAt(wx, wy)) showToast('已移除食物');
    setFollow(-1);
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
  hash.build(colony.px, colony.py, colony.population);
  const nearR = Math.max(14 / camera.zoom, get('gridCell') * 2);
  const idx = hash.nearest(wx, wy, nearR);
  if (idx >= 0) {
    // P2.4b: 点中一只蚁 = 检视它 + 跟拍它 + 开始收它的事件。
    // 旧版只 select(): 想看清一只蚁怎么做决定, 得一边手动拖镜头一边凭记忆追——那正是跟拍镜头要解决的。
    setFollow(idx);
    showToast(`跟拍蚂蚁 #${idx}(G 或右键取消)`);
    setTimeout(() => inspector.record(), 0);
  } else {
    const dist = Math.hypot(wx - world.nestX, wy - world.nestY);
    if (dist > get('nestRadius') * 1.5) {
      world.addFood(wx, wy, 26, handFoodDose());     // 剂量与出厂近籽同源, 见 presets.js handFoodDose
      setFollow(-1);
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
  // 跟拍时手动缩放: 把自动推近的目标改成用户要的那一档。
  // 不改这一行, 下一次 updateFollow 会把镜头又拉回 FOLLOW_ZOOM——用户滚轮白滚(和"镜头粘住"一样难受)。
  if (followIdx >= 0) followZoom = nz;
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

// ---------- P2.4b 开关: 跟拍 / 曲线面板 / 录像 ----------
function toggleFollow() {
  if (followIdx >= 0) { setFollow(-1); showToast('已停止跟拍'); return; }
  const cand = inspector.observed;
  if (cand >= 0) { setFollow(cand); showToast(`跟拍蚂蚁 #${cand}`); return; }
  // 没有选中对象时挑「此刻正在负重的那只」: 空手在巢里打转的蚁讲不出故事(前几秒全是停顿),
  // 而负重蚁马上要回家——一跟就能看见「到家卸货」这个最该被看见的事件。
  hash.build(colony.px, colony.py, colony.population);
  let pick = -1;
  for (let i = 0; i < colony.population && pick < 0; i++) if (colony.load[i] > 0) pick = i;
  if (pick < 0) { showToast('暂时没有负重蚁可跟, 先点一只蚂蚁'); return; }
  setFollow(pick);
  showToast(`跟拍蚂蚁 #${pick}(G 或右键取消)`);
}
function toggleGraph() {
  graph.resize(window.devicePixelRatio || 1);
  graph.setVisible(!graph.visible);
  showToast(graph.visible ? '统计曲线: 最近 60 秒 (M 关)' : '统计曲线已隐藏(M 开)');
}
async function toggleRecord() {
  if (recorder.active) {
    const r = await recorder.stop({ preset: presetId || 'default', seed });
    // 读数只说编码器真收进的东西: frames=被投喂的帧数, drawn=合成画布被画几次;
    // 两者不等就是断流。P2.4c 在 iab 实测到旧写法报「175 帧 / 0.0 MB」而落盘只有 110 字节的空壳
    // (病根与修法见 ui/recorder.js 文件头 ⚠ 段)。
    if (r.ok) showToast(`录像已保存 ${r.file} · ${r.secs.toFixed(1)}s / 投喂 ${r.frames} 帧(合成 ${r.drawn} 次) / ${sizeText(r.bytes)} · ${r.feedMode} ${r.mime}`);
    else showToast(`录像没存成: ${r.reason} · 投喂 ${r.frames} 帧/合成 ${r.drawn} 帧 · ${r.feedMode} · ${r.mime || '无编码器'}`);
    return;
  }
  const r = recorder.start();
  if (r.ok) showToast(`开始录制(再按 V 停止并存成 webm) · 投喂方式 ${r.feedMode} · ${r.mime}`);
  else showToast(`这个环境录不了: ${r.reason}`);
}

window.addEventListener('keydown', (e) => {
  // 过滤框(P2.4d)是原生 <input>: 在里面打一个 f 不该把工具切成「食物」。快捷键只认非输入控件。
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  if (e.key === '/') {
    e.preventDefault();
    if (panel.focusFilter()) showToast('过滤参数: 打名字或说明里的词, Esc 退出');
    return;
  }
  const map = { '1': 0.125, '2': 1, '3': 4, '4': 64 };
  if (map[e.key]) { loop.setSpeed(map[e.key]); showToast(`速度 ${map[e.key]}x`); }
  if (e.key === '0') { loop.setSpeed(loop.timeScale ? 0 : 1); }
  if (e.key === 'f' || e.key === 'F') setTool('food');
  if (e.key === 'w' || e.key === 'W') setTool('wall');
  if (e.key === 'e' || e.key === 'E') setTool('erase');
  if (e.key === 'p' || e.key === 'P') setTool('predator');
  if (e.key === 'r' || e.key === 'R') doStorm();
  if (e.key === 'n' || e.key === 'N') doJumpClock();
  if (e.key === 'g' || e.key === 'G') toggleFollow();
  if (e.key === 'm' || e.key === 'M') toggleGraph();
  if (e.key === 'v' || e.key === 'V') toggleRecord();
  if (e.key === 'h' || e.key === 'H') showToast(`界面详略: ${hud.setLevel((hud.level + 1) % 3)}`);
  if (e.key === 'q' || e.key === 'Q') cycleRenderScale();
  if (e.key === 'x' || e.key === 'X') {
    const n = world.wallCount;
    world.clearWalls();
    if (n > 0) showToast(`墙已全部清除(当前预设的布局也一起没了, 要恢复就重新加载预设)`);
  }
});

// ---------- 主循环 ----------
let frameTime = 0;
let fitted = false;
const loop = new Loop({
  step: 1 / 60,
  // ?stepBudgetMs=<毫秒> 只为把 loop.js 文件头那条预算关系变成浏览器里可实扫的东西
  // (读 HUD 的 步/秒 与 达成 定预算档)。不带参数 = undefined = 走 Loop 出厂默认 12 ms, 一字不变;
  // 它不是 SCHEMA 参数, 由 PASSTHROUGH 原样带回分享链接。
  stepBudgetMs: (() => {
    const raw = QRY.get('stepBudgetMs');
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) && v > 0 ? v : undefined;
  })(),
  onStep: step,
  onFrame: (dt) => {
    if (!fitted && canvas.clientWidth > 0) { refit(); fitted = true; }
    resize();
    updateFollow(dt);
    renderFrame();
    graph.draw();
    composeHUD(dt);
    // 录像合成放在最后: 它要把这一帧刚画完的主画布与覆盖层一起读走(见 ui/recorder.js 文件头)
    recorder.frame();
  },
});
// 录像时不许跳帧: 合成层靠【这一帧刚画完的 drawing buffer】取图, 被跳过的帧在视频里就是断流。
// 非录像时才按 loop 的分档节流(倍速越高, 越该把毫秒买给仿真而不是买给画面)。
loop.forceRender = () => recorder.active;
// ?speed=<倍>(P2.4d): 让「倍速性能」的浏览器 A/B 可复现 —— 不带 = 出厂 1× 一个字都不变。
// 它不是 SCHEMA 参数, 由 PASSTHROUGH 原样带回分享链接(与 ?stepBudgetMs / ?renderScale 同一套脾气)。
const SPEED0 = (() => {
  const raw = QRY.get('speed');
  const v = Number(raw);
  return raw !== null && Number.isFinite(v) && v > 0 ? v : 0;
})();
if (SPEED0 > 0) { loop.setSpeed(SPEED0); showToast(`速度 ${SPEED0}×(来自 ?speed=)`); }
function renderFrame() {
  // 自适应曝光(P2.3.2): 每帧读一次蚁脚剂量,只读不写,不消耗随机流。
  // autoPeak=0 时 updateExposure 立刻返回、effPeak 退回滑杆 ⇒ 画面逐位不变。
  // P2.3.4: 先算出"这一帧要画的那份场"(lateralK=0 时它就是 field 本身),曝光锚点与后端
  // 共用同一个对象 ⇒ 锚点和画面量的是同一件事,不可能分叉。
  const disp = displayField(field);
  updateExposure(disp, colony, colony.stepCount / 60);
  backend.setCamera(camera.cx, camera.cy, camera.zoom);
  backend.render({
    field: disp, foodPatches: world.foodPatches,
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
// ---- P2.4b HUD 读数装配(旧版是每帧拼一大块 textContent, 现在交给 ui/hud.js 分层写) ----
// ctx 每帧现填, 但**只填一次**: hud 内部按节流 + 每层指纹决定是否真的写 DOM。
function hudCtx() {
  const ts = loop.timeScale;
  const p = presetById(presetId || 'default');
  const c = {
    fps: loop.fps,
    // 倍速是否名副其实只看这一行(P2.4c)。式子在 core/loop.js:paceText 里 —— 搬去那儿的原因是
    // 它在这里出过量纲错误: 初稿写成 步/秒 × 60, 于是 160 步/秒被印成 9600×(实际 2.7×)。
    // 抽成纯函数才能被 pace_check.mjs 直接对数字(浏览器里肉眼看不出这类错)。
    pace: paceText(loop),
    backend: RENDER_BACKEND,
    speed: ts === 0 ? '暂停' : ts + '×',
    speedLevel: ts === 0 ? '暂停' : ts + '×',
    // 出画分辨率 <1 时必须写在最亮那一层: 画面变糊是用户第一个会抱怨的东西, 而它是我自己开的
    renderPct: renderScaleShown < 0.999 ? Math.round(renderScaleShown * 100) + '%' : '',
    // P2.5: 种群读数 = 活蚁数; 容量单独给一行"上限", 不然用户以为 5000 这个数字在骗人
    pop: colony.population,
    popCap: colony.capacity,
    survOn: values.survivalMode > 0,
    births: colony.births, deaths: colony.deaths, starved: colony.starved, worn: colony.wornOut,
    loaded: colony.loadedCount(),
    delNow: statsWin.label('del'),
    firstFood: stats.firstFood === null ? '—' : stats.firstFood.toFixed(1) + 's',
    effPeak: values.autoPeak > 0.5
      ? `${effPeak().toFixed(2)}(自动 · 蚁脚中位 ${exposure.ref.toFixed(1)})`
      : `${effPeak().toFixed(2)}(手动滑杆)`,
    sensorMode: get('sensorMode') === 'physarum' ? 'physarum(三触角)' : 'diff(双触角)',
    tool: TOOL_LABEL[tool],
    walls: world.wallCount,
    predator: world.predator ? '就位' : '无',
    delTot: colony.deliveries, tot: colony.timeouts, abTot: colony.aborts, killTot: colony.kills,
    // P2.5 三本账(只在生死开着时进 HUD, 见 ui/hud.js): 入库/取食/产蚁耗/溢出 + 田外余粮 + 最低能量
    inflow: colony.inflow.toFixed(1), eaten: colony.foodEaten.toFixed(1),
    birthFood: colony.birthFood.toFixed(1), overflow: colony.overflow.toFixed(1),
    resNow: colony.reserve.toFixed(1),
    // 田外余粮走曲线量具的读数而不是再扫一遍 world: 它已经是"最近 1 秒的窗内均值",
    // 比瞬时值更适合给人看(而且省掉每帧一次 foodPatches 求和)。
    fieldFood: statsWin.label('food'),
    eMin: colony.eMin.toFixed(2),
    seed,
    preset: presetId || 'default',
    presetName: p ? p.name : '默认走廊',
    paramCount: SCHEMA.filter((s) => values[s.key] !== s.default).length,
    act: envNow ? envNow.emig : 1,
    actSpan: Math.round(actHist.length / 6),
    sparkDel: spark(statsWin.rings.del, 20),
    sparkLoad: spark(statsWin.rings.load, 20),
    sparkAb: spark(statsWin.rings.ab, 20),
    sparkFood: spark(statsWin.rings.food, 20),
    envLine: '',
    followLine: followIdx >= 0
      ? `跟拍 #${followIdx} · 已收 ${story.events.length} 条事件 · ${world.wallCount ? '本预设含墙' : ''}`
      : '',
  };
  // 环境读数(P2.3): 钟点按 dayLength 折算(phase 0=正午), 活性=出巢率乘子 emig, 曲线为其 40 点历史
  if (envNow) {
    const hour = (((envNow.phase + 0.5) % 1) * 24 + 24) % 24;
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const sky = envNow.rain > 0.02 ? `雨${Math.round(envNow.rain * 100)}%`
      : envNow.pre > 0.02 ? `低压${Math.round(envNow.pressure)}`
      : envNow.wind > 0.15 ? `风${Math.round(envNow.wind * 100)}%`
      : '晴';
    c.envLine = `昼夜天气 ${hh}:${mm} · ${envNow.temp.toFixed(1)}°C · ${sky}`;
    c.actSpark = sparkValues(actHist, 20, 3);
  }
  return c;
}

// 老的活动度数组(不是 Ring)也走同一套 sparkline 语法, 免得 HUD 里出现两种刻度规则。
function sparkValues(arr, width, refMax) {
  const n = arr.length;
  const start = n > width ? n - width : 0;
  let s = '';
  for (let i = start; i < n; i++) {
    const v = refMax > 0 ? arr[i] / refMax : 0;
    s += '▁▂▄▆█'[v <= 0 ? 0 : v < 0.25 ? 1 : v < 0.5 ? 2 : v < 0.75 ? 3 : 4];
  }
  return s;
}

function composeHUD(dt) {
  hud.update(hudCtx(), dt);
}
// 启动
window.addEventListener('resize', resize);
resize();
loop.start();
