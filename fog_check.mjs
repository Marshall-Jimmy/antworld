// fog_check.mjs — P2.3.2 光污染治理 II 的验收台：把画面里的"光"按离蚁路的距离拆开。
//
// 为什么要新量具：P2.3.1 只治了色阶(亮度→颜色的映射)，而光的来源没动。实测三种子
// 61~75% 的光来自"最近 40s 没有任何蚂蚁踏过"的格子——那是横向扩散糊出来的雾。真实蚁的
// 轨迹信息素是留在基质上的**接触性痕迹**，其可及范围由触角长度决定；云比鼻子大，多出来的
// 那部分就是"没有接收者的光"：蚂蚁读不到，只有玩家看得到。这就是残留的光污染。
//
// 预登记判据(在看新指标之前写死，全部相对基线 dw=0.06 的三种子均值)：
//   F1 死光占比(离最近蚁路 > sensorDist 的格子发出的光) ≤ 0.5×基线      ← 主判据
//   F2 云的衰减长度 ℓ=sqrt(D/λ) ≤ sensorDist                            ← 物理判据(不跑 sim)
//   F3 吞吐 del ≥ 0.9×基线(护栏；若上升如实报告，不许藏)                 ← 不伤害
//   F4 失败数 to+ab ≤ 1.10×基线                                          ← 不伤害
//   F5 路光占比(蚂蚁真正踩着的格子的光) ≥ 基线                            ← 画面不能靠"整体变暗"过关
//   F6 网内可辨亮度级数 ≥ 基线                                            ← 结构可读性不能退
// 任一 FAIL 就不改默认值，如实入库。
import { values } from "./core/config.js";
import { rng, hashSeed } from "./core/rng.js";
import { Field } from "./sim/fields.js";
import { World } from "./sim/world.js";
import { Colony } from "./sim/colony.js";
import { Weather, weatherActive } from "./core/weather.js";
import { tone, rampColor, FIELD_STOPS } from "./render/palette.js";

const DT = 1 / 60, DEF = { ...values };
const LUM = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const _a = [0, 0, 0];
const SECS = +(process.env.SECS || 240);
const TRAIL = +(process.env.TRAIL || 40);          // 足迹窗口(秒)：近期有蚁踏过 = 路
const SUB = (process.env.SUB || "").split(",").filter(Boolean);

function runSim(dw, seed) {
  for (const k in DEF) values[k] = DEF[k];
  values.dayNight = 1; values.dayLength = 240; values.tempSwing = 0; values.diffuseWeight = dw;
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  const fx = values.worldW * 0.62, fy = values.worldH * 0.62;
  world.addFood(fx, fy, 30, 1e6);
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(seed)), world, nestRadius: values.nestRadius });
  const weather = new Weather(seed);
  const cs = field.cellSize, gw = field.gw, gh = field.gh;
  const road = new Uint8Array(field.len);          // 最近 TRAIL 秒内有负重蚁踏过 = 路
  for (let s = 0; s < SECS; s++) {
    for (let k = 0; k < 60; k++) {
      const env = weatherActive(values) ? weather.step(DT, values) : null;
      field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * (env ? env.wash : 1)), null);
      colony.step(field, world, values, DT, null, env);
      if (s >= SECS - TRAIL) {                        // 窗口长度恰为 TRAIL 秒，直接累积即可
        for (let i = 0; i < colony.count; i++) {
          if (colony.load[i] > 0) {
            const gx = Math.round(colony.px[i] / cs), gy = Math.round(colony.py[i] / cs);
            road[(((gy % gh) + gh) % gh) * gw + (((gx % gw) + gw) % gw)] = 1;
          }
        }
      }
    }
  }
  return { field, colony, road, world };
}

