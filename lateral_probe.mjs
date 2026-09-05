// lateral_probe.mjs — P2.3.4 光污染 III 的**只读原型**量具（v2）。**不写产品代码、不落盘。**
// 把 render/perception.js 的侧抑制接到 glow_check 的离路分箱量具上,先量再决定出厂值。
//
// ── 预登记判据(v1,写死在看任何结果之前;对照 = 同场景同曝光无侧抑制那一行) ──
//   L1 死光(离路>触角的格发出的光占全图比例) ≤ 0.60× 对照   ← 主目标:共模雾至少压掉四成
//   L2 走廊亮度 roadL ≥ 0.75× 对照                        ← 反作弊:不许靠"整体拉黑"过关
//   L3 路格可辨 8 位亮度级数 ≥ 1.00× 对照                  ← 结构可读性不能退
//   L4 雾亮比 ρ(触角外一圈/走廊) ≤ 1.00× 对照              ← 触角外的雾不许相对更显眼
//   取法:在 R=3(派生自触角)的环式变体里取满足 L1–L4 的最大 K;一个都不满足 ⇒ 本阶段放弃、如实入库。
//
// ── v1 的裁决与两条更正(读数是 logs/_lat_probe_v1.txt,原样保留、判据一字未改) ──
//   v1 结论:**没有任何变体过 L1–L4**——L1/L4 大绿(死光 0.00×、ρ 0.00×),但 L3 级数全拦(0.67–0.96×)。
//   (1) 锚点更正(一致性要求,不是第二个旋钮):v1 把曝光锚点钉在"原始蚁脚剂量"上、画面却换成减过背景的
//       显示量 ⇒ 拿化学计量当尺子量一张画反差的图,越压越黑是**必然**而不是代价。出厂接线本来就是
//       "锚点与画面共用同一个 displayField()",所以 v2 一律走 displayField()——量上线的那份代码。
//   (2) L3 这把尺子有毛病(如实记、不偷偷改):级数随"亮度带整体下移"而变小 ⇒ 它**奖励共模底座**,
//       也就是奖励光污染本身,而侧抑制要拿掉的正是底座。L3 原判据与原读数保留入库,v2 另加两条
//       尺度无关的结构尺子,同时把"路格存活率"单列成**明着的代价**:
//         L3b 路格八度跨度 log2(p99/p50) ≥ 对照   ← 走廊占掉多少条色阶,这才是可读性
//         L3c 路格相对反差 std(L)/mean(L) ≥ 对照   ← Weber 式局部反差
//         roadKeep = 减完之后仍在发光的路格占原路格的比例
//
//   (3) v3 更正(自查发现,读数未受影响)：v1/v2 的「环R1 K1」敏感性行**没把覆写半径传进 displayField()**,
//       于是那一行打印的是上一行的复读——就是本节上面那条红线说的毛病。v3 接上覆写并保留原标签。
//
// 用法: node lateral_probe.mjs                       (9 次 sim,空载约 7 分钟)
//       BENCH=300 node lateral_probe.mjs             (只量单帧显示量成本,不跑判据)
//       SEEDS=glare SCEN=rich DWS=0.02 node lateral_probe.mjs   分组快跑
import { values } from "./core/config.js";
import { rng, hashSeed } from "./core/rng.js";
import { Field } from "./sim/fields.js";
import { World } from "./sim/world.js";
import { Colony } from "./sim/colony.js";
import { Weather, weatherActive } from "./core/weather.js";
import { tone, rampColor, FIELD_STOPS } from "./render/palette.js";
import { updateExposure, effPeak, resetExposure } from "./render/exposure.js";
import { displayField, perceivedField, boxMean, lateralRadius } from "./render/perception.js";

const DT = 1 / 60, DEF = { ...values };
const LUM = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const _a = [0, 0, 0];
const TRAIL = 40, MAXD = 20;
const SEEDS = (process.env.SEEDS || "glare,wxcheck,predcheck").split(",");
const SCEN = (process.env.SCEN || "rich,normal").split(",");
const DW = (process.env.DWS || "0.02,0.06").split(",").map(Number);
const KS = (process.env.KS || "0.25,0.5,0.75,1").split(",").map(Number);

const SCENARIOS = {
  rich: { secs: 240, food: 1e6, day: 1 },
  normal: { secs: 60, food: 200, day: 0 },   // 200 = 出厂食源,才是玩家默认看到的画面
};

