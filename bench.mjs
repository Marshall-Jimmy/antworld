// P1.6 常驻断口基准 + 参数扫描 (headless, sim 层, 可 node 直接跑)
//
// 指标: stigmergyIndex = 1 − throughput_gap / throughput_control
//   · 永远 paired: 同一 seed/配置 对照与擦除各跑一次, 用 ratio 不用绝对值
//   · 断口宽度以"身位"为单位: 1 身位 = speed*dt
//
// 用法:
//   node bench.mjs time                          # 计时探针
//   node bench.mjs grid                          # 参数网格扫描(写 bench-out/grid.csv)
//   node bench.mjs dose "<cfg串>"                 # 剂量响应曲线 width 0.5..20
//   node bench.mjs robust "<cfg串>"              # 鲁棒性(斜向/远距/两food/K_sat±50%)
//   node bench.mjs plateau "<cfg串>"             # 走廊中心线剖面(验证 sensorDist 假设+高原)
// 环境: ANTS(默认2500) WARM(默认45s) WINDOW(默认25s) SEEDS(默认3)
// 场景(巢在中心):
//   right: [[0.72,h/2]]  ideal水平走廊   diag: [[0.72,0.28h]]   far: [[0.85,h/2]]
//   two:   [[0.72,0.46h],[0.72,0.54h]] 两食物源

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { SCHEMA, values, set } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { sense, confOf, sensorPoints } from './sim/ant.js';

const DEFAULTS = {};
for (const s of SCHEMA) DEFAULTS[s.key] = s.default;

const DT = 1 / 60;
const BODY = DEFAULTS.speed * DT;
const OUT = 'bench-out';
const SEEDS = Number(process.env.SEEDS || 3);
const ANTS = Number(process.env.ANTS || 5000);
const GRIDCELL = Number(process.env.GRIDCELL || DEFAULTS.gridCell);
const WARM = Number(process.env.WARM || 40);
const WINDOW = Number(process.env.WINDOW || 20);
const SEEDBASE = 'p16';

// 基准基底: 世界尺寸保持场景默认, 蚂蚁数/网格分辨率可抽稀以加快粗扫
function base() { return { ...DEFAULTS, antCount: ANTS, gridCell: GRIDCELL }; }
function apply(cfg) { for (const k in cfg) set(k, cfg[k]); }
function parseCfg(str) {
  const o = {};
  for (const pair of str.split(',')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    const s = SCHEMA.find(x => x.key === k);
    if (s && s.options && typeof s.options[0] === 'boolean') o[k] = v === 'true';
    else o[k] = (s && s.options) ? v : Number(v);
  }
  return { ...base(), ...o };
}

const FOODS = {
  right: [[0.72, 0.5]],
  diag:  [[0.72, 0.28]],
  far:   [[0.85, 0.5]],
  two:   [[0.72, 0.46], [0.72, 0.54]],
};

function makeGeometry(scenario, w, h) {
  const pairs = FOODS[scenario];
  const nestX = w / 2, nestY = h / 2;
  const foods = pairs.map(([fx, fy]) => ({ x: fx * w, y: fy * h, radius: 30, amount: 1e6 }));
  const f = foods[0];
  let ax = f.x - nestX, ay = f.y - nestY;
  const al = Math.hypot(ax, ay); ax /= al; ay /= al;
  const nx = -ay, ny = ax;
  return { nestX, nestY, foods, ax, ay, nx, ny, Mx: (nestX + f.x) / 2, My: (nestY + f.y) / 2 };
}

function build(seed, scenario, ww, wh) {
  const r = rng(hashSeed(seed));
  const world = new World(ww, wh);
  const field = new Field(ww, wh, values.gridCell);
  const geo = makeGeometry(scenario, ww, wh);
  for (const f of geo.foods) world.addFood(f.x, f.y, f.radius, f.amount);
  const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });
  return { world, field, colony, geo };
}

