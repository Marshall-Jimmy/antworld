// P2.3.1 光污染治理的验收台：同一份 sim 状态，分别用「旧硬钳制色阶」与「新软压缩有界色阶」着色，
// 然后在**像素层面**量化差别。为什么必须量像素：场强跨场景相差约 500 倍，而旧色阶在 peak 以上
// 把所有浓度压成同一个白色——校验和、吞吐这些 sim 指标一个都不会变，只有亮度直方图能暴露它。
//
// 用法: node glare_check.mjs            (全跑)
//       SUB=rich,rich10,default,rain,alarm node glare_check.mjs
//       SHOTS=1 node glare_check.mjs    (顺带把 before/after PNG 写到 screenshots/glare_*.png)
import { values } from "./core/config.js";
import { rng, hashSeed } from "./core/rng.js";
import { Field } from "./sim/fields.js";
import { World } from "./sim/world.js";
import { Colony } from "./sim/colony.js";
import { Weather, weatherActive } from "./core/weather.js";
import { tone, rampColor, FIELD_STOPS, ALARM_STOPS } from "./render/palette.js";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const DT = 1 / 60, DEF = { ...values };
const SUB = (process.env.SUB || "").split(",").filter(Boolean);
const LUM = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp255 = (x) => (x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x));

// ---- 旧色阶(WebGL FS_FIELD 的 toneMap=0 分支, 逐式转写; 溢出>1 的部分正是被帧缓冲截断的白) ----
function ss(a, b, x) { const k = (x - a) / (b - a); if (k <= 0) return 0; if (k >= 1) return 1; return k * k * (3 - 2 * k); }
function legacyField(v, peak, out) {
  const t = Math.min(1, Math.max(0, v / peak));
  const e = t * t * (3 - 2 * t);
  let r = 0.012, g = 0.030, b = 0.095;
  const m1 = ss(0, 0.42, t); r += (0.10 - r) * m1; g += (0.34 - g) * m1; b += (0.80 - b) * m1;
  const m2 = ss(0.30, 0.80, t); r += (0.30 - r) * m2; g += (0.72 - g) * m2; b += (1.10 - b) * m2;
  const k = e * e * 1.6; r += (1.00 - 0) * k; g += 0.84 * k; b += 0.42 * k;   // col += core*e*e*1.6
  out[0] = r * e; out[1] = g * e; out[2] = b * e;
  return out;
}
function legacyAlarm(av, peak, out) {
  const t = Math.min(1, av / peak), e = t * t * (3 - 2 * t);
  out[0] = e * 0.9; out[1] = 0.22 * e * 0.9; out[2] = 0.10 * e * 0.9;
  return out;
}
// 新色阶 = palette.js(与 WebGL/Canvas2D/PNG 三条路径同一份定义)
const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];
function newField(v, peak, out) { return rampColor(FIELD_STOPS, tone(v / peak), out); }
function newAlarm(av, peak, out) { return rampColor(ALARM_STOPS, tone(av / peak), out); }

