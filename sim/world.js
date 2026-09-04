// 地形：目前 P0 只有食物斑块（patch 形式），巢是一个固定位置。
// 水/火/障碍是后面阶段的事。食物场仍是"场"，但用稀疏 patch 存储更省。
//
// 性能注记：foodAt 在仿真主循环里被每蚂蚁每步调用。patch 很少时（≤LINEAR_MAX）
// 保留原倒序线性扫描（语义 = 返回"最高索引的命中"，与 bit 级基线一致）；
// 玩家大量撒食物时自动切换到均匀网格索引（查询只看邻近桶），命中语义不变。

const LINEAR_MAX = 16;   // patch 数 ≤ 此值走线性扫描
const CELL = 160;        // 索引格子边长(世界单位),≥2×最大 radius 时查询只需 3×3 桶

export class World {
  constructor(w, h, cell = 8) {
    this.w = w;
    this.h = h;
    this.foodPatches = [];   // { x, y, radius, amount }
    this.nestX = w / 2;
    this.nestY = h / 2;
    this._idx = null;        // 均匀网格: Map<cellKey, number[]> → patch 索引
    this._idxDirty = true;

    // ---- 障碍墙(P2.1): 与信息素场同分辨率的 Uint8 网格, 惰性分配 ----
    // cell 建议传 field.cellSize(app.js 传 gridCell), 场扩散掩码/渲染直接对齐。
    // wallCount===0 时所有墙查询/阻挡/掩码全部短路——旧行为 bit 级不变。
    this.cell = cell;
    this.gw = Math.ceil(w / cell);
    this.gh = Math.ceil(h / cell);
    this.walls = null;       // Uint8Array(gw*gh), 1=墙
    this.wallCount = 0;      // 墙格总数(>0 才启用墙逻辑)
    this.wallVersion = 0;    // 每次墙变化 +1(渲染缓存失效用)
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

  // ---- 障碍墙(P2.1) ----
  // 圆刷子涂/擦墙: 覆盖 (wx,wy) 半径 radius 圆内的格心格。环面距离——贴边画的墙
  // 在对侧同样生效, 不留 seam 缺口(世界是环面, 信息素/蚂蚁都在环绕)。
  paintWall(wx, wy, radius, on) {
    this._ensureWalls();
    const walls = this.walls, gw = this.gw, gh = this.gh, cell = this.cell;
    const W = this.w, H = this.h;
    const g0 = Math.floor((wx - radius) / cell), g1 = Math.floor((wx + radius) / cell);
    const h0 = Math.floor((wy - radius) / cell), h1 = Math.floor((wy + radius) / cell);
    const r2 = radius * radius;
    let changed = false;
    for (let gy = h0; gy <= h1; gy++) {
      const cy = (gy + 0.5) * cell;
      let dy = cy - wy;
      if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      for (let gx = g0; gx <= g1; gx++) {
        const cx = (gx + 0.5) * cell;
        let dx = cx - wx;
        if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        if (dx * dx + dy * dy > r2) continue;
        const ix = ((gx % gw) + gw) % gw;
        const iy = ((gy % gh) + gh) % gh;
        const k = iy * gw + ix;
        if (on) {
          if (!walls[k]) { walls[k] = 1; this.wallCount++; changed = true; }
        } else if (walls[k]) {
          walls[k] = 0; this.wallCount--; changed = true;
        }
      }
    }
    if (changed) this.wallVersion++;
  }

  clearWalls() {
    if (!this.walls || this.wallCount === 0) return;
    this.walls.fill(0);
    this.wallCount = 0;
    this.wallVersion++;
  }

  // (wx,wy) 处是否是墙: 1=是, 0=否。无墙时 O(1) 短路。坐标可为任意实数(环面取模)。
  wallAt(wx, wy) {
    if (this.wallCount === 0) return 0;
    const gw = this.gw, gh = this.gh, cell = this.cell;
    const ix = ((Math.floor(wx / cell) % gw) + gw) % gw;
    const iy = ((Math.floor(wy / cell) % gh) + gh) % gh;
    return this.walls[iy * gw + ix];
  }

  _ensureWalls() {
    if (!this.walls) this.walls = new Uint8Array(this.gw * this.gh);
  }

  clear() {
    this.foodPatches.length = 0;
    this._idxDirty = true;
  }
}
