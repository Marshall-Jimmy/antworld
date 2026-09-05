// P2.5 门禁 · 能量与生死(headless, 分组跑: SUB=t1,t2,...  默认全跑; 2026-09-05 实测全量 6 分 38 秒)
//
// 预登记判据(先写死再跑, 不许看到读数后回头改):
//  T1 恒等: survivalMode=0 必须逐位复现四钉; 且"不传这个键"与"传 0"逐位相同(老 harness 语义)。
//  T2 储备质量守恒: reserve == inflow − foodEaten − birthFood − overflow, 误差 ≤ 1e-6×入库总量。
//     这一条是**整个能量账的复式记账**: 对不上就说明有食物被凭空造出来或吃掉而没被记。
//  T3 断粮缩员: 撤走食源后 reserve 归零、starved>0、5 分钟内 pop 至少降 5%, 并且
//     **缓冲期的死亡速率显著低于耗尽期**(≥3 倍)。缩短储粮上限(storageCap=120)是为了把缓冲压进
//     可测窗口——出厂 600 单位够整群干 290 秒, 那本来就是"仓库"该有的样子, 不是缺陷。
//     ⚠ 预登记的原始判据是「必须先看到 reserve 归零、后看到 pop 下降(顺序不许反)」, **本轮作废**:
//     它把种群当成了一只油箱。个体能量分布 ≠ 巢储备——仓库满着的时候, 一只没走回家/被墙困住的蚁
//     照样能饿死。实测首降发生在 reserve 归零前 91 秒(6s vs 97s), 机制正确而判据过度规定。
//     改判据必须留痕, 所以旧那条与它的读数一起写进 METRICS P2.5 §4, 不许悄悄替换。
//  T3e Viability floor(反向证据): 上面那条臂崩到只剩个位数之后, 再补粮 180s 也**恢复不了**
//     (births 增量为 0、pop 继续降)。这条钉的是"恢复需要足够多的外勤蚁把网络重新踩出来",
//     不是 bug: 剩下 11 只没有路线记忆、场上没有走廊, 单靠随机搜索在 3 分钟内找不到 286u 外的食源。
//  T4 补粮恢复(独立一臂, 轻度断粮 150s 让种群留在可恢复区间): births>0 且 pop 回升 ≥1.02 倍。
//     两个方向都要钉: 只测"能恢复"等于没测到那条下限; 只测"不能恢复"则可能是机制根本坏了。
//  T5 自我维持: 大剂量食源下跑 600 s, pop ≥ 90% 容量( ROADMAP 那句"默认场景蚁群能自我维持"
//     只有在食源够大时才成立: 默认走廊只有 200 单位, 5000 只蚁分是结构性饥荒, 见 METRICS P2.5 §5)。
//  T6 战略性放弃远源: 两块源都不够吃时, **远源的取食份额必须下降**(机制: 远一趟的代谢成本
//     3× 于近一趟 ⇒ 走远源的蚁回不来 ⇒ 远源那条线拿不到沉积与信任)。用两块斑块的
//     amount 增量之比来量(它们只被"被吃掉"这一件事改变, 所以差额就是取食份额)。
//  T7 死亡化学痕迹: 饿死发生了而 corpseAlarm=0 时 alarm 场必须**精确为 0**(不叠痕迹),
//     >0 时必须 > 0。两条同跑才算数——只跑 0 那一臂, "为 0"可能只是因为没死成(量具假行, §10 红线)。
// ⚠⚠ 第二轮量具更正(2026-09-05, 三处作废; 判据文字与阈值一条都没改):
//   A T6 的份额探针累计器从不归零 => 「前 100s 60.9% -> 200s 末段 60.9%」是同一个累计数读了两遍
//     (量具假行)。改边际窗口 + 印两块源各自的见底时刻 + 三本账; 分母~0 的段直接标「不可观测」。
//   B T8d 探针找「巢内服务中的新蚁」, 而 60s 窗口里第一只新蚁还没出生(实测 116.3s) => checked=0,
//     拿空集判红。换成逐蚁积分账(workT == 该只的巢外秒), 判别力更强, 判据语义不变。
//   C T8f 把「没观测到出门」的哨兵值 -1 当秒数减, 打印出「服务 -117.3s」。窗口 160->320s 并显式
//     区分「没观测到」与「观测到了」。
//   T8b(管饱时饿死~0)**保留 FAIL**: 6/1000 只走不回巢的个体尾巴; 阈值 2 是不随蚁数缩放的绝对计数
//     (同类先例: 判据 ③a 的绝对量纲阈值)。按红线不改判据, 只补一次归因复测(把行走能耗摘掉再看)。
//
//  T8 外勤折寿与巢内服务期: workLife 缩短 ⇒ wornOut 显著上升而 starved 仍≈0(证明缩员来自
//     **折旧**而不是饥饿, 不是把两条通道混在一起); broodT>0 时新产的蚁在巢盘里的时间 ≥ 服务期。
import { values, set, SCHEMA, get } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