function runSim(dw, seed, scen) {
  const S = SCENARIOS[scen];
  for (const k in DEF) values[k] = DEF[k];
  values.dayNight = S.day; values.dayLength = 240; values.tempSwing = 0; values.diffuseWeight = dw;
  if (dw === 0.06) values.K_route = 0;   // 回退钉:这一臂的语义是复现 P2.4/P2.3.2,成熟度门必须关
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  if (S.food) world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, S.food);
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(seed)), world, nestRadius: values.nestRadius });
  const weather = new Weather(seed);
  const cs = field.cellSize, gw = field.gw, gh = field.gh;
  const road = new Uint8Array(field.len);
  for (let s = 0; s < S.secs; s++) {
    for (let k = 0; k < 60; k++) {
      const env = weatherActive(values) ? weather.step(DT, values) : null;
      field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * (env ? env.wash : 1)), null);
      colony.step(field, world, values, DT, null, env);
      if (s >= S.secs - TRAIL) {
        for (let i = 0; i < colony.count; i++) {
          if (colony.load[i] > 0) {
            const gx = Math.round(colony.px[i] / cs), gy = Math.round(colony.py[i] / cs);
            road[(((gy % gh) + gh) % gh) * gw + (((gx % gw) + gw) % gw)] = 1;
          }
        }
      }
    }
  }
  return { field, colony, road };
}

