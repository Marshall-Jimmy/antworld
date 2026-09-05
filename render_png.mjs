// 临时可视化：把 headless 跑出的 sim 状态渲染成 PNG（验证走廊/蚂蚁/巢/食物的画面对不对）。
// 仅用于交付附带的验收截图，非应用本体。
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { values } from './core/config.js';
import { tone, rampLut, lutIndex, rampColor, FIELD_STOPS, ALARM_STOPS } from './render/palette.js';
import { PAPER, TRAIL_STOPS, ALARM_INK_STOPS, inkCoverage, antCoverage, antLod, antVar, CHITIN, CRUMB_RGB, SHEEN_GAIN, foodCoverage, foodRadius, FOOD_HULL, FOOD_FLESH } from './render/look.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';
import { updateExposure, effPeak, exposure } from './render/exposure.js';
import { displayField } from './render/perception.js';
import { applyPresetParams, buildPresetWorld } from './core/presets.js';

// ---- 跑 SIM(默认 40s; RENDER_SECS 可覆盖) ----
const seed = 'render';
const SIM_T = Number(process.env.RENDER_SECS || 40);
const OUT_NAME = process.env.RENDER_OUT || 'corridor.png';
// PARAMS=k=v,k=v 覆盖任意参数(A/B 对比用; 非数值串原样保留给枚举/布尔)
if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    values[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}
const r = rng(hashSeed(seed));
const w = values.worldW, h = values.worldH;
const world = new World(w, h, values.gridCell);
const field = new Field(w, h, values.gridCell);
const alarmField = new Field(w, h, values.gridCell);
const fx = w * 0.62, fy = h * 0.62;
// FOOD=<单位> 加大食源: 默认 200 保持旧截图逐位不变; 昼夜/风暴对比图要跑 150s+,
// 200 单位会在半分钟内被 5000 只蚁吃空(实测卸货恒定卡在 311 = 食源上限), 画面会误判成"蚁群崩盘"。
world.addFood(fx, fy, 30, Number(process.env.FOOD || 200));
// PRED=1 → 捕食者放在巢→食物直线中点; PRED=x,y → 指定坐标(世界单位)。放它才启用 alarm。
if (process.env.PRED) {
  let pxx, pyy;
  if (process.env.PRED.includes(',')) {
    [pxx, pyy] = process.env.PRED.split(',').map(Number);
  } else {
    pxx = (world.nestX + fx) / 2; pyy = (world.nestY + fy) / 2;
  }
  world.placePredator(pxx, pyy, 45);
}
// WALL=bar → 在巢(中心)与食物之间立一道竖墙, 顶部留 22% 高的缺口(验收绕行画面)
if (process.env.WALL === 'bar') {
  const wx = w * 0.56;
  for (let y = 0; y <= h; y += 6) {
    if (y > h * 0.08 && y < h * 0.30) continue;   // 缺口
    world.paintWall(wx, y, 14, true);
  }
}
// PRESET=<id> → 用 P2.4b 的场景预设出图。放在 Colony 构造之前: 预设改的是参数(forage/carryTimeout)
// 与布局, 而 Colony 构造要按 nestRadius 摆一窝蚁——顺序反了就会出现「图是迷宫的、蚁是按出厂参数出生的」。
// 也正因为 buildPresetWorld 不碰 r, 这块与上面 WALL=bar / PRED 两个旧开关互不干扰。
const PRESET = process.env.PRESET;
if (PRESET && PRESET !== 'default') {
  applyPresetParams(PRESET);
  const rep = buildPresetWorld(PRESET, world);
  console.log(`预设 ${PRESET}: 墙 ${rep.wallCount} 格 · 食源 ${rep.foods} 块 · 总剂量 ${rep.dose}`);
}
const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });
const dt = 1 / 60;
// 昼夜与天气(P2.3)出图开关(环境变量, 参数本身走 PARAMS=dayNight=1 / weather=1):
//   WX_STORM=1 (或 RAIN=1) → 开场就排雨; WX_STORM_AT=<秒> → 先跑熟路网再排雨。
//     风暴自带 40s 低压前置: AT=120 → 158s 截"雨前涌出"(rush≈2.7), 180s 截"满雨冲刷"(雨势平台 168-192s)
//   WX_JUMP=1 → 把内源钟推半周期(N 键路径): dayLength=240 跑 360s, 无偏移截午夜、加偏移截正午
const weather = new Weather(seed);
const wxStormAt = process.env.WX_STORM_AT !== undefined ? Number(process.env.WX_STORM_AT)
  : (process.env.WX_STORM === '1' || process.env.RAIN === '1') ? 0 : -1;
