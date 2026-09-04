// Canvas2D 兜底/调试渲染器：不依赖 WebGL2。
// 也能用于无 GPU 的环境（如某些 headless 抓帧）。

import { Backend } from './backend.js';
import { values } from '../core/config.js';

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

    g.fillStyle = '#030409';
    g.fillRect(0, 0, w, h);

    // ---- 信息素场渲染到离屏 ImageData ----
    const gw = field.gw, gh = field.gh;
    if (!this._img || this._img.length !== gw * gh * 4) {
      this._img = new Uint8ClampedArray(gw * gh * 4);
      this._idata = new ImageData(this._img, gw, gh);
    }
    const img = this._img, src = field.buf, peak = values.peak;
    // 报警信息素(P2.2): 活动时在同一张 ImageData 里叠危险红(一次循环合成, 不再开离屏)
    const alarm = view.alarm && view.alarm.field ? view.alarm : null;
    const asrc = alarm ? alarm.field.buf : null;
    const apeak = alarm ? alarm.peak : 1;
    for (let i = 0; i < gw * gh; i++) {
      const col = mapColor(src[i], peak);
      let r = col[0], gr = col[1], b = col[2];
      if (asrc) {
        const av = asrc[i];
        if (av > 0) {
          const t = Math.min(1, av / apeak);
          const e = t * t * (3 - 2 * t);
          r += 255 * e * 0.9; gr += 56 * e * 0.9; b += 26 * e * 0.9;  // Uint8Clamped 自动收窄
        }
      }
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
      g.fillStyle = '#46505f';
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
    for (let i = 0; i < colony.count; i++) {
      const load = colony.load[i];
      g.fillStyle = load > 0.5 ? 'rgba(255,210,90,0.9)' : 'rgba(120,190,255,0.85)';
      g.fillRect(colony.px[i] * sx, colony.py[i] * sx, apx, apx);
    }

    // ---- 巢 ----
    g.fillStyle = 'rgba(30,50,80,0.4)';
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx, 0, 7); g.fill();
    g.strokeStyle = 'rgba(140,220,255,0.8)';
    g.lineWidth = 1.5 * this.dpr;
    g.beginPath(); g.arc(nestX * sx, nestY * sx, nestRadius * sx, 0, 7); g.stroke();

    // ---- 捕食者(P2.2): 危险区红盘 + 描边 ----
    if (view.predator) {
      const p = view.predator;
      g.fillStyle = 'rgba(140,20,15,0.35)';
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,80,55,0.95)';
      g.lineWidth = 1.5 * this.dpr;
      g.beginPath(); g.arc(p.x * sx, p.y * sx, p.r * sx, 0, 7); g.stroke();
    }
  }

  destroy() {}
}