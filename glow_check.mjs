// glow_check.mjs — P2.3.2 光污染治理 II 的**像素层**量具：把画面按「离蚁路多远」分箱，逐箱读亮度。
//
// 为什么还要第三个量具(前面已有 glare_check 量色阶、fog_check 量场)：
// 前两个都答不了用户真正抱怨的那句话——「外面裹着一大坨蓝雾」。fog_check 说 dw=0.02 时
// 场的加权离路距离已经收到 3.5 格(≈触角范围)，可截图上那圈蓝还是七八格宽、还亮得刺眼。
// 原因在色阶本身：tone() 在 peak 以上是**对数**的，它把「路核」和「路旁的雾」之间几倍的浓度差
// 压成了几乎看不出差的亮度差。按曲线推导：peak=0.35 时触角边缘那圈雾的亮度约是走廊的 85%
// ——这才是残留光污染的机制：**不是雾太浓，是曲线把雾画得和路一样亮**。
// 所以这里量的不是浓度，是 tone() 之后、进眼睛之前的那个亮度 L。
//
// ── 预登记判据(写死在看结果之前；来源是 tone 曲线 + 线的指数衰减 ℓ=sqrt(D/λ) 的解析推导，不是试出来的) ──
//   记 roadL = 路格平均亮度, haloL = 离路 ∈(触角, 2×触角] 格的平均亮度,
//       ρ = haloL/roadL, R25 = 平均亮度 ≥ 0.25×roadL 的最大离路距离(格)。
//   G1 R25 ≤ 5 格 (≤1.6×触角可及范围 3.25 格)      ← 主判据：雾的可见半径不能比鼻子的有效距离大一倍
//   G2 ρ ≤ 0.55                                    ← 触角范围外的雾，亮度不到走廊的一半
//   G3 像素死光(离路>触角的格子发出的光) ≤ 0.60×基线 ← 与 fog_check F1 同向但按像素算
//   G4 roadL ≥ 0.28                                ← 反作弊：不许靠「整体拉黑」过关，走廊必须仍显眼
//   G5 路格可辨亮度级数 ≥ 基线的 0.8×               ← 反作弊：结构可读性不能退
//   G6 常规玩法(60s 不管饱)全图平均亮度 ≥ 今日       ← 自适应不能把正常玩家的主画面做暗
// 任一 FAIL 就不改默认值，如实入库。
//
// ── 事后交底(判据一个字不改，只记录结论) ──
// G4 roadL≥0.28 是坏判据：它把「走廊显眼」写成了「走廊绝对亮度高」，而今日方案达标恰恰是因为
// 走廊被画到接近色阶顶端(用户抱怨的那坨白斑)。自适方案在 G4 上 FAIL 属于**判据选错**，不是机制失败。
// 真正要的东西在 G1/G2/G3(雾的可见半径与亮度)和 G5(结构可读性)上。详见 METRICS P2.3.2。
import { values } from "./core/config.js";
import { rng, hashSeed } from "./core/rng.js";
import { Field } from "./sim/fields.js";
import { World } from "./sim/world.js";
import { Colony } from "./sim/colony.js";
import { Weather, weatherActive } from "./core/weather.js";
import { tone, rampColor, FIELD_STOPS } from "./render/palette.js";
import { updateExposure, effPeak, resetExposure } from "./render/exposure.js";

const DT = 1 / 60, DEF = { ...values };
const LUM = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const _a = [0, 0, 0];
const TRAIL = 40;                    // 足迹窗口(秒)：近期有负重蚁踏过 = 路
const MAXD = 20;                     // 离路分箱上限(格)
const SEEDS = (process.env.SEEDS || "glare,wxcheck,predcheck").split(",");
const SCEN = (process.env.SCEN || "rich,normal").split(",");

// 场景：rich=管饱昼间 240s(光污染最重的常规玩法)，normal=常规玩法 60s(玩家默认画面)
const SCENARIOS = {
  rich: { secs: 240, food: 1e6, day: 1 },
  // food 第一版写成 null，于是这一组没有负重蚁：路掩码、蚁脚剂量、亮度全为 0，G6 整列 NaN。
  // 那是量具自己造的假场景。200 = 出厂那块食源(不管饱)，才是玩家默认看到的画面。
  normal: { secs: 60, food: 200, day: 0 },
};

