// 标定探针 · 出厂散粮的枯竭曲线(P2.4e)
//
// 为什么要有这个文件: P2.3.5 把食物画成了「会被啃的种子」, 但默认场景那块源只有 200 单位,
// 出厂 5000 蚁几十秒就搬空——缺口长不出来就看不见。要重标定剂量, 得先有**取食速率**这个数,
// 而它只能量出来不能拍脑袋。preset_check 的 P1i/P1l 钉的是结论(三颗种子各跑 300 秒), 这个文件
// 给出的是整条曲线与对照臂: 旧场景为什么不行、新场景撑多久, 都靠它复测。
//
// 跑法: node food_drain_probe.mjs                (出厂散粮跑到 900s, 外加旧场景对照 120s)
//       SECS=180 ARMS=new node food_drain_probe.mjs   (只看短时间窗/只跑一支, 省机时)
//       ARMS=micro node food_drain_probe.mjs         (单源吞吐上限四臂, 见文件尾 micro 注)
import { values, set, SCHEMA, get } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { buildDefaultFoods } from './core/presets.js';

const DT = 1 / 60;
const SECS = Number(process.env.SECS || 900);
const ARMS = (process.env.ARMS || 'old,new').split(',').map((s) => s.trim());
const SEED = process.env.SEED || 'drainprobe';

// mode='new' 用出厂散粮登记处; mode='old' 复刻 P2.4e 之前的那块单源(对照臂, 剂量 200)
function build(mode) {
  for (const s of SCHEMA) set(s.key, s.default);
  const w = get('worldW'), h = get('worldH'), cell = get('gridCell');
  const world = new World(w, h, cell);
  const field = new Field(w, h, cell);
  const alarm = new Field(w, h, cell);
  const r = rng(hashSeed(SEED));
  const colony = new Colony(get('antCount'), { rng: r, world, nestRadius: get('nestRadius') });
  if (mode === 'new') {
    buildDefaultFoods(world, r);
  } else {
    world.addFood(w * (0.55 + r() * 0.2), h * (0.55 + r() * 0.2), 30, 200);
  }
  const born = world.foodPatches.map((f) => f.amount);
  return { world, field, alarm, colony, born };
}

function run(mode, secs) {
  const { world, field, alarm, colony, born } = build(mode);
  const spots = world.foodPatches.length;
  const total0 = born.reduce((a, b) => a + b, 0);
  console.log(`\n### ${mode}: ${spots} 块源 · 出生剂量 ${born.join(' / ')} = ${total0} · ${get('antCount')} 蚁`);
  console.log('   t(秒)  余量总计      已吃速率(u/s)   负重   卸货   各块剩余%');
  let lastEaten = 0, lastT = 0;
  for (let step = 1; step <= secs * 60; step++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT, alarm);
    const t = step * DT;
    // 打印节奏: 每 30 秒一行, 外加头 10 秒每 2 秒一行(找「首口」与爬升段)。
    // 上一版写成 `|| t <= 1`, 而 t 是浮秒——前 60 步全满足, 于是 0 秒被刷了 59 行。
    if (step % Math.round(30 / DT) === 0 || (t <= 10 && step % Math.round(2 / DT) === 0)) {
      const now = world.foodPatches.map((f) => f.amount);
      const total = now.reduce((a, b) => a + b, 0);
      const eaten = total0 - total;
      const rate = (eaten - lastEaten) / (t - lastT || 1);
      lastEaten = eaten; lastT = t;
      const pct = world.foodPatches.map((f, i) => (f.amount / born[i] * 100).toFixed(0) + '%').join(' ');
      console.log(`   ${t.toFixed(0).padStart(5)}  ${total.toFixed(1).padStart(9)}   ${rate.toFixed(2).padStart(12)}   ${String(colony.loadedCount()).padStart(5)}  ${String(colony.deliveries).padStart(6)}   ${pct}`);
    }
    if (!world.foodPatches.length) { console.log(`   ${t.toFixed(1)}s 全部见底, 最后一块被搬空`); break; }
  }
  const left = world.foodPatches.reduce((a, f) => a + f.amount, 0);
  console.log(`   末读数: 剩 ${left.toFixed(1)}/${total0} (${(left / total0 * 100).toFixed(1)}%) · 卸货 ${colony.deliveries} · 种群 ${colony.population}`);
  return { total0, left };
}

// ARMS=micro 时只跑四臂, 不必再等 900 秒的对照/新场景
if (!ARMS.includes('micro')) {
  const a = run('old', Math.min(120, SECS));
  const b = run('new', SECS);
  console.log(`\n对照: 旧场景 120s 剩 ${(a.left / a.total0 * 100).toFixed(1)}% · 新场景同窗剩 ${(b.left / b.total0 * 100).toFixed(1)}%`);
}

// ---- micro 臂: 一块源到底能被啃多快(剂量标定的分母) ----
// 四臂 = 半径 16/32/64 × 距巢 227/453u, 每臂喂 1e9 单位(永不枯竭)跑 260 秒, 读 200~250 秒的稳态段。
// 结论(读数当场打印, 别抄进文件头): ① 小源撑不起走廊——r=16 那一臂吞吐≈0、负重个位数、弃货上千;
// ② 吞吐对**半径**比对**距离**敏感得多, 距离主要吃的是行程预算(tripBudget)而不是速率。
// ⇒ 近籽的剂量不能按「距离近就多给」算; 出厂主源 r=32 的**饱和期**速率区间就是 FOOD_RATE_SAT_PER_ANT 的来源
//   (P2.4f: 上一版拿全程平均标定, 把最该负责的饱和段摊平了, 结果窗口缩水一半——见 METRICS P2.4f §1)。
function micro() {
  const secs = Math.min(SECS, 260);
  for (const [radius, dist] of [[16, 227], [32, 227], [32, 453], [64, 453]]) {
    for (const s of SCHEMA) set(s.key, s.default);
    const world = new World(get('worldW'), get('worldH'), get('gridCell'));
    const field = new Field(get('worldW'), get('worldH'), get('gridCell'));
    const alarm = new Field(get('worldW'), get('worldH'), get('gridCell'));
    const r = rng(hashSeed('micro'));
    const colony = new Colony(get('antCount'), { rng: r, world, nestRadius: get('nestRadius') });
    const a = Math.atan2(0.62, 0.7);
    world.addFood(world.nestX + Math.cos(a) * dist, world.nestY + Math.sin(a) * dist, radius, 1e9);
    let prevAmt = 1e9;
    console.log('\n### micro r=' + radius + ' d=' + dist + ' 单源 · ' + get('antCount') + ' 蚁 · 剂量 1e9(永不枯竭)');
    for (let step = 1; step <= secs * 60; step++) {
      field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
      colony.step(field, world, values, DT, alarm);
      if (step % 60 !== 0) continue;
      const t = step / 60;
      const f = world.foodPatches[0];
      const eaten = f ? prevAmt - f.amount : 0;
      if (f) prevAmt = f.amount;
      if ((t >= 200 && t <= 205) || t === 250) {
        console.log('   t=' + t + 's 吞吐=' + eaten.toFixed(1) + 'u/s 负重=' + colony.loadedCount());
      }
    }
    console.log('   跑完 ' + secs + 's: 卸货 ' + colony.deliveries + ' 弃货 ' + colony.timeouts);
  }
}
if (ARMS.includes('micro')) micro();
