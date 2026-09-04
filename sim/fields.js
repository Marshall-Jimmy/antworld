// 标量场：双线性采样 / 沉积 / 扩散 / 衰减。
// 由 Float32Array 承载，支持 toroidal 环面寻址。
// 扩散+衰减在 CPU 上完成（P0 阶段，后续可迁移到 GPU）。

export class Field {
  constructor(w, h, cellSize) {
    this.w = w;           // 世界宽度
    this.h = h;           // 世界高度
    this.cellSize = cellSize;
    this.gw = Math.ceil(w / cellSize);  // 网格列数
    this.gh = Math.ceil(h / cellSize);  // 网格行数
    this.len = this.gw * this.gh;
    this.buf = new Float32Array(this.len);
    this._tmp = new Float32Array(this.len);  // ping 缓冲
  }

  // ---- 双线性采样（toroidal wrap） ----
  sample(x, y) {
    const gx = x / this.cellSize;
    const gy = y / this.cellSize;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;

    const gw = this.gw, gh = this.gh;
    // wrap
    const x0 = ((ix % gw) + gw) % gw;
    const x1 = ((ix + 1) % gw + gw) % gw;
    const y0 = ((iy % gh) + gh) % gh;
    const y1 = ((iy + 1) % gh + gh) % gh;

    const b = this.buf;
    const v00 = b[y0 * gw + x0];
    const v10 = b[y0 * gw + x1];
    const v01 = b[y1 * gw + x0];
    const v11 = b[y1 * gw + x1];

    // 双线性插值：v00 + (v10-v00)*fx + (v01-v00)*fy + (v11-v10-v01+v00)*fx*fy
    const a = v00 + (v10 - v00) * fx;
    const b1 = v01 + (v11 - v01) * fx;
    return a + (b1 - a) * fy;
  }

  // ---- 沉积（加性，toroidal） ----
  deposit(x, y, amount) {
    const gx = Math.round(x / this.cellSize);
    const gy = Math.round(y / this.cellSize);
    const gw = this.gw, gh = this.gh;
    const ix = ((gx % gw) + gw) % gw;
    const iy = ((gy % gh) + gh) % gh;
    this.buf[iy * gw + ix] += amount;
  }

  // ---- 沉积到临时缓冲（用于 colony 批量沉积） ----
  depositTo(x, y, amount, target) {
    const gx = Math.round(x / this.cellSize);
    const gy = Math.round(y / this.cellSize);
    const gw = this.gw, gh = this.gh;
    const ix = ((gx % gw) + gw) % gw;
    const iy = ((gy % gh) + gh) % gh;
    target[iy * gw + ix] += amount;
  }

  // ---- 扩散 + 衰减（3x3 加权模糊） ----
  // 核: [1,2,1; 2,4,2; 1,2,1]，归一化除 16
  // new = (1-dw)*old + dw*blurred, 然后 *= decay
  // 热路径优化：内部列直接用 x±1 索引（无 modulo），只有行边界和列边界走 wrap；
  // 算术顺序与朴素版完全一致，保证 bit 级复现。要求 gw>=2（schema 下界 400/24≫2）。
  step(dw, decay) {
    const gw = this.gw, gh = this.gh;
    const src = this.buf;
    const dst = this._tmp;

    const dw16 = dw / 16;
    const inv = 1 - dw;
    const last = gw - 1;

    for (let y = 0; y < gh; y++) {
      const ym1 = (y === 0 ? gh - 1 : y - 1) * gw;
      const y0 = y * gw;
      const yp1 = (y === gh - 1 ? 0 : y + 1) * gw;

      // 内部列 x ∈ [1, gw-2]：无 wrap
      for (let x = 1; x < last; x++) {
        const c = src[y0 + x];
        const blur =
          src[ym1 + x - 1] * 1 + src[ym1 + x] * 2 + src[ym1 + x + 1] * 1 +
          src[y0 + x - 1] * 2 + c            * 4 + src[y0 + x + 1] * 2 +
          src[yp1 + x - 1] * 1 + src[yp1 + x] * 2 + src[yp1 + x + 1] * 1;
        dst[y0 + x] = (inv * c + dw16 * blur) * decay;
      }

      // 边界列 x=0（xm1 wrap 到 gw-1）
      {
        const c = src[y0];
        const blur =
          src[ym1 + last] * 1 + src[ym1] * 2 + src[ym1 + 1] * 1 +
          src[y0 + last] * 2 + src[y0] * 4 + src[y0 + 1] * 2 +
          src[yp1 + last] * 1 + src[yp1] * 2 + src[yp1 + 1] * 1;
        dst[y0] = (inv * c + dw16 * blur) * decay;
      }

      // 边界列 x=gw-1（xp1 wrap 到 0）；gw===1 时与上块同一格,直接跳过
      if (last > 0) {
        const x = last, xm = last - 1;
        const c = src[y0 + x];
        const blur =
          src[ym1 + xm] * 1 + src[ym1 + x] * 2 + src[ym1] * 1 +
          src[y0 + xm] * 2 + src[y0 + x] * 4 + src[y0] * 2 +
          src[yp1 + xm] * 1 + src[yp1 + x] * 2 + src[yp1] * 1;
        dst[y0 + x] = (inv * c + dw16 * blur) * decay;
      }
    }

    // 交换
    this.buf = dst;
    this._tmp = src;
  }

  // ---- 重置 ----
  clear() {
    this.buf.fill(0);
    this._tmp.fill(0);
  }
}