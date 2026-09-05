// Canvas2D 兜底/调试渲染器：不依赖 WebGL2。
// 也能用于无 GPU 的环境（如某些 headless 抓帧）。

import { Backend } from './backend.js';
import { values } from '../core/config.js';
import { tone, rampLut, lutIndex, FIELD_STOPS, ALARM_STOPS } from './palette.js';
import { PAPER, TRAIL_STOPS, ALARM_INK_STOPS, CHITIN, CRUMB_RGB, inkCoverage, antLod, antVar, antPaths, foodBoundary, foodRadius, FOOD_HULL, FOOD_FLESH } from './look.js';
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

// look.js 的色表是 0..1 反射率, canvas 的 rgba() 助手要 0..255 ⇒ 每帧换算几次, 不在逐蚁循环里
function c255(c) { return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)]; }

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
    const ink = values.inkMode > 0.5;
    // P2.3.5: 墨色模式下这张纸被环境光照明(夜里/雨天自动变暗变冷), 旧版是一块近黑的夜空
    const paper = ink ? PAPER.map((c) => c * 255) : [3, 4, 9];
    g.fillStyle = amb ? `rgb(${Math.round(paper[0] * amb[0])},${Math.round(paper[1] * amb[1])},${Math.round(paper[2] * amb[2])})`
      : (ink ? '#faf6ee' : '#030409');
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
    const flut = soft ? rampLut(ink ? TRAIL_STOPS : FIELD_STOPS, ink ? 'trail' : 'field') : null;
    const alut = soft ? rampLut(ink ? ALARM_INK_STOPS : ALARM_STOPS, ink ? 'alarmink' : 'alarm') : null;
    const inkK = values.trailInk;
    const p0 = amb ? paper[0] * amb[0] : paper[0];
    const p1 = amb ? paper[1] * amb[1] : paper[1];
    const p2 = amb ? paper[2] * amb[2] : paper[2];
    for (let i = 0; i < gw * gh; i++) {
      let r, gr, b;
      if (ink) {
        // 出射 = 纸×(1−覆盖) + 墨×覆盖。与 WebGL 的 (ONE, ONE_MINUS_SRC_ALPHA) 同一式,
        // 只是这里的场层本身不透明, 所以纸色得先叠进来(那条路径的纸在 clearColor 里)。
        const u = tone(src[i] / peak);
        const a = inkCoverage(u, inkK);
        if (a <= 0) { r = p0; gr = p1; b = p2; }
        else {
          const li = lutIndex(u) * 3;
          r = p0 * (1 - a) + flut[li] * a; gr = p1 * (1 - a) + flut[li + 1] * a; b = p2 * (1 - a) + flut[li + 2] * a;
        }
      } else if (soft) {
        const li = lutIndex(tone(src[i] / peak)) * 3;
        r = flut[li]; gr = flut[li + 1]; b = flut[li + 2];
      } else {
        const col = mapColor(src[i], peak);
        r = col[0]; gr = col[1]; b = col[2];
      }
      if (asrc) {
        const av = asrc[i];
        if (av > 0) {
          if (ink) {
            const au = tone(av / apeak);
            const aa = inkCoverage(au, 1.4);
            const ai = lutIndex(au) * 3;
            r = r * (1 - aa) + alut[ai] * aa; gr = gr * (1 - aa) + alut[ai + 1] * aa; b = b * (1 - aa) + alut[ai + 2] * aa;
          } else if (soft) {
            const ai = lutIndex(tone(av / apeak)) * 3;
            r += alut[ai]; gr += alut[ai + 1]; b += alut[ai + 2];
          } else {
            const t = Math.min(1, av / apeak);
            const e = t * t * (3 - 2 * t);
            r += 255 * e * 0.9; gr += 56 * e * 0.9; b += 26 * e * 0.9;  // Uint8Clamped 自动收窄
          }
        }
      }
      if (amb && !ink) { r *= amb[0]; gr *= amb[1]; b *= amb[2]; }   // 对齐着色器的 o.rgb *= uAmbient(纸色已在上面乘过)
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
      g.fillStyle = ink ? rgba([19, 18, 17], 1, amb) : rgba([70, 80, 95], 1, amb);   // 纸上炭黑 / 夜里板岩蓝
      const px = cell * sx;
      for (let iy = 0; iy < gh; iy++) {
        for (let ix = 0; ix < gw; ix++) {
          if (buf[iy * gw + ix]) {
            g.fillRect(ix * px, iy * px, px + 0.5, px + 0.5);  // +0.5 盖住格间缝
          }
        }
      }
    }

    // ---- 食物: 会被啃的实物(缺口随取食长大) ----
    if (values.foodLook > 0.5) {
      const cFlesh = rgba(c255(FOOD_FLESH), 1, amb);
      const cHull = rgba(c255(FOOD_HULL), 1, amb);
      const cEdge = rgba(c255(FOOD_HULL.map((v) => v * 0.45)), 0.9, amb);
      for (let pi = 0; pi < foodPatches.length; pi++) {
        const P = foodPatches[pi];
        if (P.amount <= 0) continue;               // 搬空的食源不再画(通常已被 sim 移出数组, 这是第二道闸)
        const a0 = P.a0 > 0 ? P.a0 : P.amount;      // 旧世界对象没有 a0: 视作从未被啃(与 WebGL 同一兜底)
        const f = Math.max(0, Math.min(1, 1 - P.amount / a0));
        const seed = (pi * 0.6180339887) % 1;
        const cx0 = P.x * sx, cy0 = P.y * sx, R = foodRadius(P.radius, f) * sx;
        // 被吃掉的那块位置就是纸(不是食物), 所以这里只画「还剩的部分」+ 切口上一道浅色内瓤。
        // 旧版是一圈绿色光环: 吃掉九成与一口没吃长得一样 —— 用户说的「食物上面应该有缺少」正是这条。
        g.beginPath();
        for (let k = 0; k <= 96; k++) {
          const a = (k / 96) * Math.PI * 2;
          const rb = foodBoundary(P.radius, f, seed, a) * sx;
          const px2 = cx0 + Math.cos(a) * rb, py2 = cy0 + Math.sin(a) * rb;
          if (k === 0) g.moveTo(px2, py2); else g.lineTo(px2, py2);
        }
        g.closePath();
        g.fillStyle = cHull;
        g.fill();
        g.strokeStyle = cEdge;
        g.lineWidth = 1 * this.dpr;
        g.stroke();
        if (f > 0.002) {
          // 切口: 沿缺口那段边界描一条浅色带(= GLSL 里 bite>0.12 的那圈), 宽 10% 剩余半径
          const a0g = seed * Math.PI * 2, a1g = a0g + Math.PI * 2 * Math.min(1, f);
          g.beginPath();
          for (let k = 0; k <= 48; k++) {
            const a = a0g + ((a1g - a0g) * k) / 48;
            const rb = foodBoundary(P.radius, f, seed, a) * sx;
            const qx = cx0 + Math.cos(a) * rb, qy = cy0 + Math.sin(a) * rb;
            if (k === 0) g.moveTo(qx, qy); else g.lineTo(qx, qy);
          }
          g.strokeStyle = cFlesh;
          g.lineWidth = Math.max(1.2 * this.dpr, R * 0.10);
          g.stroke();
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
    // 括号必须有: 写 `i < a ?? b` 会被解析成 `(i < a) ?? b`(见 METRICS P2.5 §0 那个真 bug)
    const nAnts = colony.population ?? colony.count;
    if (values.antStyle > 0.5) {
      this._drawAntsInk(g, colony, nAnts, sx, amb, ox, oy);
      // 交回世界变换: 巢/捕食者都在 translate(ox,oy) 之后按世界坐标画
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.translate(ox, oy);
      g.lineCap = 'butt';
    } else {
      for (let i = 0; i < nAnts; i++) {
        const load = colony.load[i];
        g.fillStyle = load > 0.5 ? cLoaded : cIdle;
        g.fillRect(colony.px[i] * sx, colony.py[i] * sx, apx, apx);
      }
    }

    // ---- 巢: 纸上是一个洞(深处发暗)加一圈挖出来的浮土 ----
    g.fillStyle = ink ? rgba([34, 27, 23], 0.92, amb) : rgba([30, 50, 80], 0.4, amb);
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx * (ink ? 0.62 : 1), 0, 7); g.fill();
    g.strokeStyle = ink ? rgba([158, 133, 102], 0.85, amb) : rgba([140, 220, 255], 0.8, amb);
    g.lineWidth = (ink ? 2.4 : 1.5) * this.dpr;
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx, 0, 7); g.stroke();
    if (ink) {
      g.strokeStyle = rgba([184, 161, 125], 0.5, amb);
      g.lineWidth = 1.6 * this.dpr;
      g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx * 1.10, 0, 7); g.stroke();
    }

    // ---- 捕食者(P2.2): 危险区红盘 + 描边 ----
    if (view.predator) {
      const p = view.predator;
      g.fillStyle = ink ? rgba([140, 26, 18], 0.26, amb) : rgba([140, 20, 15], 0.35, amb);
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.fill();
      g.strokeStyle = ink ? rgba([133, 33, 23], 0.95, amb) : rgba([255, 80, 55], 0.95, amb);
      g.lineWidth = 1.5 * this.dpr;
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.stroke();
    }

    // ---- 雨丝(P2.3): 最后一层, 盖在所有东西之上 ----
    if (env && env.rain > 0.01) this._drawRain(g, env, amb, w, h);
  }

  // P2.3.5 墨色工蚁。轮廓取自 render/look.js —— 与 WebGL 的 awAnt、PNG 的 antCoverage 同一张表,
  // 所以验收图与玩家看到的画面不是两副长相。三处有意的工程差别(语义不变, 都写在这里):
  //   1 三档几丁质**分桶各画一遍**: 换 fillStyle 会让 canvas 重新解析颜色串, 逐蚁换色等于每帧 5000 次解析;
  //     分桶之后每帧只解析 3(+3) 次, 代价是数组多走两趟(一次比较, 远比一次 fill 便宜)。
  //   2 附属器线宽有 1 设备像素的下限: 着色器里触角是 smoothstep 软边(中心实、边缘虚), 这里若按
  //     0.030 体长的硬边描线, 在 11 px 体长下会得到一根 0.3 px 的淡灰线 —— 看不见, 等于没长触角。
  //   3 腹部高光是一块实心浅斑而非连续衰减, 且画在身体之后: 兜底路径优先保帧率。
  _drawAntsInk(g, colony, n, sx, amb, ox, oy) {
    const P = antPaths();
    if (!P) return;                                  // 无 Path2D 的环境: 这一档不画(旧蓝方块在另一分支)
    const av = values.antVar, base = values.antLen * this.dpr;
    const lod = antLod(values.antLen, n);
    const w = this.canvas.width, h = this.canvas.height;
    const px = colony.px, py = colony.py, th = colony.theta, ld = colony.load, uid = colony.uid;
    // 每帧重算的只有这几条颜色串(环境光逐帧变), 逐蚁循环里一次都不拼字符串
    const shade = this._inkShade || (this._inkShade = ['', '', '']);
    const sheen = this._inkSheen || (this._inkSheen = ['', '', '']);
    for (let b = 0; b < 3; b++) {
      const ch = CHITIN[b];
      shade[b] = rgba(c255(ch), 0.96, amb);
      sheen[b] = rgba(c255([ch[0] + CHITIN[1][0] * 0.9, ch[1] + CHITIN[1][1] * 0.9, ch[2] + CHITIN[1][2] * 0.9]), 0.80, amb);
    }
    const crumbCol = rgba(c255(CRUMB_RGB), 0.98, amb);
    if (!this._inkBuf || this._inkCap < n) {
      const cap = Math.max(n, 1024);
      this._inkCap = cap;
      this._inkBuf = {
        ax: new Float32Array(cap), ay: new Float32Array(cap),
        cs: new Float32Array(cap), sn: new Float32Array(cap), sz: new Float32Array(cap),
        bkt: new Uint8Array(cap),
      };
    }
    const B = this._inkBuf, bkt = B.bkt;
    // ---- 投影 + 分桶(视锥外的蚁在这里就被剔除: 兜底路径没有 GPU 帮忙丢弃空画) ----
    for (let i = 0; i < n; i++) {
      const X = ox + px[i] * sx, Y = oy + py[i] * sx;
      if (X < -base || X > w + base || Y < -base || Y > h + base) { bkt[i] = 255; continue; }
      const v = av > 0 ? antVar(uid ? uid[i] : i) * av + 0.5 * (1 - av) : 0.5;
      bkt[i] = v < 0.3333333 ? 0 : (v < 0.6666667 ? 1 : 2);      // 与 FS_ANT 的两道 step 同一分界
      const cs = Math.cos(th[i]), sn = Math.sin(th[i]);
      B.ax[i] = X; B.ay[i] = Y; B.cs[i] = cs; B.sn[i] = sn;
      B.sz[i] = base * (1 + (v - 0.5) * 0.24 * av);
    }
    g.lineCap = 'round';
    for (let b = 0; b < 3; b++) {
      g.fillStyle = shade[b];
      for (let i = 0; i < n; i++) {
        if (bkt[i] !== b) continue;
        const s = B.sz[i];
        g.setTransform(B.cs[i] * s, B.sn[i] * s, -B.sn[i] * s, B.cs[i] * s, B.ax[i], B.ay[i]);
        g.fill(P.body);
      }
      if (lod < 1) continue;
      g.fillStyle = sheen[b];
      for (let i = 0; i < n; i++) {
        if (bkt[i] !== b) continue;
        const s = B.sz[i];
        g.setTransform(B.cs[i] * s, B.sn[i] * s, -B.sn[i] * s, B.cs[i] * s, B.ax[i], B.ay[i]);
        g.fill(P.sheen);
      }
    }
    if (lod >= 1) {
      for (let b = 0; b < 3; b++) {
        g.strokeStyle = shade[b];
        for (let i = 0; i < n; i++) {
          if (bkt[i] !== b) continue;
          const s = B.sz[i];
          g.setTransform(B.cs[i] * s, B.sn[i] * s, -B.sn[i] * s, B.cs[i] * s, B.ax[i], B.ay[i]);
          g.lineWidth = Math.max(P.w1, 1.05 / s);
          g.stroke(P.e1);
          if (lod >= 2) { g.lineWidth = Math.max(P.w2, 1.05 / s); g.stroke(P.e2); }
        }
      }
    }
    g.fillStyle = crumbCol;
    for (let i = 0; i < n; i++) {
      if (bkt[i] === 255 || !(ld[i] > 0.3)) continue;             // 与 FS_ANT 的 vLoad>0.3 同阈值
      const s = B.sz[i];
      g.setTransform(B.cs[i] * s, B.sn[i] * s, -B.sn[i] * s, B.cs[i] * s, B.ax[i], B.ay[i]);
      g.fill(P.crumb);
    }
  }
  // 与 FS_RAIN 同构的三层视差雨: 同一组 cell/速度/权重/种子, 两条渲染路径看到的是同一场雨。
  // 差别只在于这里画的是硬边线段而非 smoothstep 亮带——兜底路径优先看帧率, 工程需要。
  _drawRain(g, env, amb, w, h) {
    const rain = Math.min(1, env.rain);
    const wd = env.windDir === undefined ? -0.5 : env.windDir;   // windDir=0 是竖直雨, 不是缺省
    const shear = wd * (0.10 + 0.45 * rain);                      // dx/dy, 与 uWind 同定义
    const t = env.t || 0;
    const dpr = this.dpr || 1;
    const ink = values.inkMode > 0.5;
    const lum = ((amb ? amb[0] : 1) + (amb ? amb[1] : 1) + (amb ? amb[2] : 1)) / 3;
    // FS_RAIN 的墨色档是 vec3(0.30,0.38,0.50)*uAmbient 且 alpha*0.55; 旧档是黑底上的加性高光
    const rgb = ink
      ? `${Math.round(77 * (amb ? amb[0] : 1))},${Math.round(97 * (amb ? amb[1] : 1))},${Math.round(128 * (amb ? amb[2] : 1))}`
      : `${Math.round(158 * lum)},${Math.round(189 * lum)},${Math.round(242 * lum)}`;
    const aK = ink ? 0.55 : 1;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);              // 屏幕空间: 雨在天上, 不跟相机走
    g.globalCompositeOperation = ink ? 'source-over' : 'lighter';   // 纸上是染色, 夜里才是加光
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
      g.strokeStyle = `rgba(${rgb},${(rain * wt * aK).toFixed(3)})`;
      g.lineWidth = Math.max(1, lw);
      g.stroke();
    }
    g.restore();
  }

  destroy() {}
}