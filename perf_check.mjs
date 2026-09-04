// 性能基线 + 数值等价性校验脚本（在项目目录运行）
// 用法: node perf_check.mjs
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

const DT = 1 / 60;
// PARAMS=k=v,k=v 覆盖任意参数(A/B 回归用)
if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    values[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}
// 3600 步 = 60s: 必须覆盖 forageTimeout(默认 30s)之后的返巢/信任折扣路径,
// 否则校验和对 P1.9 新行为不敏感(1500 步时新旧 checksum 完全一致, 已验证)
const STEPS = 3600, WARM = 100, N = 5000;

const world = new World(values.worldW, values.worldH);
const field = new Field(values.worldW, values.worldH, values.gridCell);
const r = rng(hashSeed('perfseed'));
world.addFood(values.worldW / 2 + 80, values.worldH / 2 + 30, 30, 400);
const colony = new Colony(N, { rng: r, world, nestRadius: values.nestRadius });

// 预热（计时外）
for (let i = 0; i < WARM; i++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
  colony.step(field, world, values, DT);
}

// ---- 性能: 计时段（覆盖觅食→沉积→回巢全路径）----
const t0 = performance.now();
for (let i = 0; i < STEPS; i++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
  colony.step(field, world, values, DT);
}
const t1 = performance.now();

// ---- 正确性校验: 计时段结束后的状态校验和（含 field/deposit/delivery）----
let sum = 0;
for (let i = 0; i < N; i++) {
  sum += colony.px[i] + colony.py[i] + colony.theta[i] + colony.hx[i] + colony.hy[i] + colony.load[i];
}
let fieldSum = 0;
for (let i = 0; i < field.buf.length; i++) fieldSum += field.buf[i];
console.log('CHECKSUM ants :', sum.toPrecision(17));
console.log('CHECKSUM field:', fieldSum.toPrecision(17));
console.log('deliveries    :', colony.deliveries, ' timeouts:', colony.timeouts, ' loaded:', colony.loadedCount(), ' 空手返巢:', colony.aborts);

const perStep = (t1 - t0) / STEPS;
console.log(`PERF: ${perStep.toFixed(3)} ms/step  (${(1000 / perStep).toFixed(1)} steps/s, ${(N * STEPS / (t1 - t0) / 1000).toFixed(2)}M ant-steps/s)`);
