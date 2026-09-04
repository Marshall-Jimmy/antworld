// P2.2 验收: 报警信息素 + 捕食者。
// 路线图验收标准: 捕食者压在主路上 → 3 分钟内路线改道(不断粮); 撤走 → 5 分钟内走廊恢复。
// 用法: node predator_check.mjs   (PARAMS=k=v 环境变量可覆盖参数)
//
// 阶段设计:
//   A(0~60s)   成路: 记录卸货速率、捕食者落点邻域流量(NEAR_R)、走廊流量基线
//   B(60~240s) 压境: 捕食者放在巢→食物直线中点。期望: 邻域流量塌陷、捕杀先高后低(涌现避险)、
//              卸货经改道继续(速率不塌方)
//   C(240~540s) 撤离: 期望报警几秒内散尽、邻域流量 5 分钟内恢复到基线一半
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    values[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}

const DT = 1 / 60;
const SEED = process.env.SEED || 'predcheck';
const A_T = 60, B_T = 180, C_T = 300;
const PRED_R = 45;      // 捕杀半径
const NEAR_R = 60;      // 邻域流量统计半径(捕杀圈外一圈, 可见"避险"而非"死绝")
const CORRIDOR_W = 25;  // 走廊带半宽(巢→食物直线)

const world = new World(values.worldW, values.worldH, values.gridCell);
const field = new Field(values.worldW, values.worldH, values.gridCell);
const alarmField = new Field(values.worldW, values.worldH, values.gridCell);
const fx = values.worldW * 0.62, fy = values.worldH * 0.62;
world.addFood(fx, fy, 30, 100000);   // 管饱: 本验收测路线动力学, 食物耗尽可能污染 B/C 阶段读数
const colony = new Colony(values.antCount, { rng: rng(hashSeed(SEED)), world, nestRadius: values.nestRadius });
const px0 = (world.nestX + fx) / 2, py0 = (world.nestY + fy) / 2;   // 巢→食物中点 = 捕食者落点

// 点到巢→食物线段的距离(世界中心区域, 不涉及 toroidal 缝)
const ax = world.nestX, ay = world.nestY, bx = fx, by = fy;
const abx = bx - ax, aby = by - ay;
const abLen2 = abx * abx + aby * aby;
function segDist(x, y) {
  let t = ((x - ax) * abx + (y - ay) * aby) / abLen2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
}

// ---- 阶段 A: 成路 ----
let delA = 0;
let nearA = 0, corrA = 0, nA = 0;
for (let t = 0; t < A_T * 60; t++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, DT), null);
  colony.step(field, world, values, DT, alarmField);
  if (t % 60 === 0) {
    let near = 0, corr = 0;
    for (let i = 0; i < colony.count; i++) {
      if (Math.hypot(colony.px[i] - px0, colony.py[i] - py0) < NEAR_R) near++;
      if (segDist(colony.px[i], colony.py[i]) < CORRIDOR_W) corr++;
    }
    nearA += near; corrA += corr; nA++;
  }
}
delA = colony.deliveries;
nearA /= nA; corrA /= nA;

// ---- 阶段 B: 捕食者压境 ----
world.placePredator(px0, py0, PRED_R);
const del0B = colony.deliveries, kills0B = colony.kills;
const killBuckets = [0, 0, 0];       // 每 60s 一桶
let nearB = 0, nB = 0, alarmMaxB = 0;
for (let t = 0; t < B_T * 60; t++) {
  alarmField.step(values.diffuseWeight, Math.pow(values.alarmDecay, DT), null);
  colony.step(field, world, values, DT, alarmField);
  const step = A_T * 60 + t;
  if (t % 60 === 0) {
    let near = 0;
    for (let i = 0; i < colony.count; i++) {
      if (Math.hypot(colony.px[i] - px0, colony.py[i] - py0) < NEAR_R) near++;
    }
    nearB += near; nB++;
    const av = alarmField.sample(px0, py0);
    if (av > alarmMaxB) alarmMaxB = av;
  }
  killBuckets[Math.floor(t / (60 * 60))] = colony.kills - kills0B;
}
const delB = colony.deliveries - del0B;
const killsB = colony.kills - kills0B;
nearB /= nB;
const killDelta = [killBuckets[0], killBuckets[1] - killBuckets[0], killBuckets[2] - killBuckets[1]];