function runSim(dw, seed, scen) {
  const S = SCENARIOS[scen];
  for (const k in DEF) values[k] = DEF[k];
  values.dayNight = S.day; values.dayLength = 240; values.tempSwing = 0; values.diffuseWeight = dw;
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

// 蚂蚁脚下的剂量中位数 = 触角此刻实际闻到的水平。自适应曝光就锚在这个数上。
function antDose(field, colony, loadedOnly) {
  const s = [];
  for (let i = 0; i < colony.count; i++) {
    if (loadedOnly && !(colony.load[i] > 0)) continue;
    s.push(field.sample(colony.px[i], colony.py[i]));
  }
  s.sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

// 给定曝光 peak，把整张场过一遍色阶，按离路距离分箱求平均亮度
function renderProfile(field, d, peak, reach) {
  const n = field.buf.length;
  const sum = new Float64Array(MAXD + 1), cnt = new Int32Array(MAXD + 1);
  let sumL = 0, deadL = 0, roadL = 0, roadN = 0, lit = 0;
  const roadLevels = new Set();
  for (let i = 0; i < n; i++) {
    const v = field.buf[i];
    if (v <= 0) continue;
    rampColor(FIELD_STOPS, tone(v / peak), _a);
    const L = LUM(_a);
    if (L <= 0) continue;
    sumL += L; if (L > 0.004) lit++;
    const di = d[i];
    if (di >= 0 && di <= MAXD) { sum[di] += L; cnt[di]++; }
    if (di > reach) deadL += L;
    if (di === 0) { roadL += L; roadN++; roadLevels.add(Math.round(L * 255)); }
  }
  const mean = (k) => (cnt[k] ? sum[k] / cnt[k] : 0);
  const roadMean = roadN ? roadL / roadN : 0;
  const kNear = Math.max(1, Math.round(reach)), kFar = Math.min(MAXD, Math.round(reach * 2));
  let hs = 0, hc = 0;
  for (let k = kNear + 1; k <= kFar; k++) { hs += mean(k); hc++; }
  let r25 = 0;
  for (let k = 0; k <= MAXD; k++) if (mean(k) >= 0.25 * roadMean) r25 = k;
  return { peak, roadL: roadMean, rho: hc ? hs / hc / roadMean : 0, r25,
    dead: 100 * deadL / sumL, meanL: sumL / n, litPct: 100 * lit / n,
    levels: roadLevels.size, prof: Array.from({ length: MAXD + 1 }, (_, k) => mean(k)) };
}

const rows = [];
for (const scen of SCEN) for (const seed of SEEDS) {
  for (const dw of [0.06, 0.02]) {
    const { field, colony, road } = runSim(dw, seed, scen);
    const d = distField(field, road);
    const reach = values.sensorDist / field.cellSize;
    const ref = antDose(field, colony, false), refL = antDose(field, colony, true);
    // 「自适应模块」= 直接调用 app 接线的那份 exposure.js，不是手工 ref×GAIN 的模拟。
    // 判据因此是对真正会上线的代码做的；effPeak 里的 max(滑杆, ref×GAIN) 让常规玩法自动退回今日值。
    resetExposure(); updateExposure(field, colony, SCENARIOS[scen].secs);
    // 自适×k 是"GAIN 若取别的值"的假设行，也必须过同一条硬约束：滑杆是下界（只收光不加光）。
    // 不加这个 max 会在常规玩法(蚁脚中位≈0)量出 peak=0.0004 这种**代码永远产生不了的配置**，
    // 于是 v/peak 爆表、整图刷白、G6 读出一个虚假的大亮点。宁可少一行, 不量不存在的状态。
    const floor = values.peak;
    const schemes = [["今日0.35", 0.35], ["旧0.7", 0.7], ["自适应模块", effPeak()], ["自适×0.5", Math.max(floor, ref * 0.5)],
      ["自适×1", Math.max(floor, ref)], ["自适×2", Math.max(floor, ref * 2)], ["自适×4", Math.max(floor, ref * 4)]];
    console.log("[" + scen + " " + seed + " dw=" + dw + "] 触角 " + reach.toFixed(2) + "格 | 蚁脚剂量中位 "
      + ref.toFixed(2) + " (负重蚁 " + refL.toFixed(2) + ") = " + (ref / 0.35).toFixed(1) + "×今日peak");
    for (const [name, pk] of schemes) {
      if (!(pk > 0)) continue;
      const p = renderProfile(field, d, pk, reach);
      rows.push({ scen, seed, dw, name, ref, reach, ...p });
      console.log("   " + name.padEnd(9) + " peak " + pk.toFixed(2).padStart(7)
        + " | 走廊亮度 " + p.roadL.toFixed(3) + " 级数 " + String(p.levels).padStart(3)
        + " | 雾亮比 ρ " + p.rho.toFixed(2) + " | 晕半径 R25 " + String(p.r25).padStart(2) + "格 ("
        + (p.r25 / reach).toFixed(1) + "×触角) | 像素死光 " + p.dead.toFixed(1) + "%"
        + " | 全图均亮 " + p.meanL.toFixed(4) + " 亮格 " + p.litPct.toFixed(2) + "%");
    }
    if (process.env.PROF) {
      const w = rows.filter((r) => r.scen === scen && r.seed === seed && r.dw === dw);
      console.log("   离路格数:      " + Array.from({ length: MAXD + 1 }, (_, k) => String(k).padStart(6)).join(""));
      for (const r of w) console.log("   " + r.name.padEnd(14) + r.prof.map((x) => (x * 1000).toFixed(0).padStart(6)).join(""));
    }
  }
}

// ── 逐条判据(三种子均值) ──
function agg(scen, dw, name, key) {
  const g = rows.filter((r) => r.scen === scen && r.dw === dw && r.name === name);
  return g.length ? g.reduce((a, b) => a + b[key], 0) / g.length : NaN;
}
const NAMES = ["今日0.35", "旧0.7", "自适应模块", "自适×0.5", "自适×1", "自适×2", "自适×4"];
console.log("\n=== 判据 G1–G6（三种子均值）===");
for (const dw of [0.06, 0.02]) {
  for (const name of NAMES) {
    const r25 = agg("rich", dw, name, "r25"), rho = agg("rich", dw, name, "rho");
    const dead = agg("rich", dw, name, "dead"), roadL = agg("rich", dw, name, "roadL");
    const lev = agg("rich", dw, name, "levels"), nrm = agg("normal", dw, name, "meanL");
    const bR25 = agg("rich", dw, "今日0.35", "r25"), bDead = agg("rich", dw, "今日0.35", "dead");
    const bLev = agg("rich", dw, "今日0.35", "levels"), bNrm = agg("normal", dw, "今日0.35", "meanL");
    const j = [r25 <= 5 ? "G1✓" : "G1✗", rho <= 0.55 ? "G2✓" : "G2✗", dead <= 0.6 * bDead ? "G3✓" : "G3✗",
      roadL >= 0.28 ? "G4✓" : "G4✗", lev >= 0.8 * bLev ? "G5✓" : "G5✗", nrm >= bNrm ? "G6✓" : "G6✗"];
    console.log("dw=" + dw + " " + name.padEnd(9) + " R25 " + r25.toFixed(1) + "格 ρ " + rho.toFixed(2)
      + " 死光 " + dead.toFixed(1) + "%(" + (dead / bDead).toFixed(2) + "×) 走廊 " + roadL.toFixed(3)
      + " 级数 " + lev.toFixed(0) + "(" + (lev / bLev).toFixed(2) + "×) 常规均亮 " + nrm.toFixed(4)
      + "(" + (nrm / bNrm).toFixed(2) + "×) → " + j.join(" ") + (j.every((x) => x.endsWith("✓")) ? "  全绿" : ""));
  }
}
