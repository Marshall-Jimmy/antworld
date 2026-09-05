// Canvas2D 兜底/调试渲染器：不依赖 WebGL2。
// 也能用于无 GPU 的环境（如某些 headless 抓帧）。

import { Backend } from './backend.js';
import { values } from '../core/config.js';
import { tone, rampLut, lutIndex, FIELD_STOPS, ALARM_STOPS } from './palette.js';
import { effPeak } from './exposure.js';

const PALETTE = (() => {
  // 信息素:暗底 → 蓝 → 金
  const stops = [
    [0.00, [6, 16, 40]],
    [0.10, [20, 60, 120]],
    [0.30, [60, 130, 210]],
    [1.00, [255, 200, 80]],
  ];
  return stops;
})();

// 旧硬钳制色阶(toneMap=0 的复现路径)。新画面走 palette.js 的 tone+LUT, 见其顶部注释。
function mapColor(v, peak) {
  const t = Math.min(1, Math.max(0, v / peak));
  let c = [6, 16, 40];
  for (let i = 0; i < PALETTE.length - 1; i++) {
    const a = PALETTE[i], b = PALETTE[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      c = a[1].map((ch, j) => ch + (b[1][j] - ch) * k);
      break;
    }
  }
  return c;
}

// 环境光(P2.3): 与 WebGL 路径共用同一套 tint —— 出射色逐通道相乘。amb=null 时恒等,画面与旧版一致
function rgba(c, a, amb) {
  if (!amb) return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  return `rgba(${Math.round(c[0] * amb[0])},${Math.round(c[1] * amb[1])},${Math.round(c[2] * amb[2])},${a})`;
}