function clearGap(field, geo, widthBodies, roadLen) {
  const cell = field.cellSize, gw = field.gw, gh = field.gh;
  const half = widthBodies * BODY / 2;
  // 只需扫描断口包围盒内格子, 不必全网格遍历
  const R = half + roadLen;
  const ix0 = Math.max(0, Math.floor((geo.Mx - R) / cell));
  const ix1 = Math.min(gw - 1, Math.floor((geo.Mx + R) / cell));
  const iy0 = Math.max(0, Math.floor((geo.My - R) / cell));
  const iy1 = Math.min(gh - 1, Math.floor((geo.My + R) / cell));
  for (let iy = iy0; iy <= iy1; iy++) {
    const cy = iy * cell + cell / 2;
    const dy0 = cy - geo.My;
    for (let ix = ix0; ix <= ix1; ix++) {
      const cx = ix * cell + cell / 2;
      const dx = cx - geo.Mx;
      const along = dx * geo.ax + dy0 * geo.ay;
      const cross = dx * geo.nx + dy0 * geo.ny;
      if (Math.abs(along) < half && Math.abs(cross) < roadLen) field.buf[iy * gw + ix] = 0;
    }
  }
}

function countCrossing(colony, geo, band, prevA) {
  let through = 0;
  for (let i = 0; i < colony.count; i++) {
    const dx = colony.px[i] - geo.Mx, dy = colony.py[i] - geo.My;
    const a = dx * geo.ax + dy * geo.ay;
    const n = dx * geo.nx + dy * geo.ny;
    if (Math.abs(n) > band) { prevA[i] = a; continue; }
    const p = prevA[i];
    if ((p < 0 && a >= 0) || (p >= 0 && a < 0)) through++;
    prevA[i] = a;
  }
  return through;
}

function runOnce(seed, cfg, scenario, ww, wh, erase, widthBodies) {
  apply(cfg);
  const { world, field, colony, geo } = build(seed, scenario, ww, wh);
  const nW = Math.round(WARM / DT);
  for (let t = 0; t < nW; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  }
  const band = 50, roadLen = 90;
  const prevA = new Float32Array(colony.count);
  for (let i = 0; i < colony.count; i++) {
    prevA[i] = (colony.px[i] - geo.Mx) * geo.ax + (colony.py[i] - geo.My) * geo.ay;
  }
  const nW2 = Math.round(WINDOW / DT);
  let through = 0;
  for (let t = 0; t < nW2; t++) {
    if (erase) clearGap(field, geo, widthBodies, roadLen);
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
    through += countCrossing(colony, geo, band, prevA);
  }
  return { through, deliveries: colony.deliveries };
}

function benchPoint(seed, cfg, scenario, ww, wh, widthBodies) {
  const ctl = runOnce(seed, cfg, scenario, ww, wh, false, widthBodies);
  const gap = runOnce(seed, cfg, scenario, ww, wh, true, widthBodies);
  const index = 1 - gap.through / Math.max(1e-6, ctl.through);
  return { index, ctl, gap };
}
function seedOf(name) { return `${SEEDBASE}-${name}`; }

export function timing() {
  const t0 = process.hrtime.bigint();
  const cfg = base();
  const r1 = benchPoint(seedOf('t0'), cfg, 'right', DEFAULTS.worldW, DEFAULTS.worldH, 5);
  const r2 = benchPoint(seedOf('t1'), cfg, 'right', DEFAULTS.worldW, DEFAULTS.worldH, 5);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`ANTS=${ANTS} WARM=${WARM}s WINDOW=${WINDOW}s  4 sims = ${ms.toFixed(0)}ms  ≈${(ms / 4).toFixed(0)}ms/sim`);
  console.log(`sample index@w5: ${r1.index.toFixed(3)}, ${r2.index.toFixed(3)}`);
  console.log(`  ctl.through=${r1.ctl.through} gap.through=${r1.gap.through} del(${r1.ctl.deliveries}/${r1.gap.deliveries})`);
}

