// P2.3 诊断台(MODE=dwell|wave|phantom)：把"先复现后修"的三张证据固化成可重跑工具。
//   phantom  教训11: 航位推算参考点外漂("假家")普查——|h| 与真实巢距背离多少、多少蚁在野外领"巢内滞留"
//   dwell    教训11/12: 逐秒打印 钟/走表速率/滞留/巢内外构成, 看内源钟加压后群体到底停不停
//   wave     教训13: 昼行 vs 夜行的逐秒波形、占空比与 Pearson(占空比偏离 50% 会自己杀死反相相关)
// 用法: MODE=wave node weather_diag.mjs   (环境变量 T=<秒> 改长度; 全程零写入, 除 wave 缓存 logs/wave.json)
import { values } from "./core/config.js";
import { rng, hashSeed } from "./core/rng.js";
import { Field } from "./sim/fields.js";
import { World } from "./sim/world.js";
import { Colony } from "./sim/colony.js";
import { Weather, weatherActive } from "./core/weather.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const DT = 1 / 60, DEF = { ...values };
const T = Number(process.env.T || 300);
const MODE = process.env.MODE || "dwell";
function useParams(over) { for (const k in DEF) values[k] = DEF[k]; for (const k in over) values[k] = over[k]; }
function makeSim(over, bare) {
  useParams(over);
  // bare=true 复刻 perf_check/恒等回归的布局(World 不带墙格), phantom 的读数才能直接对 §6 基线
  const world = bare ? new World(values.worldW, values.worldH) : new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 1e9);   // 管饱斜向食源(与 weather_check 同布局)
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(bare ? "perfseed" : "wxcheck")), world, nestRadius: values.nestRadius });
  const weather = new Weather("wxcheck");
  let env = null;
  const step = () => {
    env = weatherActive(values) ? weather.step(DT, values) : null;
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * (env ? env.wash : 1)), null);
    colony.step(field, world, values, DT, null, env);
  };
  const R = values.nestRadius, hw = world.w / 2, hh = world.h / 2;
  const geo = (i) => {
    let dx = colony.px[i] - world.nestX, dy = colony.py[i] - world.nestY;
    if (dx > hw) dx -= world.w; else if (dx < -hw) dx += world.w;
    if (dy > hh) dy -= world.h; else if (dy < -hh) dy += world.h;
    return { d: Math.hypot(dx, dy), h: Math.hypot(colony.hx[i], colony.hy[i]), ins: dx * dx + dy * dy <= R * R };
  };
  return { world, field, colony, step, geo, envOf: () => env };
}
const avg = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
const pearson = (x, y) => {
  const n = Math.min(x.length, y.length), mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n, my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy || 1);
};