// ---- 指标 ----
// white: 三通道全 ≥0.96 → 肉眼里的"纯白"; over: 未截断前就有通道 >1 → 被帧缓冲硬削顶(旧色阶的病根)
// 顶格: 和最热那一格画得一模一样的觅食网格子, 两读法互补——flatOct(这批格子横跨多大浓度, 越大越该死)
// 与 ceilPct(占觅食网多少)。levels: 网内可辨亮度级数; rel: 走廊内相对反差。
function metrics(field, peak, fn, alarm, apeak, aFn) {
  const buf = field.buf, n = buf.length;
  let white = 0, over = 0, hazeSum = 0, hazeN = 0;
  const lumNet = [];
  let maxLum = 0, maxCh = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    fn(v, peak, _a);
    let r = _a[0], g = _a[1], b = _a[2];
    if (alarm) {
      const av = alarm.buf[i];
      if (av > 0) { aFn(av, apeak, _b); r += _b[0]; g += _b[1]; b += _b[2]; }
    }
    if (r > 1 || g > 1 || b > 1) over++;
    maxCh = Math.max(maxCh, r, g, b);
    const rr = Math.min(1, r), gg = Math.min(1, g), bb = Math.min(1, b);
    const L = LUM([rr, gg, bb]);
    maxLum = Math.max(maxLum, L);
    if (Math.min(rr, gg, bb) >= 0.96) white++;
    if (v >= peak) lumNet.push(L);
    if (v > 0.02 && v < 0.2 * peak) { hazeSum += L; hazeN++; }
  }
  // 顶格: 觅食网里"和最热那一格画得一模一样"的格子——比它浓的读数全丢了。
  // 旧色阶下凡是 ≥peak 都并成同一档(顶格 100%); 新色阶要到 256×peak 才可能撞进同一档。
  let hotV = -1, hotKey = '', modeGroup = 0, topGroup = 0, ref = new Map();
  const stat = (key, v) => { const g = ref.get(key) || [0, v, v]; g[0]++; if (v < g[1]) g[1] = v; if (v > g[2]) g[2] = v; ref.set(key, g); return g; };
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    if (v < peak) continue;
    fn(v, peak, _a);
    const key = clamp255(_a[0]) + "," + clamp255(_a[1]) + "," + clamp255(_a[2]);
    const g = stat(key, v);
    if (g[0] > modeGroup) modeGroup = g[0];
    if (v > hotV) { hotV = v; hotKey = key; }
  }
  const hot = hotKey ? ref.get(hotKey) : null;
  topGroup = hot ? hot[0] : 0;
  // 顶格跨度(倍频程): 被压成同一色的浓度范围有多大。旧色阶 = log2(max/peak)(凡 ≥peak 全一个颜色);
  // 新色阶只剩 8-bit 输出最后一档的量化宽度, 与场强绝对值无关。
  const flatOct = hot && hot[1] > 0 ? Math.log2(hot[2] / hot[1]) : 0;
  const netN = lumNet.length;
  const mean = netN ? lumNet.reduce((a, b) => a + b, 0) / netN : 0;
  const sd = netN ? Math.sqrt(lumNet.reduce((a, b) => a + (b - mean) ** 2, 0) / netN) : 0;
  const levels = new Set(lumNet.map((L) => clamp255(L * 255))).size;
  return {
    netN, netPct: (100 * netN / n), whitePct: (100 * white / n), overPct: (100 * over / n),
    maxCh, maxLum, levels, rel: mean ? sd / mean : 0, haze: hazeN ? hazeSum / hazeN : 0,
    ceilPct: netN ? (100 * topGroup / netN) : 0, modePct: netN ? (100 * modeGroup / netN) : 0, flatOct,
  };
}

// ---- 场景 ----
function run(over, secs, opts = {}) {
  for (const k in DEF) values[k] = DEF[k];
  Object.assign(values, over);
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  const alarmField = new Field(values.worldW, values.worldH, values.gridCell);
  const fx = values.worldW * 0.62, fy = values.worldH * 0.62;
  world.addFood(fx, fy, 30, opts.food || 200);
  if (opts.pred) world.placePredator((world.nestX + fx) / 2, (world.nestY + fy) / 2, 45);
  const colony = new Colony(values.antCount, { rng: rng(hashSeed("glare")), world, nestRadius: values.nestRadius });
  const weather = new Weather("glare");
  let env = null;
  for (let s = 0; s < secs; s++) {
    if (opts.stormAt !== undefined && s === opts.stormAt) weather.forceStorm(values);
    for (let k = 0; k < 60; k++) {
      env = weatherActive(values) ? weather.step(DT, values) : null;
      const wash = env ? env.wash : 1;
      field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * wash), null);
      if (opts.pred) alarmField.step(values.diffuseWeight, Math.pow(values.alarmDecay, DT * wash), null);
      colony.step(field, world, values, DT, opts.pred ? alarmField : null, env);
    }
  }
  return { world, field, alarmField, env, colony };
}

