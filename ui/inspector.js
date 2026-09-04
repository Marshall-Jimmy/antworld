// 点击单只蚂蚁，高亮它并画出最近 N 步的轨迹 + 显示内部标量。
// 接收外部注入的 viewTransform(): 世界→屏幕 [sx,sy]，保持与主画布一致。

import { get } from '../core/config.js';
import { MEM_WPTS } from '../sim/colony.js';

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
    // 让开右侧参数面板: 两者都是 fixed 右上角, 不让开就被面板压住, 整块读数白看
    // (P2.4 给信息面板加了"记忆"一行, 这个老毛病才暴露)。面板比 inspector 晚创建,
    // 所以每次显示时量一次实际宽度, 不写死常数。
    const paneEl = document.querySelector('.tp-dfwv');
    this.info.style.right = ((paneEl && paneEl.offsetWidth) || 260) + 18 + 'px';
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
    // 个体路线记忆(P2.4): 青色虚线 = 这只蚁自己记住并提交的航点链,空心圆 = 它下一个要奔的航点。
    // 画在轨迹与身体之下:先看"它说它记得的路",再看"它实际走出来的路",两者的偏差就是记忆在被修正。
    const c = this.colony;
    const nA = c.memNA[i];
    if (nA > 0) {
      const base = i * MEM_WPTS * 2;
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(72,226,232,0.72)';
      g.lineWidth = 1.4;
      g.beginPath();
      for (let k = 0; k < nA; k++) {
        const wp = T(c.memA[base + k * 2], c.memA[base + k * 2 + 1]);
        if (k === 0) g.moveTo(wp[0], wp[1]); else g.lineTo(wp[0], wp[1]);
      }
      g.stroke();
      g.setLineDash([]);
      const mi = c.memIA[i];
      if (mi < nA) {
        const tp = T(c.memA[base + mi * 2], c.memA[base + mi * 2 + 1]);
        g.strokeStyle = '#48e2e8';
        g.beginPath(); g.arc(tp[0], tp[1], 5, 0, 7); g.stroke();
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
    // 记忆读数:K_mem=0 时不必谎称"它没记住",直接标"关"。
    let memLine = '记忆   关(K_mem=0)';
    if (get('K_mem') > 0) {
      const rn = this.colony.memNA[i];
      memLine = rn > 0
        ? '记忆   ' + rn + ' 航点 / 长 ' + this.colony.memLA[i].toFixed(0) +
          ' / 走到第 ' + this.colony.memIA[i] + ' 点 / 扑空 ' +
          this.colony.memFail[i].toFixed(0) + '/' + get('memForget').toFixed(0)
        : '记忆   尚无(空手出门后才开始记)';
    }
    this.info.textContent =
      `蚂蚁 #${i}\n` +
      `负载   ${load.toFixed(2)}\n` +
      `朝向   ${(((th * 180 / Math.PI + 540) % 360) - 180).toFixed(0)}°\n` +
      `|h|    ${homeDist.toFixed(1)}  (回家向量长度)\n` +
      `负重   ${this.colony.carryT[i].toFixed(2)}s / ${get('carryTimeout').toFixed(0)}s\n` + memLine;
  }

  clearSelect() { this.select(-1); }
}