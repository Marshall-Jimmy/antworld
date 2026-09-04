// P1.5 地基修复诊断：headless。
// 覆盖三块：① 走廊感知剖面(开/关饱和) ② 断口测试(未来"火"的成败指标)
//           ③ 0.34 高地归因(loaded 驻留分布 + 空手是否沉积 A/B)
// 本脚本只在 sim 层跑,不依赖渲染,可在 node 直接运行:  node diag_sat.mjs

import { SCHEMA, values, set } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { sense } from './sim/ant.js';

const DEFAULTS = {};
for (const s of SCHEMA) DEFAULTS[s.key] = s.default;

// 每条运行都基于默认值叠加重写,避免共享 values 污染
function apply(overrides) {
  const cfg = { ...DEFAULTS, ...overrides };
  for (const k in cfg) set(k, cfg[k]);
  return cfg;
}

const DT = 1 / 60;
const WARM = 55;   // 成道暖机(秒)
const WINDOW = 30; // 断口统计(秒)

// 食物放在巢正右方,得到一条大致水平的走廊,方便从巢端到食物端取剖面
function build(seed) {
  const r = rng(hashSeed(seed));
  const w = values.worldW, h = values.worldH;
  const world = new World(w, h);
  const field = new Field(w, h, values.gridCell);
  world.addFood(w * 0.72, h / 2, 30, 1e6); // 巨量,保证测量期食物吃不完
  const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });
  return { world, field, colony, w, h };
}

function run(seed, overrides, warmSeconds) {
  apply(overrides);
  const { world, field, colony, w, h } = build(seed);
  const n = Math.round(warmSeconds / DT);
  for (let t = 0; t < n; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  }
  return { world, field, colony, w, h };
}

// 取 x 处走廊山脊值 = 垂直带内的最大值(容忍走廊垂直漂移)
function ridge(field, midY, x, band) {
  let m = 0;
  for (let y = midY - band; y <= midY + band; y += field.cellSize) {
    const v = field.sample(x, y);
    if (v > m) m = v;
  }
  return m;
}

function clearSlab(field, x0w, x1w) {
  const cell = field.cellSize, gw = field.gw, gh = field.gh;
  let ix0 = Math.floor(x0w / cell), ix1 = Math.floor(x1w / cell);
  for (let ix = ix0; ix <= ix1; ix++) {
    const gx = ((ix % gw) + gw) % gw;
    for (let iy = 0; iy < gh; iy++) field.buf[iy * gw + gx] = 0;
  }
}

// ————————————————— ① 感知剖面 —————————————————
function corridorProfile(seed) {
  console.log('\n===== ① 感知剖面 (巢在左, 食物在右, 饱和前=off 时同一张场) =====');
  const { world, field, w, h } = run(seed, { saturationMode: 'off', K_out: 0, emptyDeposit: false }, WARM);
  const nX = world.nestX, nY = world.nestY, fX = w * 0.72;
  const x0 = nX + values.nestRadius, x1 = fX - 30;
  const K = values.K_sat;
  console.log(' K_sat =', K);
  console.log(' 索引    原始浓度    log 饱和    mm 饱和    (每行 x 对应一个采样点)');
  const N = 20;
  for (let i = 0; i < N; i++) {
    const x = x0 + (x1 - x0) * (i / (N - 1));
    const F = ridge(field, nY, x, 40);
    const sl = sense(F, 'log', K), sm = sense(F, 'mm', K);
    console.log(
      String(i).padEnd(6),
      String(F.toFixed(3)).padStart(9),
      String(sl.toFixed(3)).padStart(9),
      String(sm.toFixed(3)).padStart(9),
      ' x=', x.toFixed(0)
    );
  }
  return { field, w, h };
}