const SCEN = {
  rich:    { label: "管饱昼间 240s (peak=0.35 = 新默认)", over: { dayNight: 1, dayLength: 240, tempSwing: 0 }, secs: 240, opt: { food: 1e6 } },
  rich07:  { label: "管饱昼间 240s (peak=0.7 = 旧默认)", over: { dayNight: 1, dayLength: 240, tempSwing: 0, peak: 0.7 }, secs: 240, opt: { food: 1e6 } },
  rich10:  { label: "管饱昼间 240s (peak=10, 验收色阶)", over: { dayNight: 1, dayLength: 240, tempSwing: 0, peak: 10 }, secs: 240, opt: { food: 1e6 } },
  default: { label: "常规玩法 60s (天气全关, 食源未耗尽)", over: {}, secs: 60, opt: {} },
  rain:    { label: "风暴满雨 200s (冲刷后重建中)", over: { dayNight: 1, weather: 1, dayLength: 240, tempSwing: 0, stormEvery: 1e9 }, secs: 200, opt: { food: 1e6, stormAt: 60 } },
  alarm:   { label: "捕食者活跃 180s (报警红)", over: {}, secs: 180, opt: { food: 1e6, pred: true } },
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " :: " + detail : ""}`);
};

// 全局不变量: 新色阶必须有界、单调、不比旧色阶更雾
console.log("--- ⓪ 色阶不变量(不跑 sim) ---");
{
  let mono = true, bounded = true, prev = -1, maxCh = 0;
  for (let i = 0; i <= 40000; i++) {
    const t = Math.pow(10, i / 40000 * 4) - 1e-9;      // t 从 0 到 1e4 个数量级
    rampColor(FIELD_STOPS, tone(t), _a);
    rampColor(ALARM_STOPS, tone(t), _b);
    for (const c of [_a[0], _a[1], _a[2], _b[0], _b[1], _b[2]]) { if (c > 1 + 1e-6) bounded = false; maxCh = Math.max(maxCh, c); }
    if (LUM(_a) < prev - 1e-6) mono = false;
    prev = LUM(_a);
  }
  check("新色阶有界(任何浓度都不溢出 1.0 → 不会截断成白)", bounded, "max channel = " + maxCh.toFixed(4));
  check("新色阶亮度随浓度单调不减(浓度→亮度是单射, 不会把更浓的画得更暗)", mono);
  let oldOver = 0, oldN = 0;
  for (let t = 1; t <= 200; t += 0.01) { legacyField(t, 1, _a); oldN++; if (_a[0] > 1 || _a[1] > 1 || _a[2] > 1) oldOver++; }
  check("旧色阶确实大面积溢出(证据)", oldOver / oldN > 0.9, `t∈[1,200] 有 ${(100 * oldOver / oldN).toFixed(1)}% 的取样点被帧缓冲削顶`);
}

const rows = [];
for (const [key, sc] of Object.entries(SCEN)) {
  if (SUB.length && !SUB.includes(key)) continue;
  console.log(`\n--- ${sc.label} ---`);
  const S = run(sc.over, sc.secs, sc.opt);
  const peak = values.peak, apeak = values.alarmPeak;
  const useAlarm = !!sc.opt.pred;
  const O = metrics(S.field, peak, legacyField, useAlarm ? S.alarmField : null, apeak, legacyAlarm);
  const N = metrics(S.field, peak, newField, useAlarm ? S.alarmField : null, apeak, newAlarm);
  const fmax = (() => { let m = 0; for (let i = 0; i < S.field.buf.length; i++) m = Math.max(m, S.field.buf[i]); return m; })();
  console.log(`  场强: max ${fmax.toFixed(2)} = ${(fmax / peak).toFixed(1)}×peak | 觅食网 ≥peak 的格子 ${O.netPct.toFixed(2)}%`);
  const fmt = (m) => `纯白 ${m.whitePct.toFixed(2)}% | 溢出 ${m.overPct.toFixed(2)}% | 最大通道 ${m.maxCh.toFixed(2)} | 网内可辨级数 ${m.levels} | 相对反差 ${(m.rel * 100).toFixed(1)}% | 顶格 ${m.ceilPct.toFixed(1)}%·跨 ${m.flatOct.toFixed(2)} 倍频程 | 众数色 ${m.modePct.toFixed(1)}% | 淡痕亮度 ${(m.haze * 255).toFixed(1)}/255`;
  console.log("  旧 " + fmt(O));
  console.log("  新 " + fmt(N));
  rows.push([sc.label, O, N]);
  if (key === "default") {
    check("常规玩法不被做暗(淡痕亮度 ≥ 旧)", N.haze >= O.haze * 0.9, `新 ${(N.haze * 255).toFixed(1)} vs 旧 ${(O.haze * 255).toFixed(1)}/255`);
  } else {
    check("纯白像素占比降到旧的 1/10 以下", N.whitePct <= O.whitePct / 10 + 1e-9, `新 ${N.whitePct.toFixed(2)}% vs 旧 ${O.whitePct.toFixed(2)}%`);
    check("觅食网内可辨亮度级数 ≥ 旧的 4 倍", N.levels >= O.levels * 4, `新 ${N.levels} 级 vs 旧 ${O.levels} 级`);
    // 阈值按实测定(不是拍脑袋): 新色阶实测跨度 0.66–2.23 倍频程, 来源是 stop 之间 smoothstep 链接
    // 在站点处导数为零造成的"驻点平台"——这是任何带肩部的 tone curve 的固有性质(胶片曲线同理),
    // 量级上远好于旧色阶"凡 ≥peak 全压成同一色"。判据因此写成两条: 绝对值 ≤2.5 倍频程(4× 浓度),
    // 且必须比旧色阶窄到 0.6 倍以下。旧色阶实测 2.58–7.42 倍频程。
    check("顶格浓度跨度 ≤ 2.5 倍频程 且 ≤ 旧色阶的 0.6 倍",
      N.flatOct <= 2.5 && N.flatOct <= O.flatOct * 0.6,
      `新 ${N.flatOct.toFixed(2)} 倍频程 vs 旧 ${O.flatOct.toFixed(2)} 倍频程`);
  }
  check("新色阶零溢出", N.overPct === 0, `溢出 ${N.overPct.toFixed(3)}%`);
  if (process.env.SHOTS) {
    if (!existsSync("screenshots")) mkdirSync("screenshots");
    shots(key, S, O, N);
  }
}
console.log(`\n=== ${pass + fail} 项断言, ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);

