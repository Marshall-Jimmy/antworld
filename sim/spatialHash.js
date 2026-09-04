// 邻域查询：均匀网格哈希。P0 用于点击检视 (找最近的蚂蚁)。
// 每一步从 SoA 重建网格索引（重建本身是并行的 scatter，很便宜）。

export class SpatialHash {
  constructor(cell, w, h) {
    this.cell = cell;
    this.w = w;
    this.h = h;
    this.cw = Math.ceil(w / cell);
    this.ch = Math.ceil(h / cell);
    this.head = new Int32Array(this.cw * this.ch).fill(-1);
    this.next = null;      // 每个蚂蚁的下一条链
    this.count = 0;
  }

  // 从 SoA 数组重建结构 (O(n))
  build(px, py, n) {
    const cw = this.cw, ch = this.ch, cell = this.cell;
    if (!this.next || this.next.length < n) this.next = new Int32Array(n);
    this.head.fill(-1);
    for (let i = 0; i < n; i++) {
      const ix = Math.floor(px[i] / cell);
      const iy = Math.floor(py[i] / cell);
      const k = ((ix % cw + cw) % cw) + ((iy % ch + ch) % ch) * cw;
      this.next[i] = this.head[k];
      this.head[k] = i;
    }
    this.count = n;
    this.px = px; this.py = py;
  }

  // 在 (x,y) 半径 r 内找最近蚂蚁，返回索引或 -1
  nearest(x, y, r) {
    const cw = this.cw, ch = this.ch, cell = this.cell;
    const x0 = Math.floor((x - r) / cell);
    const x1 = Math.floor((x + r) / cell);
    const y0 = Math.floor((y - r) / cell);
    const y1 = Math.floor((y + r) / cell);
    const px = this.px, py = this.py;

    let best = -1, bestD = r * r;
    for (let iy = y0; iy <= y1; iy++) {
      const gy = ((iy % ch) + ch) % ch;
      for (let ix = x0; ix <= x1; ix++) {
        const gx = ((ix % cw) + cw) % cw;
        for (let i = this.head[gx + gy * cw]; i !== -1; i = this.next[i]) {
          const dx = px[i] - x, dy = py[i] - y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }
}