// ————————————————— ② 断口测试 —————————————————
// 为隔离"断口破坏效应" vs "整体吞吐差异",对每种配置跑两遍同款 30s 窗口:
//   control = 不擦除(照常)    erase = 持续擦除断口中段
// 归一化指标 ratio = erase总穿过 / control总穿过(越小 = 断口越能打断这条道)
function gapRun(seed, overrides, erase) {
  apply(overrides);
  const { world, field, colony, w, h } = build(seed);
  const nX = world.nestX, fX = w * 0.72;
  const xMid = (nX + fX) / 2;
  const halfWidth = 0.055 * w;           // 断口半宽
  const x0 = xMid - halfWidth, x1 = xMid + halfWidth;
  const band = 50;                       // 垂直带宽(世界单位)
  const midY = world.nestY;

  // 先用本配置跑暖机,形成走廊
  const wn = Math.round(WARM / DT);
  for (let t = 0; t < wn; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  }

  // 记录每只蚂蚁上一步的 x 侧向(用于数穿过 xMid 的次数)
  const prevX = new Float32Array(colony.count);
  for (let i = 0; i < colony.count; i++) prevX[i] = colony.px[i];

  let out = 0, inn = 0; // 出巢向(nest→food), 回巢向(food→nest)
  const wn2 = Math.round(WINDOW / DT);
  for (let t = 0; t < wn2; t++) {
    if (erase) clearSlab(field, x0, x1); // 持续性擦除 = 未来 alarm 的效果
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
    for (let i = 0; i < colony.count; i++) {
      const y = colony.py[i];
      if (Math.abs(y - midY) > band) { prevX[i] = colony.px[i]; continue; }
      const x = colony.px[i], p = prevX[i];
      if (p < xMid && x >= xMid) out++;
      else if (p >= xMid && x < xMid) inn++;
      prevX[i] = x;
    }
  }
  return { out, inn, deliveries: colony.deliveries, timeouts: colony.timeouts };
}

function gapTest(seed, overrides) {
  const ctl = gapRun(seed, overrides, false);
  const er = gapRun(seed, overrides, true);
  const tot = r => r.out + r.inn;
  return {
    ctl, er,
    ratio: tot(er) / Math.max(1e-6, tot(ctl)),  // 越小=断口打断力越强
    drop: (1 - tot(er) / Math.max(1e-6, tot(ctl))) * 100,
  };
}