if (MODE === "phantom") {
  // 天气全关 = 现行 perf_check 基线布局: 只查"到家判定"到底把多少蚁的家搬出了巢盘
  const S = makeSim({ dayNight: 0, weather: 0 }, true);
  S.world.foodPatches.length = 0;
  S.world.addFood(values.worldW / 2 + 80, values.worldH / 2 + 30, 30, 400);   // 与 perf_check 同一块食物
  for (let s = 0; s < 3700; s++) S.step();
  // 直接查 h 的**参考点**: h = 参考点 − 当前位置 ⇒ 参考点 = 位置 + h。
  // 不变量 = 参考点恒在巢盘内(只有物理到家才允许清零 h)。这比"|h| 与巢距之差"干净:
  // 后者把环面记账(h 在展开坐标, 巢距是环面距离)也算成背离, 会虚报。
  const R = values.nestRadius, c = S.colony, hw = S.world.w / 2, hh = S.world.h / 2;
  let bad = 0, over2 = 0, parked = 0, outside = 0, sum = 0, mx = 0;
  for (let i = 0; i < c.count; i++) {
    const g = S.geo(i);
    let rx = S.world.nestX - (S.colony.px[i] + S.colony.hx[i]), ry = S.world.nestY - (S.colony.py[i] + S.colony.hy[i]);
    if (rx > hw) rx -= S.world.w; else if (rx < -hw) rx += S.world.w;
    if (ry > hh) ry -= S.world.h; else if (ry < -hh) ry += S.world.h;
    const off = Math.hypot(rx, ry);
    if (!g.ins) { outside++; if (c.pauseT[i] > 1) parked++; }
    if (off > R) { bad++; sum += off; if (off > mx) mx = off; }
    if (off > 2 * R) over2++;
  }
  console.log("假家普查(天气全关, 3700 步): 参考点外漂 > 巢半径(" + R + ") 的蚁 = " + bad + "/" + c.count +
    ", 最大外漂 " + mx.toFixed(0) + " —— 上界恰为一个巢半径且**不累积**(结算只在物理进盘时清零)");
  console.log("外漂 > 2×巢半径(=旧写法那种会自我放大、把家一步步搬进野外的) = " + over2 + "/" + c.count);
  console.log("巢外 " + outside + " 只中挂着 >1s 巢内滞留计的(=站在野外蛰巢) = " + parked);
  console.log("deliveries=" + c.deliveries + " timeouts=" + c.timeouts + " aborts=" + c.aborts);
  console.log(over2 === 0 && parked === 0 ? "→ 不变量成立: 参考点被巢盘钉住, 野外零假滞留。修前同一把尺子 21.0% / 最大外漂 114 / 野外假滞留 15" : "→ 存在假家: 见 METRICS 教训11");
} else if (MODE === "dwell") {
  const phase = Number(process.env.PHASE || 0);
  const S = makeSim({ dayNight: 1, weather: 0, tempSwing: 0, dayLength: 120, dayPhase: phase });
  const c = S.colony, R = values.nestRadius;
  console.log("t light clock drive rate dwellMul urge | outside inside dwellIn dwellOut | loaded ret wander | 滞留均值");
  for (let s = 1; s <= T; s++) {
    for (let k = 0; k < 60; k++) S.step();
    let outside = 0, inside = 0, din = 0, dout = 0, loaded = 0, ret = 0, wander = 0, sum = 0;
    for (let i = 0; i < c.count; i++) {
      const g = S.geo(i);
      if (g.ins) { inside++; if (c.pauseT[i] > 0) { din++; sum += c.pauseT[i]; } }
      else { outside++; if (c.pauseT[i] > 0) dout++; else if (c.load[i] > 0) loaded++; else if (c.forageT[i] > values.forageTimeout) ret++; else wander++; }
    }
    const e = S.envOf();
    console.log([String(s).padStart(3), e.light.toFixed(2), e.clock.toFixed(2), e.drive.toFixed(2),
      e.pauseRate.toFixed(3), e.dwellMul.toFixed(1), e.urge.toFixed(2), outside, inside, din, dout,
      loaded, ret, wander, (din ? sum / din : 0).toFixed(1) + "s"].join(" "));
  }
} else if (MODE === "wave") {
  let A, B;
  const cache = "logs/wave.json";
  if (existsSync(cache)) { const j = JSON.parse(readFileSync(cache, "utf8")); A = j.A; B = j.B; console.log("(载入缓存 " + cache + ")"); }
  else {
    const run = (phase) => {
      const S = makeSim({ dayNight: 1, weather: 0, tempSwing: 0, dayLength: 120, dayPhase: phase }), c = S.colony;
      const rows = [];
      for (let s = 1; s <= T; s++) {
        for (let k = 0; k < 60; k++) S.step();
        let outside = 0, loaded = 0, ret = 0, wander = 0, pout = 0, inside = 0, pin = 0;
        for (let i = 0; i < c.count; i++) {
          const g = S.geo(i);
          if (g.ins) { inside++; if (c.pauseT[i] > 0) pin++; }
          else { outside++; if (c.pauseT[i] > 0) pout++; else if (c.load[i] > 0) loaded++; else if (c.forageT[i] > values.forageTimeout) ret++; else wander++; }
        }
        const e = S.envOf();
        rows.push({ t: s, light: +e.light.toFixed(3), rate: +e.pauseRate.toFixed(4), outside, inside, loaded, ret, wander, pout, pin });
      }
      return rows;
    };
    A = run(0); B = run(0.5);
    mkdirSync("logs", { recursive: true }); writeFileSync(cache, JSON.stringify({ A, B }));
  }
  const ma = A.filter(r => r.t >= 130), mb = B.filter(r => r.t >= 130);
  const noon = (rs) => rs.filter(r => r.light > 0.95), night = (rs) => rs.filter(r => r.light < 0.05);
  console.log("rho(成熟段 t>=130) = " + pearson(ma.map(r => r.outside), mb.map(r => r.outside)).toFixed(4));
  console.log("正午 昼行 " + avg(noon(ma), "outside").toFixed(0) + " vs 夜行 " + avg(noon(mb), "outside").toFixed(0) +
    " = " + (avg(noon(ma), "outside") / avg(noon(mb), "outside")).toFixed(2) + "×   |   深夜 夜行 " +
    avg(night(mb), "outside").toFixed(0) + " vs 昼行 " + avg(night(ma), "outside").toFixed(0) + " = " +
    (avg(night(mb), "outside") / avg(night(ma), "outside")).toFixed(2) + "×");
  const cyc = ma.slice(50, 170);
  console.log("一个成熟周期(每 2s 一格, 数字=500 只/格):");
  console.log("  昼行 " + cyc.filter((r, i) => i % 2 === 0).map(r => "0123456789"[Math.min(9, Math.round(r.outside / 500))]).join(""));
  console.log("  夜行 " + mb.slice(50, 170).filter((r, i) => i % 2 === 0).map(r => "0123456789"[Math.min(9, Math.round(r.outside / 500))]).join(""));
  console.log("  光照 " + cyc.filter((r, i) => i % 2 === 0).map(r => "0123456789"[Math.round(r.light * 9)]).join(""));
  const mx = Math.max(...cyc.map(r => r.outside)), mn = Math.min(...cyc.map(r => r.outside));
  const d = cyc.filter(r => r.outside > (mx + mn) / 2).length / cyc.length;
  console.log("  峰 " + mx + " 谷 " + mn + " 活动占空比 " + d.toFixed(2) + " → 该占空下方波位移半周期的相关上限 " +
    (-Math.min(d, 1 - d) / Math.max(d, 1 - d)).toFixed(2) + " (判据 −0.85 需要占空比≈0.46..0.54)");
  const comp = (rs, l) => console.log(l + ": 巢外 " + avg(rs, "outside").toFixed(0) + " = 负重 " + avg(rs, "loaded").toFixed(0) +
    " + 返巢 " + avg(rs, "ret").toFixed(0) + " + 空手游走 " + avg(rs, "wander").toFixed(0) + " + 巢外停顿 " + avg(rs, "pout").toFixed(0) +
    " | 巢内 " + avg(rs, "inside").toFixed(0) + "(滞留 " + avg(rs, "pin").toFixed(0) + ")");
  comp(night(ma), "深夜 昼行(蛰伏)"); comp(noon(ma), "正午 昼行(全速)");
}
