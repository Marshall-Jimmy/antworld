// perception_check.mjs — P2.3.4 侧抑制的**合成信号**门禁(不跑 sim,秒级)。
//
// 为什么必须有这个文件: render/perception.js 的注释里写着「合成用例 ④⑤ 把这条边界钉成可跑断言」
// 和「实测让合成用例 ⑤ 从逐位一致退到 8.9e-8」——本轮开工时仓库里**没有**这样的脚本,那个 8.9e-8
// 也复现不出来。HANDOVER §10 管住了「量具不许有看起来在测其实没测的行」,这里补上它的镜像那条:
// **注释也不许引用"跑过其实没跑"的证据**。于是有了本脚本:断言全部是解析可推的,数字当场打印。
//
// 六条(每条都写明期望值的推导,不是阈值调出来的):
//   ① 门控 = 返回**同一个数组对象**(lateralK=0 时连拷贝都不做)⇒ 三条渲染路径逐字节不变的根
//   ② 孤立热点不被自己减掉:环 = 盒(r) − 盒(r−1) ⇒ 中心格自动落在环外
//   ③ 「选环不选盒」的算术依据,三档:
//      ③a 孤立方核(半边长 h ≤ R−1):环上无物 ⇒ 保留 100%;盒 = 1 − K(2h+1)²/(2R+1)²
//      ③b 又长又直的走廊(宽 w ≤ 2R−1):环 = 1 − K·w/(4R)——**注意不是 1**:走廊自己在触角方向上
//         就占掉环的 w/(4R)。这是物理不是 bug:站在路上的蚂蚁看得见路往前延伸。
//         盒 = 1 − K·w/(2R+1) ⇒ R=3 时盒比环多砍 71%。
//      ③c 半径敏感性:同一场把 R 从 3 降到 1,窄走廊立刻被吞 ⇒ 半径这个派生量是真的在起作用
//   ④ 宽板(宽 ≥ 2R+1)中心 = c(1−K);K=1 归零 ⇒ 比触角还宽又内部均匀的一片没有方向信息(设计语义)
//   ⑤ O(n) 滑窗的环和 ≡ 逐格暴力数 8r 个邻居 ⇒ 快速实现没写错(环面寻址最容易错的就是这里)
//   ⑥ 累加缓冲 Float64 vs Float32 的实际损失 ⇒ 给代码里那句「白送 1e-7 量级误差」一个可查的数
//
// 用法: node perception_check.mjs     (只读:不写产品代码、不落盘)
import { values } from "./core/config.js";
import { displayField, perceivedField, boxMean, lateralRadius } from "./render/perception.js";

const DEF = { ...values };
const GW = 41, GH = 41, C = 10;          // 41 > 4×(2R+1):合成结构离环面接缝足够远
const R = 3;                             // 出厂环半径 = round(触角 26u / 8u) = 3
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name + (detail ? "   | " + detail : "")); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   | " + detail : "")); }
}
const eq = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
const mk = () => ({ buf: new Float32Array(GW * GH), gw: GW, gh: GH, cellSize: 8 });
const at = (x, y) => y * GW + x;
function reset() { for (const k in DEF) values[k] = DEF[k]; }
function run(field, k, rOv) {          // 取一份输出拷贝(模块内的缓冲是逐帧复用的)
  reset(); values.lateralK = k;
  return Float32Array.from(perceivedField(field, rOv));
}
function band(field, w) {              // 横贯全高的走廊,值 C,余处 0
  const x0 = (GW - w) >> 1;
  for (let x = x0; x < x0 + w; x++) for (let y = 0; y < GH; y++) field.buf[at(x, y)] = C;
  return x0 + (w >> 1);               // 返回走廊中心列
}
function blob(field, h) {              // 边长 2h+1 的孤立方核
  for (let y = 20 - h; y <= 20 + h; y++) for (let x = 20 - h; x <= 20 + h; x++) field.buf[at(x, y)] = C;
  return at(20, 20);
}
const boxKeep = (field, r, i) => (C - DEF.lateralK * boxMean(field, r, new Float64Array(GW * GH))[i]) / C;