export function grid() {
  const modes = ['off', 'log', 'mm'];
  const Ksats = [0.02, 0.05, 0.1];
  const dists = [10, 26, 45];
  const angles = [0.5, 0.79, 1.2];
  const rows = [];
  for (const mode of modes) {
    const ks = mode === 'off' ? [0.05] : Ksats; // off 时 K_sat 无意义
    for (const Ksat of ks) {
      for (const dist of dists) {
        for (const angle of angles) {
          const cfg = { ...base(), saturationMode: mode, K_sat: Ksat, sensorDist: dist, sensorAngle: angle };
          const idx = [], ddel = [];
          for (let s = 0; s < SEEDS; s++) {
            const r = benchPoint(seedOf('g' + s), cfg, 'right', DEFAULTS.worldW, DEFAULTS.worldH, 5);
            idx.push(r.index); ddel.push(r.gap.deliveries);
            rows.push({ mode, Ksat, dist, angle, seed: s, index: +r.index.toFixed(4), del: r.gap.deliveries });
          }
          const mi = idx.reduce((a, b) => a + b, 0) / idx.length;
          const md = ddel.reduce((a, b) => a + b, 0) / ddel.length;
          console.log(`${mode.padEnd(3)} K=${String(Ksat).padEnd(4)} d=${String(dist).padEnd(3)} ∠=${String(angle).padEnd(4)}  index=${mi.toFixed(3)}  del=${md.toFixed(0)}  [${idx.map(x => x.toFixed(2)).join(',')}]`);
        }
      }
    }
  }
  const head = 'mode,K_sat,sensorDist,sensorAngle,seed,index,del';
  writeFileSync(`${OUT}/grid.csv`, head + '\n' + rows.map(r => `${r.mode},${r.Ksat},${r.dist},${r.angle},${r.seed},${r.index},${r.del}`).join('\n'));
  console.log('wrote', OUT + '/grid.csv', rows.length, 'rows');
}

export function dose(cfgStr) {
  const cfg = parseCfg(cfgStr);
  // 断口宽度默认 0.5..20 身位; 可用 DOSEW=24,48,96 覆盖(宽断口真实剂量响应)。
  // 注意: worldW=2000/gridCell=8 时走廊中点恰好落在格心上, ≤20.8 身位(=16u)的断口
  // 擦的都是同一根 8u 列 → 剂量曲线在此区间必然恒平(几何简并, 见 METRICS P1.8)。
  const widths = process.env.DOSEW
    ? process.env.DOSEW.split(',').map(Number)
    : [0.5, 1, 2, 3, 5, 8, 12, 16, 20];
  const rows = [];
  const line = [];
  const scenario = process.env.SCEN || 'right'; // far 场景格心偏移 2u, w=5 时擦不到任何格子, 需换宽度重测
  for (const w of widths) {
    const idx = [];
    for (let s = 0; s < SEEDS; s++) {
      const r = benchPoint(seedOf('d' + s), cfg, scenario, DEFAULTS.worldW, DEFAULTS.worldH, w);
      idx.push(r.index);
      rows.push({ w, s, index: +r.index.toFixed(4), del: r.gap.deliveries });
    }
    const m = idx.reduce((a, b) => a + b, 0) / idx.length;
    line.push(m);
    console.log(`width=${String(w).padStart(2)}  index=${m.toFixed(3)}  [${idx.map(x => x.toFixed(2)).join(',')}]`);
  }
  writeFileSync(`${OUT}/dose.csv`, 'width_bodies,seed,index,del\n' + rows.map(r => `${r.w},${r.s},${r.index},${r.del}`).join('\n'));
  console.log('dose curve:', line.map(x => x.toFixed(2)).join(' '), ' → peak', Math.max(...line).toFixed(3), 'at w', widths[line.indexOf(Math.max(...line))]);
}

