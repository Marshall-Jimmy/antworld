// 诊断台 wipe_diag（P2.4 ③ 段的破案现场，留档可重跑：node wipe_diag.mjs，约 7 分钟）
// 问题: 上一版 ③ 在"第二黎明人工抹场"后读出 6720× 和总账 1.443× —— 这真是记忆的红利吗?
// 假设(当时): 基线组抹场后 240s 重建不出走廊, 是因为 P1.9 的 misses 把 trust 压到 0.1 封底,
//   没走廊就吃不到食物 → 循环复位 misses=3 → 新生走廊被 10 倍弱化 → 滞锁(死锁)。
// 三个变体只差"清零时对 misses 做什么": V0 不抹场(对照), V1 抹场, V2 抹场+同时把 misses 归零。
// 结论(三条都推翻了自己):
//   ① 不需要人工干预: 白天走廊峰 ~59, 每个黎明只剩 ~1.2(夜削按比值判: 三种子汇总 98~115×, 单次读数 32~156×) —— **夜本身就是那把刀**;
//      但黎明后 20~30s 群体就从零踩回走廊(峰 0.6→47), V1 抹的那一下只抹掉残值 1.2, 等于没抹。
//   ② 滞锁假设不成立: V2 与 V1 曲线同形(60s 内重建, 第三天 209~259/s) → 没有 bug, 不改 P1.9。
//   ③ 6720× 的真凶是**指数上升沿上的相位差**: 抹场让第三天早晨的陡坡整体推迟约 25s,
//      同一个 40s 窗口从 164/s 读成 0/s。判据必须落在整段积分上(见 METRICS 教训 20/21)。
// 作废数字: 6720× / 1.443× 两版 ③ 的一切"黎明红利"主张 —— 已正式作废, 不要再引用。
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';
const DEF = { ...values };
const DT = 1 / 60;
function makeSim(seed) {
  for (const k in DEF) values[k] = DEF[k];
  values.K_mem = 0; values.dayNight = 1; values.dayLength = 240;
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 1e9);
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(seed)), world, nestRadius: values.nestRadius });
  return { world, field, colony, weather: new Weather(seed) };
}
function peak(S) { let m = 0; for (let i = 0; i < S.field.buf.length; i++) if (S.field.buf[i] > m) m = S.field.buf[i]; return m; }
function meanMisses(S) { let s = 0; for (let i = 0; i < S.colony.count; i++) s += S.colony.misses[i]; return s / S.colony.count; }
function outLoaded(S) { let n = 0; for (let i = 0; i < S.colony.count; i++) if (S.colony.load[i] > 0) n++; return n; }
for (const V of ['V0', 'V1', 'V2']) {
  const S = makeSim('night');
  const total = Math.round(720 / DT);
  let prevDel = 0, prevAb = 0, line = [];
  for (let st = 0; st <= total; st++) {
    const t = st * DT;
    if (V !== 'V0' && Math.abs(t - 420) < DT * 0.5) {
      S.field.clear();
      if (V === 'V2') { for (let i = 0; i < S.colony.count; i++) { S.colony.misses[i] = 0; S.colony.forageT[i] = 0; } }
    }
    const env = weatherActive(values) ? S.weather.step(DT, values) : null;
    S.field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * (env ? env.wash : 1)), null);
    S.colony.step(S.field, S.world, values, DT, null, env);
    if (st % Math.round(40 / DT) === 0 && st > 0) {
      const d = S.colony.deliveries, ab = S.colony.aborts;
      line.push(t.toFixed(0) + ': ' + ((d - prevDel) / 40).toFixed(0) + '/s 峰' + peak(S).toFixed(1) + ' miss' + meanMisses(S).toFixed(2) + ' 负重' + outLoaded(S));
      prevDel = d; prevAb = ab;
    }
  }
  console.log('[' + V + '] 总卸货 ' + S.colony.deliveries + ' 弃航 ' + S.colony.aborts);
  for (let i = 0; i < line.length; i += 3) console.log('   ' + line.slice(i, i + 3).join(' | '));
}