// ---- 阶段 C: 撤离观察 ----
world.removePredator();
const del0C = colony.deliveries;
let alarmFadeT = -1, recT = -1;
let nearC = 0, nC = 0;
const recWin = [];   // 近 10 个采样的邻域流量(恢复判定: 连续 10s ≥ 基线一半)
for (let t = 0; t < C_T * 60; t++) {
  alarmField.step(values.diffuseWeight, Math.pow(values.alarmDecay, DT), null);
  colony.step(field, world, values, DT, alarmField);
  if (t % 60 === 0) {
    let near = 0;
    for (let i = 0; i < colony.count; i++) {
      if (Math.hypot(colony.px[i] - px0, colony.py[i] - py0) < NEAR_R) near++;
    }
    nearC += near; nC++;
    if (alarmFadeT < 0 && alarmField.sample(px0, py0) < values.alarmSens) alarmFadeT = t / 60;
    recWin.push(near);
    if (recWin.length > 10) recWin.shift();
    if (recT < 0 && recWin.length === 10 && recWin.every(v => v >= nearA * 0.5)) recT = t / 60;
  }
}
const delC = colony.deliveries - del0C;
nearC /= nC;
if (alarmFadeT < 0) alarmFadeT = C_T;   // 全程没散尽
if (recT < 0) recT = C_T + 1;           // 全程没恢复

// ---- 报告 ----
console.log('=== P2.2 捕食者验收 (seed=' + SEED + ') ===');
console.log(`阶段A 成路 ${A_T}s     : 卸货 ${delA} (${(delA / A_T).toFixed(2)}/s)  落点邻域流量 ${nearA.toFixed(0)}  走廊流量 ${corrA.toFixed(0)}`);
console.log(`阶段B 压境 ${B_T}s    : 卸货 ${delB} (${(delB / B_T).toFixed(2)}/s, =A的${(delB / B_T / (delA / A_T) * 100).toFixed(0)}%)  捕杀 ${killsB} (分桶 ${killDelta.join(' → ')})  邻域流量 ${nearB.toFixed(0)} (塌至A的${(nearB / nearA * 100).toFixed(0)}%)  报警峰值 ${alarmMaxB.toFixed(2)}`);
console.log(`阶段C 撤离 ${C_T}s    : 卸货 ${delC} (${(delC / C_T).toFixed(2)}/s)  报警散尽 ${alarmFadeT}s  邻域流量恢复(≥基线50%,连续10s) ${recT <= C_T ? recT + 's' : '未恢复'}  末段均流量 ${nearC.toFixed(0)}`);

const ok1 = delB / B_T >= 0.35 * delA / A_T;   // 改道不断粮
const ok2 = killDelta[2] < killDelta[0];       // 捕杀递减 → 涌现避险
const ok3 = nearB <= 0.6 * nearA;              // 危险区塌陷
const ok4 = recT <= C_T;                       // 5 分钟内恢复
console.log(`[${ok1 ? 'PASS' : 'FAIL'}] B阶段改道: 卸货速率保持 ≥ 35% 基线 (实际 ${(delB / B_T / (delA / A_T) * 100).toFixed(0)}%)`);
console.log(`[${ok2 ? 'PASS' : 'FAIL'}] 捕杀递减: 末桶 ${killDelta[2]} < 首桶 ${killDelta[0]} (信息素避险生效)`);
console.log(`[${ok3 ? 'PASS' : 'FAIL'}] 危险区塌陷: B阶段邻域流量 ≤ 60% 基线 (实际 ${(nearB / nearA * 100).toFixed(0)}%)`);
console.log(`[${ok4 ? 'PASS' : 'FAIL'}] C阶段恢复: 5 分钟内走廊流量回到基线 50% (实际 ${recT <= C_T ? recT + 's' : '未恢复'})`);
if (!(ok1 && ok2 && ok3 && ok4)) process.exit(1);