if (process.env.WX_JUMP === '1') weather.jumpClock();
let envNow = null;
for (let t = 0; t < SIM_T * 60; t++) {
  if (t === wxStormAt * 60) weather.forceStorm(values);   // 已在风暴窗口里时 forceStorm 自己返回 false
  // 与 app.js step() 同一套编排: env 仅在开关打开时构造(关闭=null), 场衰减压 wash 指数
  // (dt*1===dt 精确成立), 所以未开天气的旧截图逐位不变。
  envNow = weatherActive(values) ? weather.step(dt, values) : null;
  const wash = envNow ? envNow.wash : 1;
  field.step(values.diffuseWeight, Math.pow(values.decayRate, dt * wash),
             world.wallCount > 0 ? world.walls : null);
  // 报警场(P2.2): 有捕食者才推进(与 app 门控同义, 渲染脚本恒热)
  if (world.predator) {
    alarmField.step(values.diffuseWeight, Math.pow(values.alarmDecay, dt * wash),
                    world.wallCount > 0 ? world.walls : null);
  }
  colony.step(field, world, values, dt, world.predator ? alarmField : null, envNow);
}
// 自适应曝光(P2.3.2): 截图前按「蚁脚剂量中位数」定一次参考浓度。
// 与 app 的区别:headless 没有逐帧滤波的过程可复现,直接落位即等价于跑满时间常数。
// P2.3.4: 与 app 同源——截图画的和截图定曝光用的是**同一个**对象(lateralK=0 时即 field 本身)
const disp = displayField(field);
updateExposure(disp, colony, SIM_T);

