// P2.2 机制 / P2.3 方法论重做: 报警信息素 + 捕食者验收 v2。
// 用法: node predator_check.mjs      (PARAMS=k=v 覆盖参数, SEED=xxx, AB=0 跳过报警 A/B 对照)
//
// v1 的全部数字作废(见 METRICS「P2.3 教训」)。三处造假来源:
//  ① v1 在 B/C 段忘了 field.step() → 轨迹场冻在 A 段末尾的形状里 380 秒不衰减,
//     于是"走廊恢复满负荷 144/s"是人工保形的产物。v2 全程诚实衰减。
//  ② v1 的 A 段只有 60 秒 —— 那还是成路爬坡期(实测 A 后半稳态 317/s, 前 60s 均值 15/s)。
//     拿爬坡期当分母, 任何后续读数都能算出"627%"。v2 的 A=180s, 只用后半段做基线。
//  ③ v1 食物 1e5, 注释写"管饱"—— 实测健康蚁群 ~315/s 的吞吐 440 秒就吃空了。v2 用 1e9 并断言未耗尽。
//  ④ 判据从"单一比值"改为"20s 窗口分布 + 恢复时间"; 吞吐类断言只用于撤离段。
//
// 阶段: A(0-180) 成路基线 → B(180-360) 捕食者压在主路中点 → C(360-660) 撤离重建
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
const AB = process.env.AB !== '0';
const A_T = 180, B_T = 180, C_T = 300;
const W = 20;                  // 窗口长度(秒)
const PRED_R = 45;             // 捕杀半径
const NEAR_R = 60;             // 落点邻域统计半径(看"避险"而非"死绝")
const CORR_W = 25;             // 巢→食物直线走廊半宽
const FOOD = 1e9;              // 管饱(见头注③)

function runArm(alarmOn) {
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  const alarmField = alarmOn ? new Field(values.worldW, values.worldH, values.gridCell) : null;
  const fx = values.worldW * 0.62, fy = values.worldH * 0.62;
  world.addFood(fx, fy, 30, FOOD);
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(SEED)), world, nestRadius: values.nestRadius });
  const px0 = (world.nestX + fx) / 2, py0 = (world.nestY + fy) / 2;
  const ax = world.nestX, ay = world.nestY, abx = fx - ax, aby = fy - ay, abL2 = abx * abx + aby * aby;
  function segDist(x, y) {
    let t = ((x - ax) * abx + (y - ay) * aby) / abL2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
  }

  const per = [];
  let prevDel = 0, prevKill = 0, sec = 0, foodMin = FOOD;
  function sample(ph) {
    sec++;
    let near = 0, corr = 0, loaded = 0;
    for (let i = 0; i < colony.count; i++) {
      if (colony.load[i] > 0) loaded++;
      if (Math.hypot(colony.px[i] - px0, colony.py[i] - py0) < NEAR_R) near++;
      if (segDist(colony.px[i], colony.py[i]) < CORR_W) corr++;
    }
    const f = world.foodPatches[0].amount;
    if (f < foodMin) foodMin = f;
    per.push({ ph: ph, del: colony.deliveries - prevDel, kill: colony.kills - prevKill, near: near, corr: corr,
      loaded: loaded, food: f, alarm: alarmField ? alarmField.sample(px0, py0) : 0 });
    prevDel = colony.deliveries; prevKill = colony.kills;
  }
  function phase(ph, T, leave) {
    for (let t = 0; t < T * 60; t++) {
      field.step(values.diffuseWeight, Math.pow(values.decayRate, DT), null);
      if (alarmField) alarmField.step(values.diffuseWeight, Math.pow(values.alarmDecay, DT), null);
      colony.step(field, world, values, DT, alarmField);
      if ((t + 1) % 60 === 0) sample(ph);
    }
    if (leave) leave();
  }
  phase('A', A_T, () => world.placePredator(px0, py0, PRED_R));
  phase('B', B_T, () => world.removePredator());
  phase('C', C_T, null);

  const wins = [];
  for (let s = 0; s + W <= per.length; s += W) {
    const g = per.slice(s, s + W);
    const m = (k) => g.reduce((a, x) => a + x[k], 0) / W;
    wins.push({ ph: g[0].ph, from: s, to: s + W, del: m('del'), kill: m('kill'), near: m('near'), corr: m('corr'),
      loaded: Math.max.apply(null, g.map(x => x.loaded)), alarm: Math.max.apply(null, g.map(x => x.alarm)), food: g[g.length - 1].food });
  }
  const sel = (ph, from) => wins.filter(w => w.ph === ph && (from === undefined || w.from >= from));
  const mean = (l, k) => l.length ? l.reduce((a, x) => a + x[k], 0) / l.length : 0;
  const med = (l, k) => { const a = l.map(x => x[k]).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const wA = sel('A'), wA2 = sel('A', Math.floor(A_T / 2)), wB = sel('B'), wC = sel('C');
  const tail = sel('C', C_T - 60);
  const fadeW = wC.find(w => w.alarm < values.alarmSens);
  return {
    alarmOn: alarmOn, wins: wins, kills: colony.kills, del: colony.deliveries, foodMin: foodMin,
    A: med(wA2, 'del'), wA2: wA2, wB: wB, wC: wC,
    delB: med(wB, 'del'), delC: med(wC, 'del'), delTail: mean(tail, 'del'),
    nearA: mean(wA, 'near'), nearB: mean(wB, 'near'), nearC: mean(wC, 'near'),
    corrA: mean(wA, 'corr'), corrTail: mean(tail, 'corr'),
    killFirst: wB.length ? wB[0].kill : 0, killLast: wB.length ? wB[wB.length - 1].kill : 0,
    alarmFade: fadeW ? fadeW.from - wC[0].from : -1
  };
}