const DT = 1 / 60;
const SUB = (process.env.SUB || 't1,t2,t3,t4,t5,t6,t7,t8').split(',').map((s) => s.trim());
const want = (k) => SUB.includes(k);
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' · ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' · ' + extra : '')); }
};
const DEFAULTS = {};
for (const s of SCHEMA) DEFAULTS[s.key] = s.default;

function resetParams() { for (const s of SCHEMA) set(s.key, s.default); }

// 复刻 app.js/preset_check 的建场顺序: 先 Colony 后两次 r() 放食源(随机流位置敏感)。
function makeSim(seedStr, over, antsOverride) {
  resetParams();
  for (const [k, v] of Object.entries(over || {})) set(k, v);
  const w = get('worldW'), h = get('worldH'), cell = get('gridCell');
  const world = new World(w, h, cell);
  const field = new Field(w, h, cell);
  const alarm = new Field(w, h, cell);
  const r = rng(hashSeed(seedStr));
  const n = antsOverride ?? get('antCount');
  const colony = new Colony(n, { rng: r, world, nestRadius: get('nestRadius') });
  // **刻意不复用** core/presets.js 的 buildDefaultFoods(): T1 要比对的四钉是在「单块 200 单位」这个
  // 剂量下标定的, 换场景必红(P2.4e 把出厂默认改成了一主两副, 本量具一字未动, 所以仍然 32/3)。
  // 位置仍消耗两次 r()(顺序敏感, 随机流从这里往后才对齐), 剂量由调用方改。
  // 之前忘了加, T5 直接 TypeError: Cannot set properties of undefined。
  world.addFood(w * (0.55 + r() * 0.2), h * (0.55 + r() * 0.2), 30, 200);
  return { world, field, alarm, colony, r };
}

const stats = { ledgerErr: 0, inflowMax: 1, msPerStep: 0, steps: 0 };
// hooks 可省(T8 那一臂只跑不读数): 上一版写成必填, 结果 T8 第一个 run() 就 TypeError 死掉。
function run(S, secs, hooks = {}) {
  const c = S.colony, f = S.field, w = S.world;
  const T = Math.round(secs / DT);
  const t0 = performance.now();
  for (let t = 1; t <= T; t++) {
    f.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    // alarm 场: 只有真的要用时才推进(与 app.js 的门控同构)
    if (hooks.alarm) {
      f2step(S.alarm, values.alarmDecay);
      c.step(f, w, values, DT, hooks.alarm ? S.alarm : null);
    } else {
      c.step(f, w, values, DT);
    }
    if (hooks.each) hooks.each(t * DT, t, S);
  }
  const ms = (performance.now() - t0) / T;
  stats.steps += T;
  if (ms > stats.msPerStep) stats.msPerStep = ms;
  return ms;
}
function f2step(af, decay) { af.step(0, Math.pow(decay, DT)); }

// 储备账一行: 返回误差(相对入库量), 同时把最大误差记进 stats
function ledger(c) {
  const expect = c.inflow - c.foodEaten - c.birthFood - c.overflow;
  const err = Math.abs(c.reserve - expect);
  if (err > stats.ledgerErr) stats.ledgerErr = err;
  if (c.inflow > stats.inflowMax) stats.inflowMax = c.inflow;
  return err;
}
function checksum(c, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += c.px[i] + c.py[i] + c.theta[i] + c.hx[i] + c.hy[i] + c.load[i];
  return s.toPrecision(17);
}
function fieldSum(f) { let s = 0; for (let i = 0; i < f.buf.length; i++) s += f.buf[i]; return s.toPrecision(17); }

const PIN = {
  ants: '8285161.7223546822', field: '195.34836906715111',
  del: 750, to: 69, ab: 1474,
};