function distField(field, road) {
  const gw = field.gw, n = field.len;
  const d = new Int32Array(n).fill(-1);
  const q = new Int32Array(n); let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (road[i]) { d[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const c = q[qh++], x = c % gw, y = (c / gw) | 0, nd = d[c] + 1;
    if (x > 0 && d[c - 1] < 0) { d[c - 1] = nd; q[qt++] = c - 1; }
    if (x < gw - 1 && d[c + 1] < 0) { d[c + 1] = nd; q[qt++] = c + 1; }
    if (y > 0 && d[c - gw] < 0) { d[c - gw] = nd; q[qt++] = c - gw; }
    if (y < field.gh - 1 && d[c + gw] < 0) { d[c + gw] = nd; q[qt++] = c + gw; }
  }
  return d;
}

// 分箱量具(与 glow_check 同一把尺子) + v2 新增的结构量
function profile(field, d, disp, peak, reach) {
  const arr = disp.buf;
  const n = arr.length;
  const sum = new Float64Array(MAXD + 1), cnt = new Int32Array(MAXD + 1);
  let sumL = 0, deadL = 0, lit = 0, zero = 0;
  const roadL = [], roadV = [];
  for (let i = 0; i < n; i++) {
    const raw = field.buf[i];
    const v = arr[i];
    if (v <= 0) { if (raw > 0) zero++; if (d[i] === 0 && raw > 0) roadL.push(-1); continue; }
    rampColor(FIELD_STOPS, tone(v / peak), _a);
    const L = LUM(_a);
    if (L <= 0) continue;
    sumL += L; if (L > 0.004) lit++;
    const di = d[i];
    if (di >= 0 && di <= MAXD) { sum[di] += L; cnt[di]++; }
    if (di > reach) deadL += L;
    if (di === 0) { roadL.push(L); roadV.push(v); }
  }
  const mean = (k) => (cnt[k] ? sum[k] / cnt[k] : 0);
  const live = roadL.filter((x) => x >= 0);
  const roadMean = live.length ? live.reduce((a, b) => a + b, 0) / live.length : 0;
  const kNear = Math.max(1, Math.round(reach)), kFar = Math.min(MAXD, Math.round(reach * 2));
  let hs = 0, hc = 0;
  for (let k = kNear + 1; k <= kFar; k++) { hs += mean(k); hc++; }
  let r25 = 0;
  for (let k = 0; k <= MAXD; k++) if (mean(k) >= 0.25 * roadMean) r25 = k;
  // 结构量:路格八度跨度(p99/p50)与相对反差(std/mean)
  const vs = roadV.slice().sort((a, b) => a - b);
  const p50 = vs.length ? vs[(vs.length * 0.5) | 0] : 0, p99 = vs.length ? vs[Math.min(vs.length - 1, (vs.length * 0.99) | 0)] : 0;
  const oct = p50 > 0 && p99 > 0 ? Math.log2(p99 / p50) : 0;
  let ss = 0; for (const x of live) ss += (x - roadMean) * (x - roadMean);
  const rc = live.length && roadMean > 0 ? Math.sqrt(ss / live.length) / roadMean : 0;
  const levels = new Set(live.map((x) => Math.round(x * 255))).size;
  return { peak, roadL: roadMean, rho: hc ? hs / hc / roadMean : 0, r25,
    dead: sumL ? 100 * deadL / sumL : 0, meanL: sumL / n, litPct: 100 * lit / n,
    zeroPct: 100 * zero / n, levels, oct, relC: rc,
    roadKeep: roadL.length ? 100 * live.length / roadL.length : 100 };
}

if (process.env.BENCH) {
  // 每帧一次显示量 = 浏览器里最贵的渲染层新增开销。要量在真场上：合成场的缓存行为不像话。
  // 对照三条：K=0 门控(立刻返回)、一次纯拷贝(内存带宽下界)、boxMean(假如当初选盒式会付多少)。
  const { field } = runSim(0.02, "glare", "rich");
  const N = Number(process.env.BENCH) || 300;
  const gw = field.gw, gh = field.gh, n = field.len;
  const ms = (f, reps) => { const a = performance.now(); for (let i = 0; i < reps; i++) f(); return (performance.now() - a) / reps; };
  values.lateralK = 0; for (let i = 0; i < 50; i++) perceivedField(field);
  const off = ms(() => perceivedField(field), N * 4);
  const dst = new Float32Array(n); let sink = 0;
  const copy = ms(() => { dst.set(field.buf); for (let i = 0; i < n; i += 4099) sink += dst[i]; }, N);
  values.lateralK = DEF.lateralK; const rr = lateralRadius(field); for (let i = 0; i < 50; i++) perceivedField(field);
  const ring = ms(() => { const o = perceivedField(field); for (let i = 0; i < n; i += 4099) sink += o[i]; }, N);
  const bx = new Float64Array(n); values.lateralK = DEF.lateralK;
  const boxc = ms(() => { boxMean(field, rr, bx); for (let i = 0; i < n; i += 4099) sink += bx[i]; }, N);
  console.log("场 " + gw + "x" + gh + " = " + n + " 格 | 环半径 " + rr + " 格 | reps=" + N + " (JIT 预热 50 次后取均值)");
  console.log("  K=0 门控          " + (off * 1000).toFixed(2) + " µs/帧  (" + (off / 16.667 * 100).toFixed(3) + "% 帧预算)");
  console.log("  纯拷贝(带宽下界)  " + copy.toFixed(3) + " ms/帧  (" + (copy / 16.667 * 100).toFixed(2) + "%)");
  console.log("  环式 K=" + DEF.lateralK + " (出厂) " + ring.toFixed(3) + " ms/帧  (" + (ring / 16.667 * 100).toFixed(2) + "%) 判定 " + (ring <= 0.5 ? "≤0.5ms ✓" : "超预算 ✗"));
  console.log("  盒式(未采用)      " + boxc.toFixed(3) + " ms/帧  ⇒ 环比盒只贵在这一行差值上");
  console.log("  sink " + sink.toFixed(0) + " (防死代码消除)");
  process.exit(0);
}
const rows = [];
for (const scen of SCEN) for (const seed of SEEDS) for (const dw of DW) {
  if (scen === "normal" && dw !== 0.02) continue;
  const { field, colony, road } = runSim(dw, seed, scen);
  const d = distField(field, road);
  const reach = values.sensorDist / field.cellSize;
  const T = SCENARIOS[scen].secs;
  const R0 = lateralRadius(field);
  const variants = [["无侧抑制", () => { values.lateralK = 0; }]];
  for (const K of KS) variants.push(["环R" + R0 + " K" + K, (function (k) { return () => { values.lateralK = k; }; })(K)]);
  variants.push(["环R1 K1", () => { values.lateralK = 1; }]);   // 只当"最小粒度"警世对照
  console.log("[" + scen + " " + seed + " dw=" + dw + "] 触角 " + reach.toFixed(2) + "格 | 派生环半径 " + R0 + "格");
  for (const [name, setK] of variants) {
    setK();
    // 敏感性行的半径必须真的传到取像处：v1/v2 这里覆写没被下游接住，于是这一行打印的是上一行的复读
    // ——正是 HANDOVER §10「量具不许有看起来在测其实没测的行」。v3 把它接上，并让标签自己报出半径。
    const rOv = name === "环R1 K1" ? 1 : 0;                            // 0=不覆写，走触角派生半径
    const disp = displayField(field, rOv);                             // ← 生产接线:锚点与画面同源
    resetExposure(); updateExposure(disp, colony, T);
    const p = profile(field, d, disp, effPeak(), reach);
    rows.push({ scen, seed, dw, name, ...p });
    console.log("   " + name.padEnd(12) + " peak " + p.peak.toFixed(2).padStart(7)
      + " | 走廊 " + p.roadL.toFixed(3) + " 级数 " + String(p.levels).padStart(3) + " 八度 " + p.oct.toFixed(2)
      + " 反差 " + p.relC.toFixed(3) + " 路格存活 " + p.roadKeep.toFixed(0) + "%"
      + " | ρ " + p.rho.toFixed(2) + " R25 " + String(p.r25).padStart(2)
      + " | 死光 " + p.dead.toFixed(1) + "% | 均亮 " + p.meanL.toFixed(4) + " 亮格 " + p.litPct.toFixed(1)
      + "% 归零格 " + p.zeroPct.toFixed(1) + "%");
  }
  values.lateralK = 0;
}

function agg(scen, dw, name, key) {
  const g = rows.filter((r) => r.scen === scen && r.dw === dw && r.name === name);
  return g.length ? g.reduce((a, b) => a + b[key], 0) / g.length : NaN;
}
const base = (dw, key) => agg("rich", dw, "无侧抑制", key);
console.log("\n=== 判据：L1/L2/L3/L4 是 v1 预登记原文;L3b/L3c 是 v2 更正里加的结构尺子(rich / 三种子均值) ===");
const RR = Math.round(DEF.sensorDist / DEF.gridCell);   // 派生环半径,与 product 同一条公式
for (const name of KS.map((K) => "环R" + RR + " K" + K).concat(["环R1 K1"])) {
  const dw = 0.02;
  const dead = agg("rich", dw, name, "dead"), roadL = agg("rich", dw, name, "roadL");
  const lev = agg("rich", dw, name, "levels"), rho = agg("rich", dw, name, "rho");
  const oct = agg("rich", dw, name, "oct"), rc = agg("rich", dw, name, "relC");
  const nrm = agg("normal", dw, name, "meanL"), bNrm = base(dw, "meanL");
  const j = [dead <= 0.6 * base(dw, "dead") ? "L1✓" : "L1✗", roadL >= 0.75 * base(dw, "roadL") ? "L2✓" : "L2✗",
    lev >= base(dw, "levels") ? "L3✓" : "L3✗", rho <= base(dw, "rho") ? "L4✓" : "L4✗",
    oct >= base(dw, "oct") ? "L3b✓" : "L3b✗", rc >= base(dw, "relC") ? "L3c✓" : "L3c✗"];
  console.log(name.padEnd(12) + " 死光 " + (dead / base(dw, "dead")).toFixed(2) + "× 走廊 "
    + (roadL / base(dw, "roadL")).toFixed(2) + "× 级数 " + (lev / base(dw, "levels")).toFixed(2) + "×"
    + " 八度 " + (oct / base(dw, "oct")).toFixed(2) + "× 反差 " + (rc / base(dw, "relC")).toFixed(2) + "×"
    + " 路格存活 " + agg("rich", dw, name, "roadKeep").toFixed(0) + "% R25 " + agg("rich", dw, name, "r25").toFixed(1)
    + "(vs " + base(dw, "r25").toFixed(1) + ") 常规均亮 " + (nrm / bNrm).toFixed(2) + "× → " + j.join(" "));
}
console.log("\n=== 尺度稳健性(dw=0.06 厚场,同一组判据) ===");
for (const name of KS.map((K) => "环R" + RR + " K" + K)) {
  const dw = 0.06;
  console.log(name.padEnd(12) + " 死光 " + (agg("rich", dw, name, "dead") / base(dw, "dead")).toFixed(2)
    + "× 走廊 " + (agg("rich", dw, name, "roadL") / base(dw, "roadL")).toFixed(2)
    + "× 级数 " + (agg("rich", dw, name, "levels") / base(dw, "levels")).toFixed(2)
    + "× 八度 " + (agg("rich", dw, name, "oct") / base(dw, "oct")).toFixed(2)
    + "× 反差 " + (agg("rich", dw, name, "relC") / base(dw, "relC")).toFixed(2)
    + "× 路格存活 " + agg("rich", dw, name, "roadKeep").toFixed(0) + "%");
}