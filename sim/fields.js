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
  // P2.6 成本测量后的第一处改刀(全项目唯一一处**位级安全**的规模化优化, 依据见 METRICS P2.6 §3):
  // 旧写法 8 次 ((v % g) + g) % g —— 双取模是整数除法, V8 微基准实测 4 组 = 64.6 ns,
  // 而一步里每只蚁要采 3 次触角(开 alarm 时 6 次), 于是这一处占掉每蚁每步 ~5% 的成本。
  // 换成一次条件回绕实测 4 组 = 18.4 ns。
  // **为什么位级安全**: 这里改的是"选哪一个下标"的整数运算, 不是任何浮点表达式;
  // 两种写法对同一输入选出的四个下标完全相同(整数算术无舍入), 所以四钉必须逐位不变——
  // 这不是我的断言, 是 perf_check 的读数(见 METRICS P2.6 §3 的表)。
  // 前提: 触角点越界量 |Δ| ≤ sensorDist/cell, 而 (sensorDist/cell)/(worldW/cell) = sensorDist/worldW
  //       ≤ 80/400 = 0.2 ⇒ ix ∈ [-0.2gw, 1.2gw], 一次加减必定落回 [0, gw)。
  //       落不回去(参数被人推到边界外)时退回取模, 这条兜底不是装饰: 越界一次以上仍然正确, 只是慢。
  sample(x, y) {
    const cs = this.cellSize;
    const gx = x / cs;
    const gy = y / cs;
    let ix = Math.floor(gx);
    let iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;

    const gw = this.gw, gh = this.gh;
    // wrap(见上面那段推导: 快路径只有两次比较, 除法只在兜底里)
    if (ix < 0) ix += gw; else if (ix >= gw) ix -= gw;
    if (iy < 0) iy += gh; else if (iy >= gh) iy -= gh;
    if (ix < 0 || ix >= gw) ix = ((ix % gw) + gw) % gw;
    if (iy < 0 || iy >= gh) iy = ((iy % gh) + gh) % gh;
    const x0 = ix, y0 = iy * gw;
    const x1 = ix + 1 === gw ? 0 : ix + 1;
    const y1 = iy + 1 === gh ? 0 : iy + 1;

    const b = this.buf;
    const r1 = y1 * gw;
    const v00 = b[y0 + x0];
    const v10 = b[y0 + x1];
    const v01 = b[r1 + x0];
    const v11 = b[r1 + x1];

    // 双线性插值：v00 + (v10-v00)*fx + (v01-v00)*fy + (v11-v10-v01+v00)*fx*fy
    const a = v00 + (v10 - v00) * fx;
    const b1 = v01 + (v11 - v01) * fx;
    return a + (b1 - a) * fy;
  }

  // ---- 沉积（加性，toroidal） ----
  deposit(x, y, amount) {
    const gw = this.gw, gh = this.gh;
    let ix = Math.round(x / this.cellSize);
    let iy = Math.round(y / this.cellSize);
    // 同 sample(): 沉积点由蚂蚁位置四舍五入而来, 而位置恒在 [0, w) ⇒ 连回绕都不该发生,
    // 但这里不赌: 与 sample 同一套"一次条件回绕 + 越界退回取模", 两条路径选出同一个下标。
    if (ix < 0) ix += gw; else if (ix >= gw) ix -= gw;
    if (iy < 0) iy += gh; else if (iy >= gh) iy -= gh;
    if (ix < 0 || ix >= gw) ix = ((ix % gw) + gw) % gw;
    if (iy < 0 || iy >= gh) iy = ((iy % gh) + gh) % gh;
    this.buf[iy * gw + ix] += amount;
  }

  // ---- 沉积到临时缓冲（用于 colony 批量沉积） ----
  depositTo(x, y, amount, target) {
    const gw = this.gw, gh = this.gh;
    let ix = Math.round(x / this.cellSize);
    let iy = Math.round(y / this.cellSize);
    if (ix < 0) ix += gw; else if (ix >= gw) ix -= gw;
    if (iy < 0) iy += gh; else if (iy >= gh) iy -= gh;
    if (ix < 0 || ix >= gw) ix = ((ix % gw) + gw) % gw;
    if (iy < 0 || iy >= gh) iy = ((iy % gh) + gh) % gh;
    target[iy * gw + ix] += amount;
  }

  // ---- 扩散 + 衰减（3x3 加权模糊） ----
  // 核: [1,2,1; 2,4,2; 1,2,1]，归一化除 16
  // new = (1-dw)*old + dw*blurred, 然后 *= decay
  // 热路径优化：内部列直接用 x±1 索引（无 modulo），只有行边界和列边界走 wrap；
  // 算术顺序与朴素版完全一致，保证 bit 级复现。要求 gw>=2（schema 下界 400/24≫2）。
  // walls(P2.1): 可选墙掩码(Uint8Array, 与本场同 gw×gh)。扩散后把墙格清零——
  // 信息素渗不进墙体, 墙格恒 0 也保证下一步从墙内扩散出的贡献为 0(不透墙)。
  // walls 为空时零开销(热路径不变, no-wall bit 级一致)。
  step(dw, decay, walls) {
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

    // P2.1: 墙格清零(扩散写进墙体的值直接丢弃)。掩码尺寸不符时静默忽略(防御,
    // world.cell 与 field.cellSize 应由调用方保证一致)。
    if (walls && walls.length === this.len) {
      for (let i = 0; i < this.len; i++) if (walls[i]) dst[i] = 0;
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