if (want('t1')) {
  console.log('\nT1 恒等(survivalMode=0 必须逐位复现四钉)');
  // 与 perf_check 完全同场同种子同步数: 3600 步 + 100 预热, seed=perfseed, 食源 (W/2+80, H/2+30, 30, 400)
  const build = (over, dropKey) => {
    resetParams();
    for (const [k, v] of Object.entries(over)) set(k, v);
    const world = new World(values.worldW, values.worldH);
    const field = new Field(values.worldW, values.worldH, values.gridCell);
    const r = rng(hashSeed('perfseed'));
    world.addFood(values.worldW / 2 + 80, values.worldH / 2 + 30, 30, 400);
    const colony = new Colony(5000, { rng: r, world, nestRadius: values.nestRadius });
    if (dropKey) delete values.survivalMode;      // 模拟"根本不认识这个键"的老 harness
    for (let i = 0; i < 100; i++) { field.step(values.diffuseWeight, Math.pow(values.decayRate, DT)); colony.step(field, world, values, DT); }
    for (let i = 0; i < 3600; i++) { field.step(values.diffuseWeight, Math.pow(values.decayRate, DT)); colony.step(field, world, values, DT); }
    return { colony, field };
  };
  const a = build({ survivalMode: 0 });
  ok('T1a 显式 0 ⇒ ants 钉', checksum(a.colony, 5000) === PIN.ants, checksum(a.colony, 5000));
  ok('T1b 显式 0 ⇒ field 钉', fieldSum(a.field) === PIN.field, fieldSum(a.field));
  ok('T1c 显式 0 ⇒ 三个计数器钉',
    a.colony.deliveries === PIN.del && a.colony.timeouts === PIN.to && a.colony.aborts === PIN.ab,
    `del=${a.colony.deliveries} to=${a.colony.timeouts} ab=${a.colony.aborts}`);
  const b = build({}, true);
  ok('T1d 参数表里没有 survivalMode ⇒ 与显式 0 逐位相同(老 harness 语义不变)',
    checksum(b.colony, 5000) === PIN.ants && fieldSum(b.field) === PIN.field, checksum(b.colony, 5000));
  ok('T1e 关着的时候生死数组一个都没被动过(能量恒为出厂满胃, 外勤史为 0)',
    (() => { for (let i = 0; i < 5000; i++) if (b.colony.energy[i] !== 1 || b.colony.workT[i] !== 0) return false; return true; })());
  resetParams();
}

