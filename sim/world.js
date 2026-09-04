// 地形：目前 P0 只有食物斑块（patch 形式），巢是一个固定位置。
// 水/火/障碍是后面阶段的事。食物场仍是"场"，但用稀疏 patch 存储更省。
//
// 性能注记：foodAt 在仿真主循环里被每蚂蚁每步调用。patch 很少时（≤LINEAR_MAX）
// 保留原倒序线性扫描（语义 = 返回"最高索引的命中"，与 bit 级基线一致）；
// 玩家大量撒食物时自动切换到均匀网格索引（查询只看邻近桶），命中语义不变。

const LINEAR_MAX = 16;   // patch 数 ≤ 此值走线性扫描
const CELL = 160;        // 索引格子边长(世界单位),≥2×最大 radius 时查询只需 3×3 桶

export class World {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.foodPatches = [];   // { x, y, radius, amount }
    this.nestX = w / 2;
    this.nestY = h / 2;
    this._idx = null;        // 均匀网格: Map<cellKey, number[]> → patch 索引
    this._idxDirty = true;
  }

  addFood(x, y, radius, amount) {
    this.foodPatches.push({ x, y, radius, amount });
    this._idxDirty = true;
  }

  // ---- 均匀网格索引(惰性重建) ----
  _rebuildIndex() {
    const idx = this._idx || (this._idx = new Map());
    idx.clear();
    const patches = this.foodPatches;
    let maxR = 0;
    for (let i = 0; i < patches.length; i++) if (patches[i].radius > maxR) maxR = patches[i].radius;
    const cell = Math.max(CELL, maxR * 2);   // 保证圆盘最多跨 2 格
    const cw = Math.ceil(this.w / cell), ch = Math.ceil(this.h / cell);
    this._cell = cell; this._cw = cw; this._ch = ch;
    for (let i = 0; i < patches.length; i++) {
      if (patches[i].amount <= 0) continue;
      const r = patches[i].radius;
      const x0 = Math.max(0, Math.floor((patches[i].x - r) / cell));
      const x1 = Math.min(cw - 1, Math.floor((patches[i].x + r) / cell));
      const y0 = Math.max(0, Math.floor((patches[i].y - r) / cell));
      const y1 = Math.min(ch - 1, Math.floor((patches[i].y + r) / cell));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const k = gy * cw + gx;
          let arr = idx.get(k);
          if (!arr) idx.set(k, (arr = []));
          arr.push(i);
        }
      }
    }
    this._idxDirty = false;
  }

  // 找到 cursor 处能吃到的最表层食物索引，找不到返回 -1
  // "最表层" = 最高索引的命中(与旧版倒序扫描语义一致)
  foodAt(px, py) {
    const patches = this.foodPatches;
    if (patches.length <= LINEAR_MAX) {
      for (let i = patches.length - 1; i >= 0; i--) {
        const f = patches[i];
        if (f.amount <= 0) continue;
        const d = Math.hypot(px - f.x, py - f.y);
        if (d < f.radius) return i;
      }
      return -1;
    }
    if (this._idxDirty) this._rebuildIndex();
    const cell = this._cell, cw = this._cw, ch = this._ch;
    const gx = ((Math.floor(px / cell) % cw) + cw) % cw;
    const gy = ((Math.floor(py / cell) % ch) + ch) % ch;
    const arr = this._idx.get(gy * cw + gx);
    if (!arr) return -1;
    let best = -1;
    for (let j = arr.length - 1; j >= 0; j--) {   // 倒序 → 先遇到最高索引
      const f = patches[arr[j]];
      if (f.amount <= 0) continue; // 采空的食物不能再吃(与线性路径语义一致; 索引桶不因采空而重建)
      const d = Math.hypot(px - f.x, py - f.y);
      if (d < f.radius) return arr[j];
    }
    return best;
  }

  // 移除一块食物(玩家"搬走/吃光"用)
  removeFood(index) {
    if (index >= 0 && index < this.foodPatches.length) {
      this.foodPatches.splice(index, 1);
      this._idxDirty = true;
    }
  }

  removeFoodAt(px, py) {
    const i = this.foodAt(px, py);
    if (i >= 0) this.removeFood(i);
    return i >= 0;
  }

  clear() {
    this.foodPatches.length = 0;
    this._idxDirty = true;
  }
}