// 与 FS_RAIN 同构的整数哈希: 同一个格子永远画同一根丝, 不会逐帧换位置闪烁
function hash21(ix, iy, seed) {
  let n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function fract(x) { return x - Math.floor(x); }

export class Canvas2DBackend extends Backend {
  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cx = 0; this.cy = 0; this.zoom = 0.5;
    return !!this.ctx;
  }

  setCamera(cx, cy, zoom) { this.cx = cx; this.cy = cy; this.zoom = zoom; }

  resize(w, h) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.round(w * this.dpr));
    const ph = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw; this.canvas.height = ph;
    }
  }

  _initBitmap() {
    if (!this._img2) this._img2 = document.createElement('canvas');
  }

  render(view) {
    const g = this.ctx;
    this._initBitmap();
    const { field, foodPatches, nestX, nestY, nestRadius, colony } = view;
    const w = this.canvas.width, h = this.canvas.height;
    // 世界→设备像素 = zoom(css px/世界单位) × dpr
    // 旧版 sx = w/z/field.w 把 1/z 当缩放,与 WebGL 主路径/点击换算不一致,已修正
    const sx = this.zoom * this.dpr;

    // 昼夜与天气(P2.3): env.tint 决定这一帧的世界亮度; 没有 env 就是旧底色
    const env = view.env;
    const amb = env ? env.tint : null;
    g.fillStyle = amb ? `rgb(${Math.round(3 * amb[0])},${Math.round(4 * amb[1])},${Math.round(9 * amb[2])})` : '#030409';
    g.fillRect(0, 0, w, h);

    // ---- 信息素场渲染到离屏 ImageData ----
    const gw = field.gw, gh = field.gh;
    if (!this._img || this._img.length !== gw * gh * 4) {
      this._img = new Uint8ClampedArray(gw * gh * 4);
      this._idata = new ImageData(this._img, gw, gh);
    }
    const img = this._img, src = field.buf, peak = effPeak();   // P2.3.2: 与 WebGL 共用 effPeak,三条渲染路径不会分叉
    // 报警信息素(P2.2): 活动时在同一张 ImageData 里叠危险红(一次循环合成, 不再开离屏)
    const alarm = view.alarm && view.alarm.field ? view.alarm : null;
    const asrc = alarm ? alarm.field.buf : null;
    const apeak = alarm ? alarm.peak : 1;
    // 色阶模式(P2.3.1): 软压缩走 palette.js 的 LUT(与 WebGL 同一份定义); 0 则保留旧的硬钳制 mapColor
    const soft = values.toneMap > 0.5;
    const flut = soft ? rampLut(FIELD_STOPS) : null;
    const alut = soft ? rampLut(ALARM_STOPS) : null;
    for (let i = 0; i < gw * gh; i++) {
      let r, gr, b;
      if (soft) {
        const li = lutIndex(tone(src[i] / peak)) * 3;
        r = flut[li]; gr = flut[li + 1]; b = flut[li + 2];
      } else {
        const col = mapColor(src[i], peak);
        r = col[0]; gr = col[1]; b = col[2];
      }
      if (asrc) {
        const av = asrc[i];
        if (av > 0) {
          if (soft) {
            const ai = lutIndex(tone(av / apeak)) * 3;
            r += alut[ai]; gr += alut[ai + 1]; b += alut[ai + 2];
          } else {
            const t = Math.min(1, av / apeak);
            const e = t * t * (3 - 2 * t);
            r += 255 * e * 0.9; gr += 56 * e * 0.9; b += 26 * e * 0.9;  // Uint8Clamped 自动收窄
          }
        }
      }
      if (amb) { r *= amb[0]; gr *= amb[1]; b *= amb[2]; }   // 对齐着色器的 o.rgb *= uAmbient
      img[i * 4] = r; img[i * 4 + 1] = gr; img[i * 4 + 2] = b; img[i * 4 + 3] = 255;
    }
    // 世界到屏幕变换
    g.setTransform(1, 0, 0, 1, 0, 0);
    const ox = w / 2 - this.cx * sx, oy = h / 2 - this.cy * sx;
    g.translate(ox, oy);
    if (this._img2.width !== gw || this._img2.height !== gh) {
      this._img2.width = gw; this._img2.height = gh;
    }
    this._img2.getContext('2d').putImageData(this._idata, 0, 0);
    g.drawImage(this._img2, 0, 0, sx * field.w, sx * field.h);

    // ---- 障碍墙(P2.1) ----
    if (view.walls && view.walls.count > 0) {
      const { buf, gw, gh, cell } = view.walls;
      g.fillStyle = rgba([70, 80, 95], 1, amb);   // #46505f
      const px = cell * sx;
      for (let iy = 0; iy < gh; iy++) {
        for (let ix = 0; ix < gw; ix++) {
          if (buf[iy * gw + ix]) {
            g.fillRect(ix * px, iy * px, px + 0.5, px + 0.5);  // +0.5 盖住格间缝
          }
        }
      }
    }

    // ---- 蚂蚁 ----
    const apx = 2 * this.dpr;
    // 两套色提前算好: 5000 只蚁的循环里绝不拼字符串
    const cLoaded = rgba([255, 210, 90], 0.9, amb);
    const cIdle = rgba([120, 190, 255], 0.85, amb);
    // P2.5: 画的是活蚁数(尸体已搬出 [0,population))。
    // 括号必须有: 写 `i < a ?? b` 会被解析成 `(i < a) ?? b`, 而布尔永不 nullish
    // => 兜底那一半是死代码, 没有 population 字段的假 colony 对象会一只蚁都不画。
    const nAnts = colony.population ?? colony.count;
    for (let i = 0; i < nAnts; i++) {
      const load = colony.load[i];
      g.fillStyle = load > 0.5 ? cLoaded : cIdle;
      g.fillRect(colony.px[i] * sx, colony.py[i] * sx, apx, apx);
    }

    // ---- 巢 ----
    g.fillStyle = rgba([30, 50, 80], 0.4, amb);
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx, 0, 7); g.fill();
    g.strokeStyle = rgba([140, 220, 255], 0.8, amb);
    g.lineWidth = 1.5 * this.dpr;
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx, 0, 7); g.stroke();

    // ---- 捕食者(P2.2): 危险区红盘 + 描边 ----
    if (view.predator) {
      const p = view.predator;
      g.fillStyle = rgba([140, 20, 15], 0.35, amb);
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.fill();
      g.strokeStyle = rgba([255, 80, 55], 0.95, amb);
      g.lineWidth = 1.5 * this.dpr;
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.stroke();
    }

    // ---- 雨丝(P2.3): 最后一层, 盖在所有东西之上 ----
    if (env && env.rain > 0.01) this._drawRain(g, env, amb, w, h);
  }

  // 与 FS_RAIN 逐项对应的三层视差雨: 同一组 cell/速度/权重/种子, 两条渲染路径看到的是同一场雨。
  // 差别只在于这里画的是硬边线段而非 smoothstep 亮带——兜底路径优先看帧率, 工程需要。
  _drawRain(g, env, amb, w, h) {
    const rain = Math.min(1, env.rain);
    const wd = env.windDir === undefined ? -0.5 : env.windDir;   // windDir=0 是竖直雨, 不是缺省
    const shear = wd * (0.10 + 0.45 * rain);                      // dx/dy, 与 uWind 同定义
    const t = env.t || 0;
    const dpr = this.dpr || 1;
    const lum = ((amb ? amb[0] : 1) + (amb ? amb[1] : 1) + (amb ? amb[2] : 1)) / 3;
    const rgb = `${Math.round(158 * lum)},${Math.round(189 * lum)},${Math.round(242 * lum)}`;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);              // 屏幕空间: 雨在天上, 不跟相机走
    g.globalCompositeOperation = 'lighter';        // 加性混合, 对齐 blendFunc(ONE, ONE)
    g.lineCap = 'round';
    const LAYERS = [[70, 980, 0.80, 1.8, 1.7], [46, 700, 0.55, 1.3, 5.3], [28, 470, 0.30, 1.0, 9.1]];
    for (let li = 0; li < LAYERS.length; li++) {
      const cell = LAYERS[li][0] * dpr, speed = LAYERS[li][1] * dpr;
      const wt = LAYERS[li][2], lw = LAYERS[li][3] * dpr, seed = LAYERS[li][4];
      const scroll = t * speed;                    // 已下落的距离: 逻辑秒驱动, 64 倍速时雨也落得快
      const baseRow = Math.floor(scroll / cell), off = scroll - baseRow * cell;
      const rows = Math.ceil(h / cell) + 1, cols = Math.ceil(w / cell) + 1;
      g.beginPath();                               // 一层一条 path, 每帧只 stroke 一次
      for (let k = -1; k <= rows; k++) {
        const idy = baseRow + k, yTop = k * cell + off;
        for (let ix = 0; ix < cols; ix++) {
          const hv = hash21(ix, idy, seed);
          if (hv > 0.6) continue;                  // 约四成格子空着, 疏密才不像栅栏
          const lane = 0.10 + 0.80 * fract(hv * 37.1);
          const y0 = 0.02 + 0.34 * fract(hv * 11.7);
          let len = 0.34 + 0.62 * fract(hv * 23.3);
          if (y0 + len > 1) len = 1 - y0;          // 不跨格: 否则断口会排成可见的网格线
          const ys = yTop + y0 * cell, ln = len * cell;
          const xs = ix * cell + lane * cell - ys * shear;
          g.moveTo(xs, ys);
          g.lineTo(xs - ln * shear, ys + ln);
        }
      }
      g.strokeStyle = `rgba(${rgb},${(rain * wt).toFixed(3)})`;
      g.lineWidth = Math.max(1, lw);
      g.stroke();
    }
    g.restore();
  }

  destroy() {}
}