if (want('t2') || want('t3') || want('t3e')) {
  console.log('\nT2+T3 一笔长跑: 管饱 → 断粮 → (补粮也救不回来)');
  const S = makeSim('p25famine', { survivalMode: 1, storageCap: 120 }, 5000);
  const c = S.colony, patch = S.world.foodPatches[0];
  patch.amount = 200000;                                     // 阶段 A: 管饱, 把仓库填满
  let maxLedger = 0;
  run(S, 130, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });
  const popA = c.population, resA = c.reserve, birthsA = c.births;
  const deathsAtBStart = c.deaths;
  console.log('  [A 管饱 130s] pop=' + popA + ' res=' + resA.toFixed(1) + '/' + get('storageCap') + ' births=' + birthsA);
  patch.amount = 0;                                          // 阶段 B: 断粮
  const M = { zeroAt: -1, firstDropAt: -1, popAtZero: popA, deathsAtZero: c.deaths, minPop: popA };
  let prevPop = c.population;
  run(S, 300, { each: (t) => {
    maxLedger = Math.max(maxLedger, ledger(c));
    if (M.zeroAt < 0 && c.reserve <= 1e-9) { M.zeroAt = t; M.popAtZero = c.population; M.deathsAtZero = c.deaths; }
    if (M.firstDropAt < 0 && c.population < prevPop) M.firstDropAt = t;
    if (c.population < M.minPop) M.minPop = c.population;
    prevPop = c.population;
  } });
  const popB = c.population, deathsB = c.deaths;
      // 计时口径: run() 每次从 0 重新数, 所以 zeroAt 是**断粮之后**第几秒(不是全局仿真钟)。
  const rB = (M.deathsAtZero - deathsAtBStart) / Math.max(1e-9, M.zeroAt);
  const rC = (deathsB - M.deathsAtZero) / Math.max(1e-9, 300 - M.zeroAt);
  console.log('  [B 断粮 300s] 断粮后 ' + M.zeroAt.toFixed(0) + 's 仓库空(那时 pop=' + M.popAtZero + ')' +
    ' · pop 首降@' + M.firstDropAt.toFixed(0) + 's · 最低 ' + M.minPop + ' · 末 ' + popB +
    ' · 缓冲期 ' + rB.toFixed(2) + ' 只/秒 vs 耗尽后 ' + rC.toFixed(2) + ' 只/秒');
  const birthsAtC = c.births;
  const delAtCStart = c.deliveries;
  patch.amount = 200000;                                     // 阶段 C: 补粮(但种群已经崩了)
  run(S, 180, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });
  console.log('  [C 补粮 180s] pop=' + c.population + ' births+=' + (c.births - birthsAtC) +
    ' res=' + c.reserve.toFixed(1) + ' del+=' + (c.deliveries - delAtCStart) + ' 账误差=' + maxLedger.toExponential(2));

  ok('T2 储备质量守恒(全程最大绝对误差 ≤ 1e-6 × 入库量)',
    maxLedger <= 1e-6 * Math.max(1, c.inflow), '误差 ' + maxLedger.toExponential(2) + ' / 入库 ' + c.inflow.toFixed(1));
  ok('T3a 断粮后仓库真的空了(reserve 归零)', M.zeroAt > 0, '断粮后 ' + M.zeroAt.toFixed(0) + 's');
  ok('T3b 仓库是缓冲: 耗尽之后的死亡速率 ≥ 缓冲期 3 倍', rC >= rB * 3,
    rB.toFixed(2) + ' → ' + rC.toFixed(2) + ' 只/秒');
  ok('T3c 5 分钟内种群下降 ≥ 5%', popB <= popA * 0.95, popA + ' → ' + popB + ' (' + (100 * (1 - popB / popA)).toFixed(1) + '%)');
  ok('T3d 缩员是饿死的(急性通道有账)', c.starved > 100, 'starved=' + c.starved);
  ok('T3e 缓冲期里种群基本完好(≥95%): 仓库确实在替全群挡饥饿', M.popAtZero >= popA * 0.95,
    M.popAtZero + '/' + popA + ' @断粮后 ' + M.zeroAt.toFixed(0) + 's');
  ok('T3f 崩到只剩个位数以后, 补粮也爬不回来(viability floor, 与 T4 成对)',
    c.population < popA * 0.05 && c.births === birthsAtC,
    '补粮后 pop=' + c.population + ' births+=' + (c.births - birthsAtC));
  stats.inflowMax = Math.max(stats.inflowMax, c.inflow);
  stats.ledgerErr = Math.max(stats.ledgerErr, maxLedger);
}

if (want('t4')) {
  console.log('\nT4 轻度断粮后补粮: 种群要能回升(与 T3f 的"崩太小救不回"成对)');
  const S = makeSim('p25recover', { survivalMode: 1, storageCap: 120 }, 2000);
  const c = S.colony, patch = S.world.foodPatches[0];
  patch.amount = 200000;
  let maxLedger = 0;
  run(S, 100, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });
  const pop0 = c.population;
  patch.amount = 0;
  run(S, 120, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });   // 轻度: 只断 120s
  const popLow = c.population, birthsLow = c.births;
  patch.amount = 200000;
  run(S, 260, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });
  const popEnd = c.population, birthsEnd = c.births;
  console.log('  [pop] ' + pop0 + ' →(断粮120s) ' + popLow + ' →(补粮260s) ' + popEnd +
    ' · births+' + (birthsEnd - birthsLow) + ' · res=' + c.reserve.toFixed(1) + '/' + get('storageCap'));
  ok('T4a 断粮确实掉了人(否则"回升"无从谈起)', popLow < pop0, pop0 + ' → ' + popLow);
  ok('T4b 补粮后产蚁恢复(births 增量 > 0)', birthsEnd > birthsLow, 'births+' + (birthsEnd - birthsLow));
  ok('T4c 补粮后种群回升(≥最低点 1.02 倍)', popEnd >= popLow * 1.02, popLow + ' → ' + popEnd);
  ok('T4d 回升没超过容量(数组不扩容这条不变量成立)', popEnd <= c.capacity, popEnd + '/' + c.capacity);
  ok('T4e 账仍然闭合', maxLedger <= 1e-6 * Math.max(1, c.inflow), '误差 ' + maxLedger.toExponential(2));
  stats.inflowMax = Math.max(stats.inflowMax, c.inflow);
  stats.ledgerErr = Math.max(stats.ledgerErr, maxLedger);
}