console.log("=== P2.3.4 侧抑制 · 合成信号门禁 ===");
reset();
ok("半径派生 lateralRadius = round(sensorDist/cellSize) = " + R,
  lateralRadius(mk()) === R, "实得 " + lateralRadius(mk()) + " 格 (触角 " + (values.sensorDist / 8).toFixed(2) + " 格)");

// ── ① 门控 ──
{
  const f = mk(); band(f, 3);
  reset(); values.lateralK = 0;
  ok("① K=0: perceivedField() 返回的就是 field.buf 这一个对象(零拷贝)", perceivedField(f) === f.buf);
  ok("① K=0: displayField() 返回的就是 field 这一个对象(下游每条路径逐字不变)", displayField(f) === f);
  const g = run(f, 0);
  let same = true; for (let i = 0; i < GW * GH; i++) if (g[i] !== f.buf[i]) { same = false; break; }
  ok("① K=0: 输出与输入逐位相同", same);
}
// ── ② 中心格不参与自己的周边 ──
{
  const f = mk(); f.buf[at(20, 20)] = C;
  const o = run(f, 1);                 // K=1 是最狠的一档:中心若被算进周边,这一格会直接归零
  ok("② 孤立热点在 K=1 下原值保留(环不含中心)", o[at(20, 20)] === C, "实得 " + o[at(20, 20)]);
}
// ── ③ 环 vs 盒 ──
for (const h of [1, 2]) {
  const f = mk(); const i = blob(f, h);
  const kr = run(f, DEF.lateralK)[i] / C, kb = boxKeep(mk0(h), R, i);
  const wantB = 1 - DEF.lateralK * (2 * h + 1) ** 2 / (2 * R + 1) ** 2;
  ok("③a 孤立方核 " + (2 * h + 1) + "×" + (2 * h + 1) + ": 环式保留 100%", kr === 1, "实得 " + (100 * kr).toFixed(2) + "%");
  ok("③a 同一条核: 盒式 = 1−K(2h+1)²/(2R+1)²", eq(kb, wantB),
    "盒 " + (100 * kb).toFixed(2) + "% vs 环 100.00% (推导 " + (100 * wantB).toFixed(2) + "%)");
  function mk0(hh) { const g = mk(); blob(g, hh); return g; }
}
for (const w of [3, 5]) {
  const f = mk(); const xc = band(f, w);
  const kr = run(f, DEF.lateralK)[at(xc, 20)] / C, kb = boxKeep(f, R, at(xc, 20));
  const wantR = 1 - DEF.lateralK * w / (4 * R), wantB = 1 - DEF.lateralK * w / (2 * R + 1);
  ok("③b 长走廊 宽" + w + ": 环式 = 1−K·w/(4R)", eq(kr, wantR), "实得 " + (100 * kr).toFixed(2) + "% 推导 " + (100 * wantR).toFixed(2) + "%");
  ok("③b 同一条走廊: 盒式 = 1−K·w/(2R+1)(比环多砍)", eq(kb, wantB) && kb < kr,
    "盒 " + (100 * kb).toFixed(2) + "% vs 环 " + (100 * kr).toFixed(2) + "% ⇒ 盒多砍 " + (100 * (kr - kb) / kr).toFixed(0) + "%");
}
{
  const f = mk(); const xc = band(f, 3);
  const r3 = run(f, DEF.lateralK)[at(xc, 20)] / C, r1 = run(f, DEF.lateralK, 1)[at(xc, 20)] / C;
  ok("③c 半径覆写真的生效: R=1 时宽 3 的走廊被自己吞掉", r1 < r3 - 0.2, "R=3 保 " + (100 * r3).toFixed(1) + "% → R=1 保 " + (100 * r1).toFixed(1) + "%");
}
// ── ④ 比触角宽的均匀板 ──
for (const K of [0.5, 1]) {
  const f = mk(); const xc = band(f, 15);
  const got = run(f, K)[at(xc, 20)] / C, want = 1 - K;
  ok("④ 宽 15(≥2R+1) 均匀板中心 = c(1−K), K=" + K, eq(got, want), "实得 " + got.toFixed(6) + " 推导 " + want.toFixed(6));
}
// ── ⑤ 滑窗 ≡ 暴力 ──
{
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const f = mk(); for (let i = 0; i < GW * GH; i++) f.buf[i] = rnd() * rnd() * 50;
  const K = 0.7, o = run(f, K);
  let worst = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let sum = 0;
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== R) continue;
      sum += f.buf[at(((x + dx) % GW + GW) % GW, ((y + dy) % GH + GH) % GH)];
    }
    worst = Math.max(worst, Math.abs(Math.max(0, f.buf[at(x, y)] - K * sum / (8 * R)) - o[at(x, y)]));
  }
  ok("⑤ O(n) 滑窗环和 ≡ 逐格暴力 8r=" + 8 * R + " 个邻居(随机场, K=0.7)", worst < 1e-3, "最大偏差 " + worst.toExponential(2));
}
// ── ⑥ Float64 vs Float32 累加 ──
{
  let s = 999; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const f = mk(); for (let i = 0; i < GW * GH; i++) f.buf[i] = rnd() * rnd() * 50;
  function slide(AC, r) {              // 独立实现一遍滑窗(与产品代码同构,用来做对照)
    const T = new AC(GW * GH), O = new AC(GW * GH);
    for (let y = 0; y < GH; y++) { const row = y * GW; let s0 = 0;
      for (let x = -r; x <= r; x++) s0 += f.buf[row + (((x % GW) + GW) % GW)];
      for (let x = 0; x < GW; x++) { T[row + x] = s0;
        s0 += f.buf[row + ((x + r + 1) % GW)] - f.buf[row + ((x + GW - r) % GW)]; } }
    for (let x = 0; x < GW; x++) { let s1 = 0;
      for (let y = -r; y <= r; y++) s1 += T[(((y % GH) + GH) % GH) * GW + x];
      for (let y = 0; y < GH; y++) { O[y * GW + x] = s1;
        s1 += T[((y + r + 1) % GH) * GW + x] - T[((y + GH - r) % GH) * GW + x]; } }
    return O;
  }
  const K = 0.5, prod = run(f, K);
  const outOf = (AC) => { const A = slide(AC, R), B = slide(AC, R - 1), o = new Float32Array(GW * GH);
    for (let i = 0; i < GW * GH; i++) o[i] = Math.max(0, f.buf[i] - K * (A[i] - B[i]) / (8 * R)); return o; };
  const ref = outOf(Float64Array), f32 = outOf(Float32Array);
  let w2 = 0, w1 = 0;
  for (let i = 0; i < GW * GH; i++) { w2 = Math.max(w2, Math.abs(prod[i] - ref[i])); w1 = Math.max(w1, Math.abs(f32[i] - ref[i])); }
  ok("⑥ 本脚本的独立滑窗 ≡ 产品实现", w2 < 1e-3, "最大偏差 " + w2.toExponential(2));
  let mx = 0; for (let i = 0; i < GW * GH; i++) mx = Math.max(mx, ref[i]);
  console.log("  NOTE  ⑥ 同构滑窗换回 Float32 累加的最大偏差 " + w1.toExponential(2)
    + " (浓度 0–50, 场 " + GW + "×" + GH + ", 输出上界 " + mx.toFixed(2) + ") ⇒ 代码注释里的量级以这一行为准");
}
reset();
console.log("\n=== 合计 " + pass + " PASS / " + fail + " FAIL ===");
process.exit(fail ? 1 : 0);