// 4 邻域 BFS 距离场(格)：每格到最近"路格"的距离。未触及的路格外一律 -1(不可达不存在)。
function distField(field, road) {
  const gw = field.gw, gh = field.gh, n = field.len;
  const d = new Int32Array(n).fill(-1);
  let q = new Int32Array(n), qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (road[i]) { d[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const c = q[qh++], x = c % gw, y = (c / gw) | 0;
    const nd = d[c] + 1;
    if (x > 0 && d[c - 1] < 0) { d[c - 1] = nd; q[qt++] = c - 1; }
    if (x < gw - 1 && d[c + 1] < 0) { d[c + 1] = nd; q[qt++] = c + 1; }
    if (y > 0 && d[c - gw] < 0) { d[c - gw] = nd; q[qt++] = c - gw; }
    if (y < gh - 1 && d[c + gw] < 0) { d[c + gw] = nd; q[qt++] = c + gw; }
  }
  return d;
}

function measure(dw, seed) {
  const { field, colony, road } = runSim(dw, seed);
  const peak = values.peak, buf = field.buf, n = buf.length, cs = field.cellSize;
  const d = distField(field, road);
  const reach = values.sensorDist / cs;              // 触角可及范围(格)
  let sumL = 0, deadL = 0, roadL = 0, lit = 0, netN = 0, maxV = 0, roadN = 0, wsum = 0;
  const roadDose = [], lumNet = [];
  for (let i = 0; i < n; i++) {
    const v = buf[i]; if (v > maxV) maxV = v;
    if (v <= 0) continue;
    rampColor(FIELD_STOPS, tone(v / peak), _a);
    const L = LUM(_a); if (L <= 0) continue;
    sumL += L; wsum += L * d[i];
    if (L > 0.004) lit++;
    if (d[i] > reach) deadL += L;
    if (road[i]) { roadL += L; roadN++; roadDose.push(v); }
    if (v >= peak) { netN++; lumNet.push(L); }
  }
  roadDose.sort((a2, b) => a2 - b);
  const med = roadDose.length ? roadDose[roadDose.length >> 1] : 0;
  const p95 = roadDose.length ? roadDose[(roadDose.length * 0.95) | 0] : 0;
  const mean = lumNet.reduce((a2, b) => a2 + b, 0) / (lumNet.length || 1);
  const sd = Math.sqrt(lumNet.reduce((a2, b) => a2 + (b - mean) ** 2, 0) / (lumNet.length || 1));
  const D = 15 * dw;                                  // 每轴扩散率(格^2/秒): 每步方差 0.5*dw, 60 步/秒
  const lambda = -Math.log(values.decayRate);         // 每秒衰减率
  const ell = Math.sqrt(D / lambda) * cs;             // 云的衰减长度(世界单位)
  return { dw, seed, dead: 100 * deadL / sumL, roadShare: 100 * roadL / sumL, litPct: 100 * lit / n,
    netPct: 100 * netN / n, maxOverPeak: maxV / peak, meanDistCells: wsum / sumL, ell,
    levels: new Set(lumNet.map((L) => Math.round(L * 255))).size, rel: 100 * sd / mean,
    roadMed: med, roadP95: p95, roadN, reach,
    del: colony.deliveries, to: colony.timeouts, ab: colony.aborts };
}

const SEEDS = ["glare", "wxcheck", "predcheck"];
const DWS = (process.env.DWS || "0.06,0.02").split(",").map(Number).filter((x) => !SUB.length || true);
const rows = [];
for (const dw of DWS) for (const sd of SEEDS) {
  const r = measure(dw, sd); rows.push(r);
  console.log(`dw=${dw} ${sd.padEnd(9)} 死光 ${r.dead.toFixed(1).padStart(5)}% | 路光 ${r.roadShare.toFixed(1).padStart(4)}% | 加权离路距离 ${r.meanDistCells.toFixed(2)}格(触角 ${r.reach.toFixed(2)}格) | 云衰减长 ${r.ell.toFixed(1)}u | 亮格 ${r.litPct.toFixed(2)}% 网 ${r.netPct.toFixed(2)}% | max ${r.maxOverPeak.toFixed(0)}xpeak | 级数 ${r.levels} 反差 ${r.rel.toFixed(1)}% | 路上剂量 中位 ${r.roadMed.toFixed(2)}/p95 ${r.roadP95.toFixed(2)} (${(r.roadMed / values.peak).toFixed(1)}xpeak) | del ${r.del} to ${r.to} ab ${r.ab}`);
}
const avg = (dw, key) => { const g = rows.filter((r) => r.dw === dw); return g.reduce((a2, b) => a2 + b[key], 0) / g.length; };
console.log("\n=== 三种子均值 ===");
const B = DWS[0];
const base = { dead: avg(B, "dead"), del: avg(B, "del"), bad: avg(B, "to") + avg(B, "ab"), road: avg(B, "roadShare"), levels: avg(B, "levels"), lit: avg(B, "litPct") };
for (const dw of DWS) {
  const dead = avg(dw, "dead"), del = avg(dw, "del"), bad = avg(dw, "to") + avg(dw, "ab");
  const road = avg(dw, "roadShare"), levels = avg(dw, "levels");
  const tag = dw === B ? "基线"
    : [dead <= base.dead * 0.5 ? "F1死光✓" : "F1死光✗", del >= 0.9 * base.del ? "F3吞吐✓" : "F3吞吐✗",
       bad <= 1.1 * base.bad ? "F4失败✓" : "F4失败✗", road >= base.road ? "F5路光✓" : "F5路光✗",
       levels >= base.levels ? "F6级数✓" : "F6级数✗"].join(" ");
  console.log(`dw=${dw}: 死光 ${dead.toFixed(1)}% (${(dead / base.dead).toFixed(2)}x) | 路光 ${road.toFixed(1)}% (${(road / base.road).toFixed(2)}x) | 级数 ${levels.toFixed(0)} | del ${del.toFixed(0)} (${(del / base.del).toFixed(3)}x) | to+ab ${bad.toFixed(0)} (${(bad / base.bad).toFixed(3)}x) | 云衰减长 ${avg(dw, "ell").toFixed(1)}u ≤ ${values.sensorDist}u ? ${avg(dw, "ell") <= values.sensorDist ? "F2✓" : "F2✗"} → ${tag}`);
}