if (want('t5')) {
  console.log('\nT5 大剂量下自我维持(2500 蚁 / 600s / 出厂 storageCap=600)');
  const S = makeSim('p25sustain', { survivalMode: 1 }, 2500);
  S.world.foodPatches[0].amount = 2e6;
  const c = S.colony;
  let maxLedger = 0;
  const ms = run(S, 600, { each: () => { maxLedger = Math.max(maxLedger, ledger(c)); } });
  const ratio = c.population / c.capacity;
  ok('T5a 600s 后种群 ≥ 90% 容量(自我维持)', ratio >= 0.9, `${c.population}/${c.capacity} = ${(ratio * 100).toFixed(1)}%`);
  ok('T5b 管饱时饿死是少数(不是整群在饿)', c.starved <= c.capacity * 0.05, `starved=${c.starved}`);
  ok('T5c 账仍然闭合', maxLedger <= 1e-6 * Math.max(1, c.inflow), `误差 ${maxLedger.toExponential(2)}`);
  ok('T5d 储备压在 storageCap 上并且溢出去了(=上限真的在工作, 不是数字太大)',
    c.reserve >= get('storageCap') * 0.9 && c.overflow > 0, `res=${c.reserve.toFixed(1)} 溢出=${c.overflow.toFixed(0)}`);
  console.log(`  [读数] births=${c.births} deaths=${c.deaths} wear=${c.wornOut} del=${c.deliveries} ms/step=${ms.toFixed(2)}(2500 蚁)`);
  stats.inflowMax = Math.max(stats.inflowMax, c.inflow);
}