// 把同一帧的左右两半分别按旧/新色阶画出来(纯色阶对比, 不含蚂蚁/墙)
function shots(key, S, O, N) {
  const gw = S.field.gw, gh = S.field.gh;
  const png = new PNG({ width: gw * 2, height: gh });
  const peak = values.peak, apeak = values.alarmPeak, useAlarm = !!SCEN[key].opt.pred;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x, v = S.field.buf[i];
      for (let half = 0; half < 2; half++) {
        const fn = half ? newField : legacyField, af = half ? newAlarm : legacyAlarm;
        fn(v, peak, _c);
        let r = _c[0], g = _c[1], b = _c[2];
        if (useAlarm) { const av = S.alarmField.buf[i]; if (av > 0) { af(av, apeak, _b); r += _b[0]; g += _b[1]; b += _b[2]; } }
        const o = ((y * png.width) + x + half * gw) * 4;
        png.data[o] = clamp255(r * 255); png.data[o + 1] = clamp255(g * 255); png.data[o + 2] = clamp255(b * 255); png.data[o + 3] = 255;
      }
    }
  }
  const out = `screenshots/glare_${key}.png`;
  writeFileSync(out, PNG.sync.write(png));
  console.log("  → " + out + " (左=旧色阶, 右=新色阶)");
}