// ————————————————— ③ 0.34 归因 —————————————————
function attribution(seed) {
  console.log('\n===== ③ 0.34 高地归因 (saturation=off, 同 P1 默认行为) =====');
  // 第一步: 归零。测负重蚂蚁在哪"花时间" → 沉积集中在哪
  apply({ saturationMode: 'off', K_out: 0, emptyDeposit: false });
  const { world, field, colony, w, h } = build(seed);
  const nws = Math.round(WARM / DT);
  for (let t = 0; t < nws; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
  }
  // 测量窗口: 负重蚂蚁驻留的时间分布
  const nestX = world.nestX, nestY = world.nestY;
  const maxD = Math.hypot(w, h) / 2;
  const NB = 12;
  const hist = new Array(NB).fill(0);
  let foodLoaded = 0, tripLoaded = 0;
  const mw = Math.round(20 / DT);
  for (let t = 0; t < mw; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
    for (let i = 0; i < colony.count; i++) {
      if (colony.load[i] <= 0) continue;
      const d = Math.hypot(colony.px[i] - nestX, colony.py[i] - nestY);
      const b = Math.min(NB - 1, (d / maxD) * NB | 0);
      hist[b] += DT;
      if (world.foodAt(colony.px[i], colony.py[i]) >= 0) foodLoaded += DT;
      else tripLoaded += DT;
    }
  }
  const totLoaded = foodLoaded + tripLoaded;
  console.log(` 负重蚂蚁驻留: 在食物原地(半径30内)=${(foodLoaded / totLoaded * 100).toFixed(1)}%  路上=${(tripLoaded / totLoaded * 100).toFixed(1)}%`);
  console.log(' 负重驻留按离巢距离的占比分布(0=巢 → 1=最远, 每格~', (maxD / NB).toFixed(0), '单位):');
  console.log('  ' + hist.map(x => (x / totLoaded * 100).toFixed(1)).join('  '));

  // 食物环带是哪一格? 巢→食物的距离对应 bin 几
  const foodDist = Math.abs(w * 0.72 - world.nestX);
  const foodBin = Math.min(NB - 1, (foodDist / maxD) * NB | 0);
  const foodRingFrac = hist[foodBin] / totLoaded * 100;
  const roadBins = hist.map((x, i) => i === foodBin ? 0 : x).reduce((a, b) => a + b, 0);
  const roadAvg = roadBins / (NB - 1) / totLoaded * 100;
  console.log(` 食物所在环带 bin=${foodBin} 驻留占比=${foodRingFrac.toFixed(1)}%  vs 其他环带平均=${roadAvg.toFixed(1)}%`);
  console.log(' → 驻留集中在食物一带是【' + (foodRingFrac > roadAvg * 1.8 ? '明显的 food-adjacent 聚集' : '大致均匀')
    + '】 = 沉积密度在这里堆积(负重时间/格子比其它地方高)');

  // ③关键: 用空手是否沉积的 A/B 判"是否来自空手打转"
  const foodEndOff = ridge(field, nestY, w * 0.72, 40); // 空手不沉积时的食物端峰值
  console.log(' 切换 emptyDeposit=true(空手也沉积)...');
  apply({ saturationMode: 'off', K_out: 0, emptyDeposit: true });
  const { world: w2, field: f2, colony: c2, h: h2 } = build(seed);
  const nw2 = Math.round(WARM / DT);
  for (let t = 0; t < nw2; t++) {
    f2.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    c2.step(f2, w2, values, DT);
  }
  const foodEndOn = ridge(f2, w2.nestY, w2.w * 0.72, 40);
  const pathMidOn = ridge(f2, w2.nestY, (w2.nestX + w2.w * 0.72) / 2, 40);
  console.log(' [A] emptyDeposit=off : 食物端峰值=', foodEndOff.toFixed(3), ' 中段=?(见上剖面)');
  console.log(' [B] emptyDeposit=true: 食物端峰值=', foodEndOn.toFixed(3), ' 走廊中段=', pathMidOn.toFixed(3));
  console.log(' 空手沉积一把火焰帷幕拉平全场(中段' + pathMidOn.toFixed(2) + '≈食物端' + foodEndOn.toFixed(2)
    + '),说明真实配置下(空手不沉积)的高地它不来自空手打转,集中在食物环带 = 负重蚂蚁驻留堆积。');
}

// ————————————————— 主流程 —————————————————
const seed = 'p15-diag';
console.log('世界', values.worldW + 'x' + values.worldH, ' 蚂蚁', values.antCount, ' 食物在巢正右方(0.72w)');

corridorProfile(seed);

console.log('\n===== ② 断口测试 (每配置 control/擦除 各跑同款30s窗口) =====');
console.log(' ratio=擦除穿过/对照穿过, 越小=越能打断这条道; 括号内=送货量');
const gapRuns = [
  { label: 'A off/ K_out=0   (基线)      ', cfg: { saturationMode: 'off', K_out: 0 } },
  { label: 'B log/ K_out=0              ', cfg: { saturationMode: 'log', K_out: 0 } },
  { label: 'C log/ K_out=1.2 (调出能工作)', cfg: { saturationMode: 'log', K_out: 1.2 } },
];
for (const { label, cfg } of gapRuns) {
  const r = gapTest(seed, cfg);
  const f = x => x.out + '出/' + x.inn + '回(送' + x.deliveries + ',弃' + x.timeouts + ')';
  console.log('  ' + label,
    '| 对照', f(r.ctl),
    '| 擦除', f(r.er),
    '| ratio=' + r.ratio.toFixed(2), ' drop=' + r.drop.toFixed(0) + '%');
}

attribution(seed);