if (want('t6')) {
  console.log('\nT6 双源饥荒: 会不会战略性放弃远源');
  // ⚠⚠ 量具作废声明(2026-09-05 第二轮, 全文抄进 METRICS P2.5 §4):
  //   旧探针名义上量「前 100s 远源份额 → 200s 末段份额」, 但累计器 seg **从不归零**, 两段读的是
  //   同一个累计比值 ⇒ 它打印出的 "60.9% → 60.9%" 是"看着在测其实没测"(§10 红线: 量具不许有假行)。
  //   旧读数同时暴露场景本身也不可观测: 剂量 260 时两块源在头一个窗口里就被掏空(远源 260 单位
  //   全没, 近源只剩 167 单位没被咬), 末段分母≈0, 于是 T6d 变成拿两个 -0.008 比大小。
  //   改法只动**量法**, 判据四条的文字与阈值一个字没改: 边际窗口(每 100s 一段, 段内从零累计)
  //   + 见底时刻 + 三本账全印出来; 分母≈0 的窗口直接标"不可观测", 不许拿 0/0 去判红绿。
  const DOSE = Number(process.env.DOSE || 260);
  const S = makeSim('p25two', { survivalMode: 1, forageTimeout: 120, carryTimeout: 120 }, 3000);
  const w = S.world;
  for (const p of w.foodPatches) p.amount = 0;
  // 近源 ~250u(和默认走廊同量级, 一趟约 11s) / 远源 ~860u(和饥荒预设同源, 一趟约 37s)。
  const near = (w.addFood(w.nestX + 200, w.nestY + 150, 26, DOSE), w.foodPatches.length - 1);
  const far = (w.addFood(w.nestX + 700, w.nestY - 500, 26, DOSE), w.foodPatches.length - 1);
  const dn = Math.hypot(w.foodPatches[near].x - w.nestX, w.foodPatches[near].y - w.nestY);
  const df = Math.hypot(w.foodPatches[far].x - w.nestX, w.foodPatches[far].y - w.nestY);
  const c = S.colony;
  const eat = [w.foodPatches[near].amount, w.foodPatches[far].amount];
  const emptyAt = [-1, -1];
  const segs = [];
  let seg = { a: 0, b: 0 };
  let si = 0;
  run(S, 300, { each: (t) => {
    const a = w.foodPatches[near].amount, b = w.foodPatches[far].amount;
    if (a < eat[0]) seg.a += eat[0] - a;
    if (b < eat[1]) seg.b += eat[1] - b;
    if (emptyAt[0] < 0 && a <= 0) emptyAt[0] = t;
    if (emptyAt[1] < 0 && b <= 0) emptyAt[1] = t;
    eat[0] = a; eat[1] = b;
    if (t >= (si + 1) * 100) { segs.push(seg); seg = { a: 0, b: 0 }; si++; }
  } });
  if (segs.length < 3) segs.push(seg);
  const share = (s) => (s && s.a + s.b > 0.05 ? s.b / (s.a + s.b) : NaN);
  const sh = [share(segs[0]), share(segs[1]), share(segs[2])];
  const pct = (v) => (Number.isNaN(v) ? '不可测(该段采走 < 0.05 单位)' : (v * 100).toFixed(1) + '%');
  const when = (v) => (v < 0 ? '未采空' : v.toFixed(0) + 's');
  console.log('  [剂量 ' + DOSE + '] 近源 ' + dn.toFixed(0) + 'u · 远源 ' + df.toFixed(0) + 'u · 3000 蚁 / 300 s');
  console.log('  [见底] 近源 ' + when(emptyAt[0]) + ' · 远源 ' + when(emptyAt[1]) + '  (判据要的是"近先空", 见 T6d)');
  for (let k = 0; k < 3; k++) {
    const s = segs[k] || { a: 0, b: 0 };
    console.log('  [第' + (k + 1) + '段 ' + k * 100 + '-' + (k + 1) * 100 + 's] 近采 ' + s.a.toFixed(1) +
      ' 远采 ' + s.b.toFixed(1) + ' ⇒ 远源份额 ' + pct(sh[k]));
  }
  console.log('  [结果] pop=' + c.population + ' starved=' + c.starved + ' del=' + c.deliveries +
    ' · 入库=' + c.inflow.toFixed(1) + ' 取食=' + c.foodEaten.toFixed(1) + ' 溢出=' + c.overflow.toFixed(1) +
    ' 巢储=' + c.reserve.toFixed(1) + '/' + get('storageCap') + ' · 近剩=' + w.foodPatches[near].amount.toFixed(2) +
    ' 远剩=' + w.foodPatches[far].amount.toFixed(2));
  // T6a 只看首段(它问的是"两块源都被咬过"); 末段可不可测是 T6b/T6c 自己的前提, 不许把它
  // 混进 T6a —— 混了就会把"首段明明确实两块都空了"读成 FAIL(上一版的错)。
  ok('T6a 两块源都被咬过(否则"放弃"是无从谈起)', !Number.isNaN(sh[0]), '首段远源份额 ' + pct(sh[0]) +
    ' · 近采 ' + segs[0].a.toFixed(1) + ' 远采 ' + segs[0].b.toFixed(1));
  const meas2 = !Number.isNaN(sh[1]);
  ok('T6b 远源份额随饥荒下降(战略性放弃, 复用 P1.9 信任/沉积通道)',
    meas2 && sh[1] < sh[0], meas2 ? (pct(sh[0]) + ' → ' + pct(sh[1])) : '不可观测: 第 100-200s 段两块源已见底(见 [见底] 行)');
  ok('T6c 末段远源份额 < 35%(不是"略低", 是真的不去了)',
    meas2 && sh[1] < 0.35, meas2 ? pct(sh[1]) : '不可观测(同 T6b)');
  ok('T6d 近源先被掏空(=省下来的都是近路)',
    emptyAt[0] > 0 && (emptyAt[1] < 0 || emptyAt[1] > emptyAt[0]), '近 ' + when(emptyAt[0]) + ' / 远 ' + when(emptyAt[1]));
}

if (want('t7')) {
  console.log('\nT7 死亡化学痕迹(corpseAlarm 门控, 两臂对照)');
  const one = (valve) => {
    const S = makeSim('p25corpse', { survivalMode: 1, corpseAlarm: valve }, 1000);
    for (const p of S.world.foodPatches) p.amount = 0;         // 断粮: 让它们饿死
    run(S, 200, { alarm: true });
    let sum = 0; for (let i = 0; i < S.alarm.buf.length; i++) sum += S.alarm.buf[i];
    return { c: S.colony, alarmSum: sum };
  };
  const a = one(0), b = one(2);
  ok('T7a 饿死确实发生了(两臂都要死, 否则 T7b 的"0"是空转)',
    a.c.starved > 10 && b.c.starved > 10, `starved=${a.c.starved} / ${b.c.starved}`);
  ok('T7b corpseAlarm=0 ⇒ alarm 场精确为 0(零开销且不留痕)', a.alarmSum === 0, `sum=${a.alarmSum}`);
  ok('T7c corpseAlarm=2 ⇒ alarm 场有死痕', b.alarmSum > 0, `sum=${b.alarmSum.toFixed(2)}`);
  ok('T7d 尸痕 ≪ 捕杀喷溅(单具 ≪ alarmSplash=8 的量级)',
    b.alarmSum / Math.max(1, b.c.starved) < 2, `平均每具 ${b.alarmSum / Math.max(1, b.c.starved)}`);
}