// ---- 渲染 ----
const SCALE = Number(process.env.SCALE || 0.4);   // 世界→图像像素
// CROP=x0,y0,x1,y1(世界单位)出特写: 蚂蚁/食物的细节在 800x520 的全景里根本判不出来。
// 注意语义: antLen 是**屏幕像素**, 而屏幕对应一个参考缩放 ZOOM_REF(≈1600px 宽的画布装下 2000u 世界),
// 所以蚁的世界体长 = antLen/ZOOM_REF。SCALE 调大 = 相机推近 = 蚁在图上更大, 与浏览器里一致。
const ZOOM_REF = 0.8;
const CROP = (process.env.CROP || "").split(",").map(Number);
const hasCrop = CROP.length === 4 && CROP.every((v) => Number.isFinite(v));
const cx0 = hasCrop ? CROP[0] : 0, cy0 = hasCrop ? CROP[1] : 0;
const cx1 = hasCrop ? CROP[2] : w, cy1 = hasCrop ? CROP[3] : h;
const W = Math.round((cx1 - cx0) * SCALE), H = Math.round((cy1 - cy0) * SCALE);
const png = new PNG({ width: W, height: H });
const data = png.data;
function px(x, y, rgb, a = 255) {
  // 世界坐标 → 图像坐标（y 翻转使向上为北）
  const ix = Math.round((x - cx0) * SCALE), iy = Math.round((cy1 - y) * SCALE);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const o = (iy * W + ix) * 4;
  const nb = 1 - a / 255;
  data[o] = data[o] * nb + rgb[0] * a / 255;
  data[o + 1] = data[o + 1] * nb + rgb[1] * a / 255;
  data[o + 2] = data[o + 2] * nb + rgb[2] * a / 255;
  data[o + 3] = 255;
}
// 环境光(P2.3): 出射色逐通道乘 tint —— 与 WebGL 的 uAmbient、canvas2d 的 rgba(c,a,amb) 同一套色温
// (午夜冷蓝 → 晨昏暖金 → 正午白, 雨天再压暗偏冷)。amb=null 时恒等, 未开天气的旧截图逐位不变。
const amb = envNow ? envNow.tint : null;
function tintArr(c) { return amb ? [c[0] * amb[0], c[1] * amb[1], c[2] * amb[2]] : c; }
// 与 canvas2d/FS_RAIN 同构的整数哈希: 同一个格子永远同一根雨丝, 不会逐帧闪烁
function hash21(ix, iy, seed) {
  let n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function fract(x) { return x - Math.floor(x); }
const ink = values.inkMode > 0.5;                      // P2.3.5: 白纸墨色(0=旧黑底加光)
// 三个旋钮各钉一层, 而且**每一条渲染路径都要各钉各的** —— 这里曾经只按 ink 分档, 于是
// antStyle / foodLook 在 PNG 管线里是空开关(浏览器里能退回旧画面, 验收图退不回), 由 look_check A5 抓到。
const antStyleOn = values.antStyle > 0.5;                // 0=旧的蓝色拉长光点(原码在下面 else 分支)
const foodLookOn = values.foodLook > 0.5;                // 0=旧的绿色软光环
const paperCol = tintArr(PAPER.map((c) => c * 255));    // 纸被环境光照明 ⇒ 夜里自动变暗变冷
// 墨色合成: 出射 = 纸×(1−覆盖) + 墨×覆盖。墨也乘环境光 ⇒ 整幅图 = amb ×(纸/墨混合),
// 与旧加光路径「一切乘 uAmbient」同一条色温管线(昼夜/雨不会在两条路径上长成两个样子)。
function inkOver(base, stops, lut, u, k) {
  const a = inkCoverage(u, k);
  if (a <= 0) return base;
  const li = lutIndex(u) * 3;
  const ir = lut ? lut[li] : 0, ig = lut ? lut[li + 1] : 0, ib = lut ? lut[li + 2] : 0;
  return [base[0] * (1 - a) + ir * a, base[1] * (1 - a) + ig * a, base[2] * (1 - a) + ib * a];
}
const wallCol = ink ? tintArr([56, 50, 46]) : tintArr([70, 80, 95]);   // 纸上=炭黑块
const predFill = tintArr([130, 16, 12]), predEdge = tintArr([255, 80, 55]);
const nestCol = tintArr([120, 210, 255]), foodCol = tintArr([90, 255, 130]);
const nestHole = tintArr([38, 30, 26]), nestMound = tintArr([176, 152, 118]);
const antLoaded = tintArr([255, 210, 90]), antIdle = tintArr([110, 180, 255]);
const headLoaded = tintArr([255, 250, 130]), headIdle = tintArr([170, 220, 255]);
// 背景
const bgCol = ink ? paperCol : tintArr([2, 3, 8]);
for (let i = 0; i < W * H; i++) {
  data[i * 4] = bgCol[0]; data[i * 4 + 1] = bgCol[1]; data[i * 4 + 2] = bgCol[2]; data[i * 4 + 3] = 255;
}
// 信息素场（色阶 与 shader 一致; 报警信息素活动时叠危险红）
const softTone = values.toneMap > 0.5;
const flut = softTone ? rampLut(ink ? TRAIL_STOPS : FIELD_STOPS, ink ? 'trail' : 'field') : null;
const alut = softTone ? rampLut(ink ? ALARM_INK_STOPS : ALARM_STOPS, ink ? 'alarmink' : 'alarm') : null;
for (let gy = 0; gy < field.gh; gy++) {
  for (let gx = 0; gx < field.gw; gx++) {
    const v = disp.buf[gy * field.gw + gx];   // P2.3.4: 显示量(可能已减背景)
    if (ink) {
      // 白纸路径: 浓度→tone→墨覆盖度, 再往纸上染。tone 与加光路径共用同一个函数,
      // 所以自适应曝光(P2.3.2)与侧抑制(P2.3.4)治的那两件事在这里继续原样生效。
      let pc = inkOver(bgCol, TRAIL_STOPS, flut, tone(v / effPeak()), values.trailInk);
      if (world.predator) {
        const av0 = alarmField.buf[gy * field.gw + gx];
        if (av0 > 0) pc = inkOver(pc, ALARM_INK_STOPS, alut, tone(av0 / values.alarmPeak), 1.4);
      }
      var cr = pc[0], cg = pc[1], cb = pc[2];
    } else if (softTone) {
      // 软压缩有界色阶: 与 WebGL/Canvas2D 共用 palette.js。PNG 路径的 px() 是"覆盖"而非叠加,
      // 所以这里要自己把背景加上, 才等价于着色器的 clear(bg*amb) + additive(ramp*amb)。
      const li = lutIndex(tone(v / effPeak())) * 3;
      cr = bgCol[0] + flut[li]; cg = bgCol[1] + flut[li + 1]; cb = bgCol[2] + flut[li + 2];
    } else {
      const t = Math.min(1, Math.max(0, v / effPeak()));
      const e = t * t * (3 - 2 * t);
      cr = 5 + (56 - 5) * smooth(t, 0, 0.55) + 255 * e * e * 1.8;
      cg = 13 + (140 - 13) * smooth(t, 0, 0.55) + 199 * e * e * 1.8;
      cb = 41 + (255 - 41) * smooth(t, 0, 0.55) + 71 * e * e * 1.8;
    }
    // 报警红(P2.2): 与 canvas2d 同一套合成(红加得最多)。墨色路径已在上面处理过, 这里只剩旧加光。
    if (!ink && world.predator) {
      const av = alarmField.buf[gy * field.gw + gx];
      if (av > 0) {
        if (softTone) {
          const ai = lutIndex(tone(av / values.alarmPeak)) * 3;
          cr += alut[ai]; cg += alut[ai + 1]; cb += alut[ai + 2];
        } else {
          const at = Math.min(1, av / values.alarmPeak);
          const ae = at * at * (3 - 2 * at);
          cr += 255 * ae * 0.9; cg += 56 * ae * 0.9; cb += 26 * ae * 0.9;
        }
      }
    }
    const col = ink ? [Math.min(255, cr), Math.min(255, cg), Math.min(255, cb)]
      : tintArr([cr, cg, cb].map((x) => Math.min(255, x)));   // Uint8Array 赋值是 mod 256 回绕, 饱和核心必须显式 clamp
    // 画该格中心的一个小块
    const cx = (gx + 0.5) * field.cellSize, cy = (gy + 0.5) * field.cellSize;
    for (let dy = 0; dy < field.cellSize * SCALE; dy++) {
      for (let dx = 0; dx < field.cellSize * SCALE; dx++) {
        px(cx - field.cellSize / 2 + dx / SCALE, cy - field.cellSize / 2 + dy / SCALE, col, 255);
      }
    }
  }
}
function smooth(x, a, b) { return Math.min(1, Math.max(0, (x - a) / (b - a))); }

// 障碍墙(P2.1): 板岩色实心块, 盖在场色之上、蚂蚁之下
if (world.wallCount > 0) {
  const psz = world.cell * SCALE;
  for (let iy = 0; iy < world.gh; iy++) {
    for (let ix = 0; ix < world.gw; ix++) {
      if (!world.walls[iy * world.gw + ix]) continue;
      const cx = (ix + 0.5) * world.cell, cy = (iy + 0.5) * world.cell;
      for (let dy = 0; dy < psz; dy++) {
        for (let dx = 0; dx < psz; dx++) {
          px(cx - world.cell / 2 + dx / SCALE, cy - world.cell / 2 + dy / SCALE, wallCol, 255);
        }
      }
    }
  }
}

// 捕食者(P2.2): 半透明红盘(同心环) + 亮红描边
if (world.predator) {
  const P = world.predator;
  for (let rr = 0; rr < P.r; rr += 3) {
    for (let a = 0; a < 6.28; a += 0.02) {
      px(P.x + Math.cos(a) * rr, P.y + Math.sin(a) * rr, predFill, 70);
    }
  }
  for (let a = 0; a < 6.28; a += 0.004) {
    px(P.x + Math.cos(a) * P.r, P.y + Math.sin(a) * P.r, predEdge);
    px(P.x + Math.cos(a) * (P.r - 1), P.y + Math.sin(a) * (P.r - 1), predEdge);
  }
}

// 巢: 旧画面是一个青色光环; 纸上它是一个**洞**——深色洞口 + 一圈挖出来的浮土。
if (ink) {
  const NR = values.nestRadius;
  for (let rr = NR * 0.62; rr >= 0; rr -= 1 / SCALE) {
    for (let a = 0; a < 6.283; a += 0.02) {
      px(world.nestX + Math.cos(a) * rr, world.nestY + Math.sin(a) * rr, nestHole, rr < NR * 0.30 ? 235 : 150);
    }
  }
  for (let band = 0; band < 3; band++) {
    const rr = NR * (1.02 + band * 0.055);
    for (let a = 0; a < 6.283; a += 0.008) {
      const hj = 0.72 + 0.28 * hash21(Math.floor(a * 40), band, 7);   // 土堆不圆: 挖出来的东西是堆成渣的
      px(world.nestX + Math.cos(a) * rr * hj, world.nestY + Math.sin(a) * rr * hj, nestMound, 150);
    }
  }
} else {
  for (let a = 0; a < 6.28; a += 0.01) {
    px(world.nestX + Math.cos(a) * values.nestRadius, world.nestY + Math.sin(a) * values.nestRadius, nestCol);
  }
}
// 食物: 旧画面是一圈绿色光环 —— 取食 90% 之后与取食 0% 长得一模一样, 所以「还剩多少」
// 在画面上是不可读的(用户的话: 蚂蚁搬运后食物上面应该有缺少)。纸上它是一粒**种子**:
// 随消耗整体缩小, 并沿一个扇形被啃开缺口(缺口角度 ∝ 已吃掉的比例, 边缘按角向 bin 抖动),
// 新啃口露浅色内瓤。几何与 GLSL 版同源: render/look.js 的 foodCoverage()。
function drawFoodPatch(P, pi) {
  if (!foodLookOn) {
    for (let a = 0; a < 6.28; a += 0.01) px(P.x + Math.cos(a) * P.radius, P.y + Math.sin(a) * P.radius, foodCol);
    return;
  }
  const f = P.a0 > 0 ? Math.max(0, Math.min(1, 1 - P.amount / P.a0)) : 0;
  const seed = hash21(pi + 1, 7, 3);
  const R = P.radius, step = 1 / SCALE;
  // 剩余半径由 look.js 的 foodRadius 给(= GLSL 里的 awFoodR): 搬走的就是没了, 所以整粒会缩小
  const Rb = foodRadius(R, f);
  for (let dy = -Rb; dy <= Rb; dy += step) {
    for (let dx = -Rb; dx <= Rb; dx += step) {
      const c = foodCoverage(dx, dy, R, f, seed);
      if (c.cov <= 0) continue;
      const rr = Math.hypot(dx, dy) / Math.max(Rb, 1e-6);
      const t = c.bite > 0.12 ? 0 : 0.30 + 0.70 * Math.min(1, rr);   // 中心受光、边缘变暗的壳
      const mix = (a2, b2) => a2 + (b2 - a2) * t;
      const rgb = tintArr([mix(FOOD_FLESH[0], FOOD_HULL[0]), mix(FOOD_FLESH[1], FOOD_HULL[1]), mix(FOOD_FLESH[2], FOOD_HULL[2])].map((x) => x * 255));
      px(P.x + dx, P.y + dy, rgb, Math.round(255 * c.cov));
    }
  }
}
for (let pi = 0; pi < world.foodPatches.length; pi++) drawFoodPatch(world.foodPatches[pi], pi);
// 蚂蚁: 旧画面是一粒蓝色拉长光点(用户的原话: 全都是蓝色像素斑点)。antStyle=1 它是一只虫——
// 头/胸/腹三段 + 腹柄细腰 + 膝状触角 + 六足, 近黑几丁质按 uid 分 3 档, 负重的叼一粒粮。
// 轮廓来自 render/look.js 的 antCoverage()(与 GLSL 同一张形状表), 逐像素求覆盖度。
const nAntsDraw = colony.population !== undefined ? colony.population : colony.count;
if (antStyleOn) {
  const Lw = values.antLen / ZOOM_REF;                 // 体长(世界单位)
  const lod = antLod(values.antLen, nAntsDraw);
  const step = 1 / SCALE;
  const av = values.antVar;
  const mid = CHITIN[1];
  const crumbRgb = tintArr(CRUMB_RGB.map((x) => x * 255));   // 逐帧一次, 不在逐蚁循环里建数组
  const am0 = amb ? amb[0] : 1, am1 = amb ? amb[1] : 1, am2 = amb ? amb[2] : 1;
  const scr = [0, 0, 0];                                     // 复用: 逐像素零分配
  for (let i = 0; i < nAntsDraw; i++) {
    const cx = colony.px[i], cy = colony.py[i];
    if (cx < cx0 - 40 || cx > cx1 + 40 || cy < cy0 - 40 || cy > cy1 + 40) continue;   // 特写时先裁掉画外的
    // 与 WebGL/Canvas2D 同一套: 先按 antVar 浓度把个体差异向 0.5 收(av=0 ⇒ 全群同一只蚁复制粘贴),
    // 再按 1/3 与 2/3 分三档 —— 分档而不是连续插值, 否则 0 档与 1 档之间会出现第三种颜色
    const v = antVar(colony.uid ? colony.uid[i] : i) * av + 0.5 * (1 - av);
    const bl = Lw * (1 + (v - 0.5) * 0.24 * av);
    const ch = CHITIN[v < 0.3333333 ? 0 : (v < 0.6666667 ? 1 : 2)];
    const br = ch[0] * 255, bgv = ch[1] * 255, bb = ch[2] * 255;
    const hr = (ch[0] + mid[0] * SHEEN_GAIN) * 255, hg = (ch[1] + mid[1] * SHEEN_GAIN) * 255, hb = (ch[2] + mid[2] * SHEEN_GAIN) * 255;
    const cs = Math.cos(colony.theta[i]), sn = Math.sin(colony.theta[i]);
    const carry = colony.load[i] > 0.3;
    const hx = bl * 0.72, hy = bl * 0.42;
    for (let dy = -hy; dy <= hy; dy += step) {
      for (let dx = -hx; dx <= hx; dx += step) {
        const lx = (dx * cs + dy * sn) / bl, ly = (dy * cs - dx * sn) / bl;
        const c = antCoverage(lx, ly, lod);
        if (c.body > 0) {
          const k = c.sheen > 1 ? 1 : c.sheen;               // 腹部受光 = GLSL 的 ch + awChitin[1]*awSheenGain*sheen
          scr[0] = (br + (hr - br) * k) * am0;
          scr[1] = (bgv + (hg - bgv) * k) * am1;
          scr[2] = (bb + (hb - bb) * k) * am2;
          px(cx + dx, cy + dy, scr, Math.round(245 * c.body));
        }
        if (carry && c.crumb > 0) px(cx + dx, cy + dy, crumbRgb, Math.round(255 * c.crumb));
      }
    }
  }
} else {
  for (let i = 0; i < colony.count; i++) {
    const l = colony.load[i];
    const rgb = l > 0.3 ? antLoaded : antIdle;
    const head = l > 0.3 ? headLoaded : headIdle;
    const cx = colony.px[i], cy = colony.py[i], th = colony.theta[i];
    for (let k = -1; k <= 2; k++) {
      px(cx + Math.cos(th) * k * 1.6, cy + Math.sin(th) * k * 1.6, rgb);
    }
    px(cx + Math.cos(th) * 3.2, cy + Math.sin(th) * 3.2, head);
  }
}


// 雨丝(P2.3): 与 canvas2d._drawRain / FS_RAIN 同一套三层视差格子(cell/速度/权重/粗细/种子逐项相同),
// 加性混合盖在最上层。格长**不乘 SCALE**: 两条实时路径的雨都是"屏幕空间"的(格子=屏幕像素),
// 截图同理按图像像素取格; 若乘 0.4 变成"世界空间", 同样画面上的雨丝会密 4–6 倍, 糊成电视雪花。
function drawRain(rain, wd, t) {
  const r = Math.min(1, rain);
  const shear = wd * (0.10 + 0.45 * r);            // dx/dy, 与 uWind 同定义(0=竖直雨)
  const lum = ((amb ? amb[0] : 1) + (amb ? amb[1] : 1) + (amb ? amb[2] : 1)) / 3;
  // 黑底上雨是散射高光(加性); 白纸上雨是一道道灰蓝暗条(染色), 与 FS_RAIN 的 uInk 档同式
  const RGB = ink ? [77 * (amb ? amb[0] : 1), 97 * (amb ? amb[1] : 1), 128 * (amb ? amb[2] : 1)]
    : [158 * lum, 189 * lum, 242 * lum];           // 旧档 = FS_RAIN 的 vec3(0.62,0.74,0.95)*255
  const aK = ink ? 0.55 : 1;
  const LAYERS = [[70, 980, 0.80, 1.8, 1.7], [46, 700, 0.55, 1.3, 5.3], [28, 470, 0.30, 1.0, 9.1]];
  function add(ix, iy, a) {
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
    const o = (iy * W + ix) * 4;
    if (ink) {
      const k2 = Math.min(1, a * aK);
      data[o] = data[o] * (1 - k2) + RGB[0] * k2;
      data[o + 1] = data[o + 1] * (1 - k2) + RGB[1] * k2;
      data[o + 2] = data[o + 2] * (1 - k2) + RGB[2] * k2;
      return;
    }
    data[o] = Math.min(255, data[o] + RGB[0] * a);
    data[o + 1] = Math.min(255, data[o + 1] + RGB[1] * a);
    data[o + 2] = Math.min(255, data[o + 2] + RGB[2] * a);
  }
  for (let li = 0; li < LAYERS.length; li++) {
    const cell = LAYERS[li][0], speed = LAYERS[li][1];   // 屏幕空间: 与 canvas2d 的 *dpr 同构, 不乘世界→图像的 SCALE
    const wt = LAYERS[li][2], lw = Math.max(1, Math.round(LAYERS[li][3] * 0.8)), seed = LAYERS[li][4];
    const scroll = t * speed;
    const baseRow = Math.floor(scroll / cell), off = scroll - baseRow * cell;
    const rows = Math.ceil(H / cell) + 1, cols = Math.ceil(W / cell) + 1;
    const a = r * wt;
    for (let k = -1; k <= rows; k++) {
      const idy = baseRow + k, yTop = k * cell + off;
      for (let gx = 0; gx < cols; gx++) {
        const hv = hash21(gx, idy, seed);
        if (hv > 0.6) continue;                     // 约四成格子空着, 疏密才不像栅栏
        const lane = 0.10 + 0.80 * fract(hv * 37.1);
        const y0 = 0.02 + 0.34 * fract(hv * 11.7);
        let len = 0.34 + 0.62 * fract(hv * 23.3);
        if (y0 + len > 1) len = 1 - y0;             // 不跨格: 否则断口会排成可见的网格线
        const ys = yTop + y0 * cell, ln = len * cell;
        const xs = gx * cell + lane * cell - ys * shear;
        const steps = Math.max(1, Math.round(ln * 1.6));
        for (let q = 0; q <= steps; q++) {
          const u = q / steps;
          const pxi = Math.round(xs - ln * shear * u), pyi = Math.round(ys + ln * u);
          for (let wid = 0; wid < lw; wid++) add(pxi + wid, pyi, a);
        }
      }
    }
  }
}
if (envNow && envNow.rain > 0.01) drawRain(envNow.rain, envNow.windDir, colony.stepCount / 60);

mkdirSync('screenshots', { recursive: true });
writeFileSync(`screenshots/${OUT_NAME}`, PNG.sync.write(png));
console.log('已写出 screenshots/' + OUT_NAME, W + 'x' + H);
let alarmPeak = 0;
if (world.predator) { for (let i = 0; i < alarmField.buf.length; i++) if (alarmField.buf[i] > alarmPeak) alarmPeak = alarmField.buf[i]; }
console.log(`卸货=${colony.deliveries} 弃货=${colony.timeouts} 空手返巢=${colony.aborts} 墙格=${world.wallCount}` +
  (world.predator ? ` 捕杀=${colony.kills} 报警峰值=${alarmPeak.toFixed(3)}` : '') +
  ` 信息素峰值=${Math.max(...field.buf).toFixed(3)}`);
if (envNow) console.log('环境(P2.3): light=' + envNow.light.toFixed(2) + ' temp=' + envNow.temp.toFixed(1) + '°C tempF=' + envNow.tempF.toFixed(2) + ' rain=' + envNow.rain.toFixed(2) + ' wind=' + envNow.wind.toFixed(2) + ' windDir=' + envNow.windDir.toFixed(2) + ' wash=' + envNow.wash.toFixed(2) + ' rush=' + envNow.rush.toFixed(2) + ' dwellMul=' + envNow.dwellMul.toFixed(2) + ' tint=[' + envNow.tint.map(v => v.toFixed(2)).join(',') + ']');