export function robust(cfgStr) {
  const cfg = parseCfg(cfgStr);
  for (const { name, scenario } of [
    { name: 'diag(斜向)', scenario: 'diag' },
    { name: 'far(更远)', scenario: 'far' },
    { name: 'two(两food)', scenario: 'two' },
  ]) {
    const idx = [], ddel = [];
    for (let s = 0; s < SEEDS; s++) {
      const r = benchPoint(seedOf('r' + s), cfg, scenario, DEFAULTS.worldW, DEFAULTS.worldH, 5);
      idx.push(r.index); ddel.push(r.gap.deliveries);
    }
    const mi = idx.reduce((a, b) => a + b, 0) / idx.length;
    const md = ddel.reduce((a, b) => a + b, 0) / ddel.length;
    console.log(`${name.padEnd(12)} index@w5=${mi.toFixed(3)}  del=${md.toFixed(0)}  [${idx.map(x => x.toFixed(2)).join(',')}]`);
  }
  for (const f of [0.5, 1.0, 1.5]) {
    const c = { ...cfg, K_sat: +(cfg.K_sat * f).toFixed(4) };
    const idx = [], ddel = [];
    for (let s = 0; s < SEEDS; s++) {
      const r = benchPoint(seedOf('rk' + s), c, 'right', DEFAULTS.worldW, DEFAULTS.worldH, 5);
      idx.push(r.index); ddel.push(r.gap.deliveries);
    }
    const mi = idx.reduce((a, b) => a + b, 0) / idx.length;
    const md = ddel.reduce((a, b) => a + b, 0) / ddel.length;
    console.log(`K_sat×${f}=${c.K_sat}   index@w5=${mi.toFixed(3)}  del=${md.toFixed(0)}  [${idx.map(x => x.toFixed(2)).join(',')}]`);
  }
}

export function plateau(cfgStr) {
  const cfg = parseCfg(cfgStr);
  apply(cfg);
  const { world, field, colony, geo } = build(seedOf('p'), 'right', DEFAULTS.worldW, DEFAULTS.worldH);
  const nW = Math.round(WARM / DT);
  for (let t = 0; t < nW; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  }
  const { Mx, My, ax, ay, nx, ny } = geo;
  const K = cfg.K_sat, mode = cfg.saturationMode;
  console.log(`配置 ${mode}, K_sat=${K}`);
  // 横向剖面(过走廊中点, 垂直轴)
  const trans = [];
  for (let k = -90; k <= 90; k += 15) {
    const raw = field.sample(Mx + nx * k, My + ny * k);
    trans.push(sense(raw, mode, K).toFixed(2));
  }
  console.log('横向(垂直轴) sense:', trans.join(' '));
  // 沿路剖面(向食物端)
  const along = [];
  for (let k = 0; k <= 140; k += 14) {
    const raw = field.sample(Mx + ax * k, My + ay * k);
    along.push(`${raw.toFixed(2)}:${sense(raw, mode, K).toFixed(2)}`);
  }
  console.log('沿路 raw:sense (M→food):', along.join(' '));
  // 道上蚂蚁的 |FL-FR| 可读性 vs sensorDist(探针)
  for (const d of [10, 18, 26, 35, 45, 60]) {
    let acc = 0, cnt = 0;
    const sa = cfg.sensorAngle;
    for (let i = 0; i < colony.count; i++) {
      if (Math.abs(colony.px[i] - Mx) > 60 || Math.abs(colony.py[i] - My) > 60) continue;
      const th = colony.theta[i];
      const fl = field.sample(colony.px[i] + Math.cos(th + sa) * d, colony.py[i] + Math.sin(th + sa) * d);
      const fr = field.sample(colony.px[i] + Math.cos(th - sa) * d, colony.py[i] + Math.sin(th - sa) * d);
      acc += Math.abs(sense(fl, mode, K) - sense(fr, mode, K));
      cnt++;
    }
    if (cnt) console.log(`  探针d=${String(d).padEnd(3)} 道上|FL-FR| = ${(acc / cnt).toFixed(4)} (n=${cnt})`);
  }
  console.log('|FL-FR|≈0 =读不到路(两探针同落低场/同落高原); 越大=山脊横向差分越可读');
}