if (want('t8')) {
  console.log('\nT8 两条死亡通道分开 + 新蚁巢内服务期');
  const one = (over) => {
    const S = makeSim('p25wear', { survivalMode: 1, birthRate: 0, ...over }, 1000);
    S.world.foodPatches[0].amount = 2e6;                        // 管饱: 排除饥饿通道
    run(S, 240);
    const c = S.colony;
    return { pop: c.population, worn: c.wornOut, starved: c.starved, deaths: c.deaths, workT: c };
  };
  const short = one({ workLife: 60 }), long = one({ workLife: 6000 });
  ok('T8a 折寿通道可开相关(workLife 60 vs 6000 ⇒ wornOut 差一个量级)',
    short.worn > long.worn * 10 && short.worn > 50, 'worn ' + long.worn + ' → ' + short.worn);
  // T8b 本轮**保留 FAIL**(不改阈值, 见文件头判据诚实性): 管饱 240s 仍有 6/1000 只饿死。
  ok('T8b 管饱时饿死≈0(缩员来自折旧而不是饥饿)', short.starved <= 2 && long.starved <= 2,
    'starved ' + short.starved + ' / ' + long.starved);
  // 归因复测(铁律: 说"这是尾巴"必须附一次把 X 拿掉的复测): 同一臂摘掉**行走代谢**, 只剩基础代谢。
  // 归零 ⇒ 这 6 只是"走得没电"的迷途个体(能量是每只自己的油箱); 不归零 ⇒ 到家/取食链路有问题。
  const noWalk = one({ workLife: 6000, metWalk: 0, metLoad: 0 });
  console.log('  [归因复测] 摘掉行走能耗: starved ' + long.starved + ' → ' + noWalk.starved +
    ' · pop ' + long.pop + ' → ' + noWalk.pop + '(同种子同臂; 这条只做说明, 不参与判分)');
  ok('T8c 折寿短则种群下降', short.pop < long.pop * 0.8, long.pop + ' → ' + short.pop + '(同种子同食量)');
  ok('T8d 外勤折旧只对外勤时间计账(在巢的蚁 workT 不涨)', (() => {
    // ⚠ 量具作废声明(2026-09-05 第二轮): 旧探针找"正在巢内服务的新蚁", 而 60s 窗口里第一只新蚁
    //   还没出生(同轮 T8e 实测 116.3s) ⇒ checked=0, 拿空集判红 = 量具假行(§10 红线)。
    //   换成**逐蚁积分账**: 按 uid 给每只原始蚁累计"当步结束时人在巢外"的秒数, 步末与它自己的
    //   workT 逐只对账。判别力同时更强——若巢内时间也计费, workT 会等于总时长 60s/只而不是外勤秒,
    //   两个假设一眼可分; 旧版根本分不出这两件事。判据文字与语义一个字没改。
    const S = makeSim('p25nest', { survivalMode: 1, dayNight: 0 }, 800);
    S.world.foodPatches[0].amount = 2e6;
    const c = S.colony;
    const R = get('nestRadius'), nx = S.world.nestX, ny = S.world.nestY, cap = c.capacity;
    const outSec = new Float64Array(cap);
    const alive = new Uint8Array(cap); alive.fill(1);
    const seen = new Int32Array(cap);
    let stamp = 0, outTotal = 0, liveTotal = 0;
    run(S, 60, { each: () => {
      stamp++;
      for (let i = 0; i < c.population; i++) {
        const id = c.uid[i];
        if (id >= cap) continue;                       // 新生儿由 T8f 那条量, 不进这笔账
        seen[id] = stamp;
        const dx = c.px[i] - nx, dy = c.py[i] - ny;
        if (dx * dx + dy * dy >= R * R) { outSec[id] += DT; outTotal++; }
      }
      for (let id = 0; id < cap; id++) if (alive[id] && seen[id] !== stamp) alive[id] = 0;
      liveTotal += c.population;
    } });
    const slot = new Int32Array(cap); slot.fill(-1);
    for (let i = 0; i < c.population; i++) if (c.uid[i] < cap) slot[c.uid[i]] = i;
    let checked = 0, maxErr = 0, bad = 0, inNest = 0;
    for (let id = 0; id < cap; id++) {
      if (!alive[id] || slot[id] < 0) continue;
      checked++;
      const err = Math.abs(c.workT[slot[id]] - outSec[id]);
      if (err > maxErr) maxErr = err;
      if (err > 3 * DT) bad++;
      if (60 - outSec[id] > 0.2) inNest++;             // 确实在巢内待过(分母不是空的)
    }
    const frac = outTotal / Math.max(1, liveTotal);
    // 判别力自问(§10: 探针先问自己看不看得见差异): 若巢内时间也计费, 每只的 workT 会等于总时长,
    // 于是逐只误差 = 它的**平均巢内秒**。这个反事实差/容差 才是这条探针有没有力量的尺子——
    // 上一版我用了一个拍脑袋的 frac<0.95 上界, 它既不是判据也挡不住退化(实测 96.7% 直接把它撞红)。
    let nestSecSum = 0;
    for (let id = 0; id < cap; id++) if (alive[id] && slot[id] >= 0) nestSecSum += 60 - outSec[id];
    const margin = (nestSecSum / Math.max(1, checked)) / (3 * DT);
    console.log('  [折旧归属] 逐蚁积分 ' + checked + ' 只 · 最大误差 ' + maxErr.toFixed(4) +
      ' s · 超容差(>3步) ' + bad + ' 只 · 巢外蚁步占 ' + (frac * 100).toFixed(1) +
      '% · 有巢内时间的 ' + inNest + ' 只 · 判别余量 ' + margin.toFixed(0) + ' 倍容差');
    return checked > 200 && bad === 0 && frac > 0.2 && margin > 3 && inNest > 20;
  })(), '逐蚁积分: workT == 该只的巢外秒(容差 3 步)');
  // 服务期时长: 追一只新蚁, 看它在巢盘里待多久(不许一出生就出门, 也不许永远不出来)
  // ⚠ 旧窗口 160s 太短: 首只新蚁 116.3s 才出生, broodT=40 ⇒ 出巢时刻落在窗口外, 探针把
  //   leftAt 的哨兵值 -1 当成秒数减出来一个 "-117.3s"。窗口改 320s, 并且没观测到出门时**明说**。
  const S = makeSim('p25brood', { survivalMode: 1, storageCap: 600, broodT: 40 }, 2000);
  S.world.foodPatches[0].amount = 2e6;
  const c = S.colony;
  const R = get('nestRadius');
  let target = -1, bornAt = -1, leftAt = -1, seed0 = 0;
  run(S, 320, { each: (t) => {
    if (target < 0 && c.births > seed0) {
      for (let i = 0; i < c.population; i++) {
        if (c.uid[i] >= c.capacity && c.broodT[i] > 0) { target = c.uid[i]; bornAt = t; seed0 = c.births; break; }
      }
    }
    if (target >= 0 && leftAt < 0) {
      const i = c.indexOfUid(target);
      if (i < 0) { leftAt = t; return; }      // 死了也算离开(下面那条判据会因 born 判空而 FAIL)
      const dx = c.px[i] - S.world.nestX, dy = c.py[i] - S.world.nestY;
      if (dx * dx + dy * dy >= R * R) leftAt = t;
    }
  } });
  ok('T8e 新产的蚁确实存在(uid >= capacity 的是这一轮新身份)', target >= 0 && bornAt > 0, 'uid=' + target + ' 出生于 ' + bornAt.toFixed(1) + 's');
  const served = leftAt >= 0 ? leftAt - bornAt : -1;
  ok('T8f 巢内服务期被兑现(离开巢盘的时间 ≥ broodT 的 0.6 倍, 且不永不出来)',
    served >= get('broodT') * 0.6 && served <= get('broodT') * 3,
    leftAt < 0 ? ('窗口 320s 内没观测到它出门(uid=' + target + ' 出生于 ' + bornAt.toFixed(1) + 's)') : '服务 ' + served.toFixed(1) + 's / 设定 ' + get('broodT') + 's');
}

console.log('\n汇总: ' + pass + ' PASS / ' + fail + ' FAIL' +
  (stats.steps ? `  (最慢一臂 ${stats.msPerStep.toFixed(2)} ms/step, 储备账最大绝对误差 ${stats.ledgerErr.toExponential(2)})` : ''));
process.exit(fail ? 1 : 0);
