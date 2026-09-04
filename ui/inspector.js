// 点击单只蚂蚁，高亮它并画出最近 N 步的轨迹 + 显示内部标量。
// 接收外部注入的 viewTransform(): 世界→屏幕 [sx,sy]，保持与主画布一致。

import { get } from '../core/config.js';

export class Inspector {
  constructor(host, opts) {
    this.getTransform = opts.getTransform; // worldToScreen(x,y) -> [px,py]
    this.colony = opts.colony;
    this.trailLen = opts.trailLen || 200;
    this.trailX = new Float32Array(this.trailLen);
    this.trailY = new Float32Array(this.trailLen);
    this.trailN = 0;
    this.head = 0;
    this.observed = -1;

    // 覆盖画布(轨迹用)
    this.cv = document.createElement('canvas');
    this.cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;';
    host.appendChild(this.cv);
    this.g = this.cv.getContext('2d');

    // 信息小面板
    this.info = document.createElement('div');
    this.info.style.cssText =
      'position:fixed;top:10px;right:10px;font:11px/1.6 ui-monospace,Consolas,monospace;' +
      'color:#cfe3f5;background:rgba(6,10,22,.85);border:1px solid #2a3c58;padding:6px 10px;' +
      'pointer-events:none;white-space:pre;display:none;';
    host.appendChild(this.info);
  }

  resize(w, h) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.max(1, Math.round(w * this.dpr));
    this.cv.height = Math.max(1, Math.round(h * this.dpr));
  }

  select(idx) {
    this.observed = idx;
    this.trailN = 0; this.head = 0;
    if (idx < 0) { this.info.style.display = 'none'; return; }
    this.info.style.display = 'block';
  }

  record() {
    const i = this.observed;
    if (i < 0 || i >= this.colony.count) return;
    this.trailX[this.head] = this.colony.px[i];
    this.trailY[this.head] = this.colony.py[i];
    this.head = (this.head + 1) % this.trailLen;
    if (this.trailN < this.trailLen) this.trailN++;
  }

  draw() {
    const g = this.g;
    const dpr = this.dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    // HiDPI:逻辑坐标 = CSS 像素
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const i = this.observed;
    if (i < 0) return;

    const T = this.getTransform;
    const n = this.trailN;
    if (n >= 2) {
      // 从最老到最新
      const start = (this.head - n + this.trailLen) % this.trailLen;
      for (let k = 1; k < n; k++) {
        const a = (start + k - 1) % this.trailLen;
        const b = (start + k) % this.trailLen;
        const age = k / n;
        const [x1, y1] = T(this.trailX[a], this.trailY[a]);
        const [x2, y2] = T(this.trailX[b], this.trailY[b]);
        g.strokeStyle = `rgba(255,120,40,${0.15 + 0.5 * age})`;
        g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
    }
    // 当前位置 + 朝向箭头(世界 y 向下:屏幕前方 = (cosθ, +sinθ))
    const [x, y] = T(this.colony.px[i], this.colony.py[i]);
    g.fillStyle = '#ffb84d';
    g.beginPath(); g.arc(x, y, 3.2, 0, 7); g.fill();
    const th = this.colony.theta[i];
    g.strokeStyle = '#ffb84d';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(th) * 14, y + Math.sin(th) * 14);
    g.stroke();

    // 信息
    const hx = this.colony.hx[i], hy = this.colony.hy[i];
    const load = this.colony.load[i];
    const homeDist = Math.hypot(hx, hy);
    this.info.textContent =
      `蚂蚁 #${i}\n` +
      `负载   ${load.toFixed(2)}\n` +
      `朝向   ${(th * 180 / Math.PI).toFixed(0)}°\n` +
      `|h|    ${homeDist.toFixed(1)}  (回家向量长度)\n` +
      `负重   ${this.colony.carryT[i].toFixed(2)}s / ${get('carryTimeout').toFixed(0)}s\n`;
  }

  clearSelect() { this.select(-1); }
}