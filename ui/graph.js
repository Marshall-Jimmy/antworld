// P2.4b · 统计曲线面板: 最近 60 秒的经济曲线(卸货率/负重数/空手返巢…)。
//
// 为什么画在独立的一块小 canvas 上而不是塞进 HUD 文本:
//  HUD 是每帧重排的 DOM, 多一行就多一次布局; 而曲线一秒钟才更新一次(样本 1Hz)。
//  两者放一起的后果就是「为了画一条每秒变的线, 每 16ms 重排一次整块文字」——
//  本模块因此只在**真有新样本**时才重画, 平时一帧代码都不执行。
//
// 每条曲线各自归一(独立量程), 因为「60 次/秒的卸货」和「1500 只负重」放同一个 Y 轴上,
//  后者会把前者压成一条直线, 那是装饰不是测量。量程写在每条线自己前面的数字里。
import { METRIC_DEFS, spark } from '../core/stats.js';

const SERIES = [
  { key: 'del',  color: '#8ef0a8' },
  { key: 'load', color: '#ffb84d' },
  { key: 'ab',   color: '#c39bff' },
  { key: 'food', color: '#7fd6ff', dashed: true },   // 存粮是慢变量: 虚线, 免得抢经济三条线的视觉
];
const ROW_H = 26;
const W = 236;

export class Graph {
  constructor(host, stats) {
    this.stats = stats;
    this.cv = document.createElement('canvas');
    this.cv.id = 'graph';
    this.cv.style.cssText =
      'position:fixed;left:10px;bottom:10px;width:' + W + 'px;height:' + ROW_H * SERIES.length + 'px;' +
      'background:rgba(6,10,22,.72);border:1px solid #1c2a40;border-radius:3px;' +
      'pointer-events:none;opacity:0;transition:opacity .2s;';
    host.appendChild(this.cv);
    this.g = this.cv.getContext('2d');
    this.visible = false;
    this._sig = '';            // 上一次画的东西的指纹: 没变就不重画
  }

  setVisible(on) {
    this.visible = on;
    this.cv.style.opacity = on ? '1' : '0';
    if (on) this._sig = '';
  }

  resize(dpr) {
    const d = Math.min(dpr || 1, 2);
    this.dpr = d;
    this.cv.width = Math.round(W * d);
    this.cv.height = Math.round(ROW_H * SERIES.length * d);
    this._sig = '';
  }

  // 每帧调用, 但按 stats.version 短路: 没有新样本(1Hz)就一个像素都不重画。
  draw() {
    if (!this.visible) return;
    const st = this.stats;
    if (this._sig === st.version) return;
    this._sig = st.version;

    const g = this.g, d = this.dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.setTransform(d, 0, 0, d, 0, 0);
    g.font = '10px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';

    for (let s = 0; s < SERIES.length; s++) {
      const cfg = SERIES[s];
      const def = METRIC_DEFS.find((m) => m.key === cfg.key);
      const ring = st.rings[cfg.key];
      const y0 = s * ROW_H;
      const label = def ? def.label : cfg.key;
      g.fillStyle = '#6d8296';
      g.fillText(label, 6, y0 + 7);
      g.fillStyle = cfg.color;
      g.fillText(st.label(cfg.key), 62, y0 + 7);
      g.fillStyle = '#42566b';
      g.fillText(def && def.kind === 'rate' ? '次/秒' : def.unit, 96, y0 + 7);
      const scale = 'max:' + (ring.max() || 0).toFixed(def && def.kind === 'rate' ? 1 : 0);
      g.fillText(scale, W - 6 - g.measureText(scale).width, y0 + 7);

      if (!ring.n) continue;
      const max = ring.max();
      const x0 = 6, wIn = W - 12, hIn = ROW_H - 12;
      const n = ring.n;
      const stepPx = wIn / Math.max(1, st.cap - 1);
      g.strokeStyle = cfg.color;
      g.lineWidth = 1.2;
      g.setLineDash(cfg.dashed ? [3, 3] : []);
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const v = max > 0 ? ring.at(i) / max : 0;
        const x = x0 + wIn - (n - 1 - i) * stepPx;
        const y = y0 + 11 + hIn - v * hIn;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    }
  }

  // HUD 用的文本 sparkline(曲线面板关掉时, 精简行仍然能看到形状)
  textSpark(key, width = 24) {
    const ring = this.stats.rings[key];
    return ring ? spark(ring, width) : '';
  }
}
