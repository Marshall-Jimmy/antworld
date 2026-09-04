// 临时可视化：把 headless 跑出的 sim 状态渲染成 PNG（验证走廊/蚂蚁/巢/食物的画面对不对）。
// 仅用于交付附带的验收截图，非应用本体。
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { values } from './core/config.js';
import { tone, rampLut, lutIndex, FIELD_STOPS, ALARM_STOPS } from './render/palette.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';

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

// ---- 渲染 ----
const SCALE = 0.4;   // 世界→图像像素
const W = Math.round(w * SCALE), H = Math.round(h * SCALE);
const png = new PNG({ width: W, height: H });
const data = png.data;
function px(x, y, rgb, a = 255) {
  // 世界坐标 → 图像坐标（y 翻转使向上为北）
  const ix = Math.round(x * SCALE), iy = Math.round(H - y * SCALE);
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
const wallCol = tintArr([70, 80, 95]);
const predFill = tintArr([130, 16, 12]), predEdge = tintArr([255, 80, 55]);
const nestCol = tintArr([120, 210, 255]), foodCol = tintArr([90, 255, 130]);
const antLoaded = tintArr([255, 210, 90]), antIdle = tintArr([110, 180, 255]);
const headLoaded = tintArr([255, 250, 130]), headIdle = tintArr([170, 220, 255]);
// 背景
const bgCol = tintArr([2, 3, 8]);
for (let i = 0; i < W * H; i++) {
  data[i * 4] = bgCol[0]; data[i * 4 + 1] = bgCol[1]; data[i * 4 + 2] = bgCol[2]; data[i * 4 + 3] = 255;
}
// 信息素场（色阶 与 shader 一致; 报警信息素活动时叠危险红）
const softTone = values.toneMap > 0.5;
const flut = softTone ? rampLut(FIELD_STOPS) : null;
const alut = softTone ? rampLut(ALARM_STOPS) : null;
for (let gy = 0; gy < field.gh; gy++) {
  for (let gx = 0; gx < field.gw; gx++) {
    const v = field.buf[gy * field.gw + gx];
    let cr, cg, cb;
    if (softTone) {
      // 软压缩有界色阶: 与 WebGL/Canvas2D 共用 palette.js。PNG 路径的 px() 是"覆盖"而非叠加,
      // 所以这里要自己把背景加上, 才等价于着色器的 clear(bg*amb) + additive(ramp*amb)。
      const li = lutIndex(tone(v / values.peak)) * 3;
      cr = bgCol[0] + flut[li]; cg = bgCol[1] + flut[li + 1]; cb = bgCol[2] + flut[li + 2];
    } else {
      const t = Math.min(1, Math.max(0, v / values.peak));
      const e = t * t * (3 - 2 * t);
      cr = 5 + (56 - 5) * smooth(t, 0, 0.55) + 255 * e * e * 1.8;
      cg = 13 + (140 - 13) * smooth(t, 0, 0.55) + 199 * e * e * 1.8;
      cb = 41 + (255 - 41) * smooth(t, 0, 0.55) + 71 * e * e * 1.8;
    }
    // 报警红(P2.2): 与 canvas2d 同一套合成(红加得最多)
    if (world.predator) {
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
    const col = tintArr([cr, cg, cb].map(x => Math.min(255, x))); // Uint8Array 赋值是 mod 256 回绕, 饱和核心必须显式 clamp
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

// 巢
for (let a = 0; a < 6.28; a += 0.01) {
  px(world.nestX + Math.cos(a) * values.nestRadius, world.nestY + Math.sin(a) * values.nestRadius, nestCol);
}
// 食物
for (let a = 0; a < 6.28; a += 0.01) {
  px(fx + Math.cos(a) * 30, fy + Math.sin(a) * 30, foodCol);
}
// 蚂蚁(空=蓝, 负重=金): 带朝向短棒, 呼应 instanced 拉长形体; 图像 y 已翻转故 dy 取负
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


// 雨丝(P2.3): 与 canvas2d._drawRain / FS_RAIN 同一套三层视差格子(cell/速度/权重/粗细/种子逐项相同),
// 加性混合盖在最上层。格长**不乘 SCALE**: 两条实时路径的雨都是"屏幕空间"的(格子=屏幕像素),
// 截图同理按图像像素取格; 若乘 0.4 变成"世界空间", 同样画面上的雨丝会密 4–6 倍, 糊成电视雪花。
function drawRain(rain, wd, t) {
  const r = Math.min(1, rain);
  const shear = wd * (0.10 + 0.45 * r);            // dx/dy, 与 uWind 同定义(0=竖直雨)
  const lum = ((amb ? amb[0] : 1) + (amb ? amb[1] : 1) + (amb ? amb[2] : 1)) / 3;
  const RGB = [158 * lum, 189 * lum, 242 * lum];   // = FS_RAIN 的 vec3(0.62,0.74,0.95)*255
  const LAYERS = [[70, 980, 0.80, 1.8, 1.7], [46, 700, 0.55, 1.3, 5.3], [28, 470, 0.30, 1.0, 9.1]];
  function add(ix, iy, a) {
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
    const o = (iy * W + ix) * 4;
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