function statLine(r) {
  return 'A 稳态 ' + r.A.toFixed(1) + '/s | B ' + r.delB.toFixed(1) + '/s (' + (r.delB / r.A * 100).toFixed(1) + '%A) | C 末60s ' +
    r.delTail.toFixed(1) + '/s (' + (r.delTail / r.A * 100).toFixed(0) + '%A) | 邻域流量 A ' + r.nearA.toFixed(0) + '→B ' + r.nearB.toFixed(0) +
    ' | 走廊 A ' + r.corrA.toFixed(0) + '→C末 ' + r.corrTail.toFixed(0) + ' | 捕杀合计 ' + r.kills + ' (首窗 ' + r.killFirst.toFixed(1) + '/s→末窗 ' + r.killLast.toFixed(2) + '/s) | 报警散尽 ' + r.alarmFade + 's';
}

const CHECK = [];
function check(name, ok, detail) { CHECK.push({ name: name, ok: !!ok, detail: detail }); console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' :: ' + detail); }

const t0 = Date.now();
console.log('=== P2.2/P2.3 捕食者验收 v2 (seed=' + SEED + ', 诚实衰减, 食物管饱) ===');
const on = runArm(true);
console.log('报警开 : ' + statLine(on));
console.log('窗口 del/s  ' + on.wins.map(w => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(w.del / (on.A * 8) * 7.999 + 1e-9))]).join('') +
  '  (每格' + W + 's, 满格=' + on.A.toFixed(0) + '/s)');
const blind = AB ? runArm(false) : null;
if (blind) {
  console.log('报警关 : ' + statLine(blind));
  console.log('窗口 del/s  ' + blind.wins.map(w => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(w.del / (blind.A * 8) * 7.999 + 1e-9))]).join(''));
}

console.log('');
check('危险区塌陷: B 邻域流量 ≤ 10% A', on.nearB <= 0.10 * on.nearA, 'B/A = ' + (on.nearB / on.nearA * 100).toFixed(1) + '%');
check('涌现避险: 捕杀率末窗 < 首窗的 1/10', on.killLast < on.killFirst / 10, on.killFirst.toFixed(1) + '/s → ' + on.killLast.toFixed(2) + '/s');
check('报警散尽: 撤走后 ≤ 60s 落回感知阈值', on.alarmFade >= 0 && on.alarmFade <= 60, on.alarmFade + 's');
check('走廊重建: C 末 60s 走廊流量 ≥ 40% A', on.corrTail >= 0.40 * on.corrA, (on.corrTail / on.corrA * 100).toFixed(0) + '% (A ' + on.corrA.toFixed(0) + ' → C末 ' + on.corrTail.toFixed(0) + ')');
check('吞吐回升: C 末 60s ≥ 25% 稳态且高于 B', on.delTail >= 0.25 * on.A && on.delTail >= on.delB, (on.delTail / on.A * 100).toFixed(0) + '%A (B 中位 ' + on.delB.toFixed(1) + '/s)');
check('食物未耗尽(读数非饥饿伪影): 余量 ≥ 99%', on.foodMin >= FOOD * 0.99 && (blind ? blind.foodMin >= FOOD * 0.99 : true), '最低余量 ' + (on.foodMin / 1e6).toFixed(1) + 'M/' + (FOOD / 1e6) + 'M');
if (blind) {
  check('报警的价值: 总捕杀 ≤ 盲蚁的 5%', on.kills <= 0.05 * blind.kills, on.kills + ' vs ' + blind.kills + ' = ' + (on.kills / blind.kills * 100).toFixed(1) + '%');
  check('报警的价值: 危险区停留 ≤ 盲蚁的 50%', on.nearB <= 0.50 * blind.nearB, on.nearB.toFixed(0) + ' vs ' + blind.nearB.toFixed(0));
}
console.log('[交底] B 段吞吐 ' + (on.delB / on.A * 100).toFixed(1) + '%A —— 诚实衰减下蚁群"断粮不送死", 绕行改道没有涌现。' +
  'v1 的"改道不断粮 ≥35%"依赖被冻结的轨迹场, 正式作废; 缺口记入 HANDOVER §7 技术债(个体路线记忆, P2.4+)。');
const bad = CHECK.filter(c => !c.ok);
console.log('=== ' + (bad.length ? bad.length + ' FAIL / ' : '') + CHECK.length + ' 项断言, 耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's ===');
if (bad.length) process.exit(1);