// P1.7 必须先看的诊断: conf 直方图,分三桶 路脊/断口内/路外 + 跨断口沿路剖面。
// 验证 smoothstep(0,K_conf,FL+FR) 是否能分清"稳在路上"与"丢路"。
export function confDiag(cfgStr) {
  const cfg = parseCfg(cfgStr);
  apply(cfg);
  const { world, field, colony, geo } = build(seedOf('conf'), 'right', DEFAULTS.worldW, DEFAULTS.worldH);
  const stepAll = () => {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  };
  const nW = Math.round(WARM / DT);
  for (let t = 0; t < nW; t++) stepAll(); // 暖机: 先成实路

  // 采样期: 持续擦断口(width 由 GAPW 环境指定,默认5身位), 按几何分类刷 conf
  const widthBodies = Number(process.env.GAPW || 5), roadLen = 90, half = widthBodies * BODY / 2, band = roadLen;
  const { Mx, My, ax, ay, nx, ny } = geo;
  const mode = cfg.saturationMode, Ksat = cfg.K_sat, K = cfg.K_conf;
  const buckets = { onRoad: { n: 0, sum: 0, g5: 0, g75: 0 }, inGap: { n: 0, sum: 0, g5: 0, g75: 0 }, offRoad: { n: 0, sum: 0, g5: 0, g75: 0 } };
  const profile = {}; // 轴=离断口中线 along 世界单位
  const nW2 = Math.round(WINDOW / DT);
  for (let t = 0; t < nW2; t++) {
    clearGap(field, geo, widthBodies, roadLen);   // 擦断口
    stepAll();
    for (let i = 0; i < colony.count; i++) {
      const px = colony.px[i], py = colony.py[i], th = colony.theta[i];
      const sp = sensorPoints(px, py, th, values.sensorAngle, values.sensorDist);
      const sl = sense(field.sample(sp.flx, sp.fly), mode, Ksat);
      const sr = sense(field.sample(sp.frx, sp.fry), mode, Ksat);
      const conf = confOf(sl, sr, K);
      const dx = px - Mx, dy = py - My;
      const along = dx * ax + dy * ay, cross = dx * nx + dy * ny;
      const key = Math.abs(cross) < band ? (Math.abs(along) < half ? 'inGap' : 'onRoad') : 'offRoad';
      const b = buckets[key];
      b.n++; b.sum += conf; if (conf >= 0.5) b.g5++; if (conf >= 0.75) b.g75++;
      if (Math.abs(cross) < 6) {
        const ak = Math.round(along / 6) * 6;
        if (!profile[ak]) profile[ak] = { n: 0, sum: 0 };
        profile[ak].sum += conf; profile[ak].n++;
      }
    }
  }
  console.log(`conf 直方图 (${mode}, K_sat=${Ksat}, K_conf=${K}, sensorDist=${values.sensorDist}, gap=width${widthBodies}身位) ; WARM=${WARM}s WINDOW=${WINDOW}s`);
  console.log('  桶         n_samples   mean   p(conf≥0.5)  p(conf≥0.75)');
  for (const [k, b] of Object.entries(buckets)) {
    const mean = b.sum / Math.max(1, b.n);
    console.log(`  ${k.padEnd(9)} ${String(b.n).padStart(7)}  ${mean.toFixed(3)}   ${(b.g5 / Math.max(1, b.n)).toFixed(2)}        ${(b.g75 / Math.max(1, b.n)).toFixed(2)}`);
  }
  console.log(`  分得开性判据: onRoad.mean 应 ≈1 ; inGap&offRoad.mean 应 ≪ onRoad.mean (≈0)。`);
  console.log('  跨断口沿路剖面 (x=离断口中线 along, 断口在 ' + (-half).toFixed(1) + '..' + half.toFixed(1) + '):');
  const keys = Object.keys(profile).map(Number).sort((a, b) => a - b);
  console.log('  ' + keys.map(k => { const b = profile[k]; return `${String(k).padStart(5)}:${(b.sum / Math.max(1, b.n)).toFixed(2)}`; }).join(' '));
}

const mode = process.argv[2];
if (existsSync(OUT)) mkdirSync(OUT, { recursive: true });
else mkdirSync(OUT, { recursive: true });
switch (mode) {
  case 'time': timing(); break;
  case 'grid': grid(); break;
  case 'dose': dose(process.argv[3] || 'saturationMode=mm,K_sat=0.05,sensorDist=26,sensorAngle=0.79'); break;
  case 'robust': robust(process.argv[3] || 'saturationMode=mm,K_sat=0.05,sensorDist=26,sensorAngle=0.79'); break;
  case 'plateau': plateau(process.argv[3] || 'saturationMode=mm,K_sat=0.05,sensorDist=26,sensorAngle=0.79'); break;
  case 'conf': confDiag(process.argv[3] || 'saturationMode=log,K_sat=0.02,sensorDist=45,sensorAngle=0.79'); break;
  default: console.log('modes: time | grid | dose <cfg> | robust <cfg> | plateau <cfg>'); break;
}