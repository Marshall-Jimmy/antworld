// 临时可视化：把 headless 跑出的 sim 状态渲染成 PNG（验证走廊/蚂蚁/巢/食物的画面对不对）。
// 仅用于交付附带的验收截图，非应用本体。
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

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
const fx = w * 0.62, fy = h * 0.62;
world.addFood(fx, fy, 30, 200);
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
for (let t = 0; t < SIM_T * 60; t++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, dt),
             world.wallCount > 0 ? world.walls : null);
  colony.step(field, world, values, dt);
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
// 背景
for (let i = 0; i < W * H; i++) {
  data[i * 4] = 2; data[i * 4 + 1] = 3; data[i * 4 + 2] = 8; data[i * 4 + 3] = 255;
}
// 信息素场（色阶 与 shader 一致）
for (let gy = 0; gy < field.gh; gy++) {
  for (let gx = 0; gx < field.gw; gx++) {
    const v = field.buf[gy * field.gw + gx];
    const t = Math.min(1, Math.max(0, v / values.peak));
    const e = t * t * (3 - 2 * t);
    const deep = [5, 13, 41], warm = [56, 140, 255], core = [255, 199, 71];
    const col = [
      deep[0] + (warm[0] - deep[0]) * smooth(t, 0, 0.55) + core[0] * e * e * 1.8,
      deep[1] + (warm[1] - deep[1]) * smooth(t, 0, 0.55) + core[1] * e * e * 1.8,
      deep[2] + (warm[2] - deep[2]) * smooth(t, 0, 0.55) + core[2] * e * e * 1.8,
    ].map(v => Math.min(255, v)); // Uint8Array 赋值是 mod 256 回绕, 饱和核心(如 r=515)必须显式 clamp
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
          px(cx - world.cell / 2 + dx / SCALE, cy - world.cell / 2 + dy / SCALE, [70, 80, 95], 255);
        }
      }
    }
  }
}

// 巢
for (let a = 0; a < 6.28; a += 0.01) {
  px(world.nestX + Math.cos(a) * values.nestRadius, world.nestY + Math.sin(a) * values.nestRadius, [120, 210, 255]);
}
// 食物
for (let a = 0; a < 6.28; a += 0.01) {
  px(fx + Math.cos(a) * 30, fy + Math.sin(a) * 30, [90, 255, 130]);
}
// 蚂蚁(空=蓝, 负重=金): 带朝向短棒, 呼应 instanced 拉长形体; 图像 y 已翻转故 dy 取负
for (let i = 0; i < colony.count; i++) {
  const l = colony.load[i];
  const rgb = l > 0.3 ? [255, 210, 90] : [110, 180, 255];
  const cx = colony.px[i], cy = colony.py[i], th = colony.theta[i];
  for (let k = -1; k <= 2; k++) {
    px(cx + Math.cos(th) * k * 1.6, cy + Math.sin(th) * k * 1.6, rgb);
  }
  px(cx + Math.cos(th) * 3.2, cy + Math.sin(th) * 3.2, [Math.min(255, rgb[0] + 60), Math.min(255, rgb[1] + 40), Math.min(255, rgb[2] + 40)]);
}

mkdirSync('screenshots', { recursive: true });
writeFileSync(`screenshots/${OUT_NAME}`, PNG.sync.write(png));
console.log('已写出 screenshots/' + OUT_NAME, W + 'x' + H);
console.log(`卸货=${colony.deliveries} 弃货=${colony.timeouts} 空手返巢=${colony.aborts} 墙格=${world.wallCount} 信息素峰值=${Math.max(...field.buf).toFixed(3)}`);