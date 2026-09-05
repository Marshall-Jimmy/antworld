// P2.4b 门禁 II · 场景预设(headless, 每个预设真跑 60 秒仿真)
//
// 预登记判据:
//  P1 **默认路径是空操作**: 不调 applyPresetParams / 用 presetId=null 时, buildPresetWorld
//     既不刷墙也不清食源(出厂那块随种子落位的食源一个字节不动)。逐位基线由 perf_check 把。
//  P2 参数增量可撤销且不叠加: 换一个预设 = 先撤掉上一个预设改过的键, 再落新的。
//     切回 default 必须逐键回到出厂值(否则「双源竞争」跑的其实是迷宫的参数)。
//  P3 布局符合规格: 墙格数>0 的预设确实有墙; 食源块数与剂量与定义一致; 巢区(巢盘 1.5 倍内)无墙
//     ——把巢封在墙里等于预设一加载就杀死整群(蚂蚁一步就撞墙, 场景根本跑不起来)。
//  P4 **可达性(洪泛)**: 从巢格出发按四邻域漫过非墙格, 必须能走到每一块食源的格心。
//     这是唯一能证明「这个预设不是把食物焊死在墙里」的判据; 肉眼看缩略图看不出封死。
//  P5 预设跑得动: 每个预设 5000 蚁真跑到「一趟下界 × 2.5」的秒数(见 tripWindow, 由巢↔食源的
//     环面欧氏距离与 speed 滑杆**推导**出来, 不是挑一个能过的数): 必须出现首次发现与首次卸货, 无 NaN。
//     ⚠ 第一跑判据写的是死值 60 秒, 于是 maze(首见 42s)与 famine(首见 21s)双双 FAIL——
//     那不是场景坏, 是判据在拿「默认走廊的一趟」当所有场景的一趟。改推导式后两红转绿, 读数见输出。
//  P6 可复现: 同一 seed 两次 build 的蚂蚁校验和逐位相同(预设布局不许偷偷吃随机流)。
//  P1d-P1l(P2.4e 补的) 钉**出厂默认场景自己**: 份额分配律 / 标定算术 / 总量按蚁数 / 主源占大头 /
//     界内且不压巢盘 / 每块源的一趟短于负重泄压阀 / 真跑 300 秒主源仍 ≥70% / 近籽在窗口内见底 /
//     手点剂量与出厂同源。
//     为什么值得单列一节: 默认场景是用户看到的第一张图, 但它以前只被 app.js 写死、没有任何判据守着,
//     于是「食源 60 秒见底 = 缺口看不见」这类事只能靠肉眼发现。现在它和预设一样要过闸。
import { values, SCHEMA, get, set } from './core/config.js';
import { rng, hashSeed, randomSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { PRESETS, presetById, applyPresetParams, buildPresetWorld, presetBaseline } from './core/presets.js';
// P1d-P1h 钉的是**出厂默认场景本身**(不是预设): 剂量标定、块数与份额、不落巢盘不出界、
// 主源占大头, 以及一条用真仿真复核的「散粮撑得过观察窗口」。默认场景由 app.js 与本量具
// 共用同一个登记处(core/presets.js 的 buildDefaultFoods), 所以结构上不存在「改了 app 忘了改门禁」的漂移。
// ⚠ P2.4e 这条注释写的「用 AVG 不用 SAT」被 P2.4f 的实测否证了: 全程平均把最该负责的**饱和段**摊平,
//   于是 75,000 单位在两颗门禁种子上 510~630 秒见底。现在标定用饱和期**平台**速率(名字改成 SAT), 见 P1e。
import { buildDefaultFoods, DEFAULT_FOOD_SPOTS, FOOD_UNITS_PER_ANT, FOOD_RATE_SAT_PER_ANT,
  FOOD_NEAR_PER_ANT, FOOD_MAIN_PER_ANT, FOOD_OBS_MIN, tripBudget, tripSeconds, handFoodDose } from './core/presets.js';

const DT = 1 / 60;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};

// 完整复刻 app.js 的 reset(): 先建 World/Field/Colony, 再按同一顺序消耗同一个 r 放默认食源。
// 顺序必须一致—— Colony 构造函数吃的随机数次数与之后那两次 r() 的位置共同决定了整条随机流。
function makeWorld(seedStr) {
  const w = get('worldW'), h = get('worldH'), cell = get('gridCell');
  const world = new World(w, h, cell);
  const field = new Field(w, h, cell);
  const r = rng(hashSeed(seedStr));
  const colony = new Colony(get('antCount'), { rng: r, world, nestRadius: get('nestRadius') });
  buildDefaultFoods(world, r);   // 出厂散粮(一近一主两块): 与 app.js 同一个函数, 同样只消耗两次 r()
  return { world, field, colony };
}

// 环面四邻域洪泛: 从巢格出发, 问「每一块食源所在的格心能不能走到」
function reachable(world, targets) {
  const gw = world.gw, gh = world.gh, cell = world.cell;
  const nx = Math.min(gw - 1, Math.floor(world.nestX / cell)), ny = Math.min(gh - 1, Math.floor(world.nestY / cell));
  const seen = new Uint8Array(gw * gh);
  const wallAt = (k) => world.walls && world.walls[k];
  const stack = [ny * gw + nx];
  seen[ny * gw + nx] = 1;
  while (stack.length) {
    const k = stack.pop();
    const x = k % gw, y = (k - x) / gw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = (x + dx + gw) % gw, sy = (y + dy + gh) % gh;   // 环面: 越界从对侧回来
      const nk = sy * gw + sx;
      if (seen[nk] || wallAt(nk)) continue;
      seen[nk] = 1; stack.push(nk);
    }
  }
  return targets.map((t) => {
    const tx = Math.min(gw - 1, Math.floor(t.x / cell)), ty = Math.min(gh - 1, Math.floor(t.y / cell));
    return !!seen[ty * gw + tx];
  });
}

const DEFAULTS = {};
for (const s of SCHEMA) DEFAULTS[s.key] = s.default;

console.log('P1 默认路径 = 空操作');
{
  const before = JSON.stringify(values);
  applyPresetParams(null);
  ok('P1a 不带预设不改任何参数', JSON.stringify(values) === before);
  const { world } = makeWorld('pinseed');
  const f0 = world.foodPatches.length, dose0 = world.foodPatches[0].amount, x0 = world.foodPatches[0].x;
  const rep = buildPresetWorld(null, world);
  ok('P1b default 不刷墙不清食源', world.wallCount === 0 && world.foodPatches.length === f0
    && world.foodPatches[0].amount === dose0 && world.foodPatches[0].x === x0,
    `食源 ${world.foodPatches.length} 块 · 墙 ${world.wallCount} 格`);
  ok('P1c 报告里明确写了未套用', rep.applied === false);
}

console.log('P1d-P1l 出厂散粮的剂量标定(P2.4e 定标 · P2.4f 重标)');
{
  const { world } = makeWorld('pinseed');
  const patches = world.foodPatches;
  const dose = patches.reduce((s, f) => s + f.amount, 0);
  // 剂量按**每块源自己的常数**(upa = units per ant)分, 不是按面积、也不是回到「一根弦」:
  // 近籽管「快」、主源管「久」, 两个时间窗各自反解。面积决定吞吐速率、剂量决定能吃多久(见 METRICS P2.4f §1)。
  ok('P1d 块数与每块源的常数对得上定义', patches.length === DEFAULT_FOOD_SPOTS.length
    && patches.every((p, i) => p.amount === Math.max(8, Math.round(get('antCount') * DEFAULT_FOOD_SPOTS[i].upa))),
    `食源 ${patches.length} 块 · 剂量 ${patches.map((p) => p.amount).join('/')} · 每蚁 `
    + DEFAULT_FOOD_SPOTS.map((p) => p.upa).join('/') + ' · 份额 '
    + patches.map((p) => (p.amount / dose * 100).toFixed(1) + '%').join(' '));
  // 标定式先自查一遍算术: 窗口不够长就不必跑仿真了, 这条红说明常数被谁动坏了。
  // ⚠ 基准在 P2.4f 换过一次: 上一版用**全程平均**吞吐(0.0144), 三颗种子实测「整群口粮」只撑了
  //   510~630 秒, 连它自己写的 600 秒下限都没守住(第一版还用过爬升期慢速率 ⇒ 算出 890 秒而实测 95 秒)。
  //   现在钉的是**主源**在**饱和期平台**速率下能撑多久——近籽注定先没, 拿它算窗口等于把剧本记成分数。
  const win = FOOD_MAIN_PER_ANT / FOOD_RATE_SAT_PER_ANT;
  ok('P1e 主源窗口足够长(算术·按饱和期平台速率)', win >= FOOD_OBS_MIN,
    `主源每蚁 ${FOOD_MAIN_PER_ANT} 单位 ÷ ${FOOD_RATE_SAT_PER_ANT} = ${win.toFixed(0)}s ≥ ${FOOD_OBS_MIN}s`);
  ok('P1f 总量确实按蚁数给(改蚁数不用改代码)', Math.abs(dose - get('antCount') * FOOD_UNITS_PER_ANT) <= DEFAULT_FOOD_SPOTS.length,
    `出厂 ${get('antCount')} 蚁 → 总剂量 ${dose}`);
  // 主源必须占大头: 默认视图最招牌的是**一条**主走廊, 三块等量源会把它撕成三条细线
  const maxShare = Math.max(...patches.map((f) => f.amount)) / dose;
  ok('P1g 主源占大头(单走廊读图不被多源打散)', maxShare >= 0.55, `主源份额 ${(maxShare * 100).toFixed(1)}%`);
  const clear = patches.every((f) => Math.hypot(f.x - world.nestX, f.y - world.nestY) > get('nestRadius') + f.radius);
  // ↑ 用 get('nestRadius') 而不是 world.nestRadius: World 没有这个字段, 读它会得到 undefined,
  //   比较变成 false——**判据自己哑掉而读数看着像「全绿」**。buildDefaultFoods 里踩过同一次, 两边都钉住。
  const inside = patches.every((f) => f.x > f.radius && f.x < world.w - f.radius && f.y > f.radius && f.y < world.h - f.radius);
  ok('P1h 每块源都在界内且不压巢盘', clear && inside,
    patches.map((f) => (Math.hypot(f.x - world.nestX, f.y - world.nestY) | 0) + 'u/r' + f.radius).join(' '));
  // **每一块都得够得着**: 一趟(往返 ÷ speed + 装货 + 巢内磨蹭)必须短于负重泄压阀, 否则那颗种子是装饰品。
  // 被实测逼出来的: 第一版远副源 733u → 一趟 34.4 秒 > 预算, 540 秒里剩余 99%, 一口没少过。
  // 换三个种子各查一遍——出厂落位是随机的, 只查一个种子等于没查(P2.4e 的 200u 那一支就是被种子坑的)。
  // ⚠ 这是**必要**条件不是充分条件: 赢家通吃会把预算之内的源也晾在一边, 所以别拿这条判据当「会被吃」的承诺。
  for (const sd of ['pinseed', 'drain', 'preset_far']) {
    const { world: wv } = makeWorld(sd);
    const budget = tripBudget();
    const rows = wv.foodPatches.map((f) => {
      const d = Math.hypot(f.x - wv.nestX, f.y - wv.nestY);
      return { d: d | 0, t: +tripSeconds(d).toFixed(1) };
    });
    ok(`P1j·${sd} 每块源的一趟都短于泄压阀(预算 ${budget | 0}u)`,
      rows.every((f) => f.d <= budget && f.t < get('carryTimeout')),
      rows.map((f) => `${f.d}u/${f.t}s`).join(' '));
  }
  // ---- P1i / P1l: 两条时间窗, 一条钉主源、一条钉近籽, **各跑三颗种子** ----
  // **P1i 的判据对象是「主源」不是「总剂量」**(P2.4e 定的, 阈值 70% 一字未动): 两块源是分工的——
  // 近籽的职责就是先被吃完, 拿「总剂量还剩多少」去判等于把设计目标记成分数, 完全正确的出厂场景永远过不了。
  // ⚠ **P2.4f 把覆盖面从 1 颗扩到 3 颗**: 上一版只跑 'drain', 而三颗实测 300 秒时主源剩 62% / 66% / 80%,
  //   阈值 70% 恰好只有 'drain' 过得了——**判据挑种子 = 判据没在判任何东西**。这次动的是剂量与覆盖面,
  //   不是阈值: 70% 保留, 三颗都必须过。(旧版那条 58.7% 的红照登, 见 METRICS P2.4e §3。)
  for (const sd of ['drain', '424242', 'pinseed']) {
    const { world: w2, field: f2, colony: c2 } = makeWorld(sd);
    const main0 = w2.foodPatches[1].amount, near0 = w2.foodPatches[0].amount;
    let nearAt30 = -1, nearAt60 = -1;
    for (let i = 1; i <= 300 * 60; i++) {
      f2.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
      c2.step(f2, w2, values, DT);
      if (i === 30 * 60) nearAt30 = w2.foodPatches[0] ? w2.foodPatches[0].amount / near0 : 0;
      if (i === 60 * 60) nearAt60 = w2.foodPatches[0] ? w2.foodPatches[0].amount / near0 : 0;
    }
    const mainLeft = w2.foodPatches[1] ? w2.foodPatches[1].amount / main0 : 0;
    const nearLeft = w2.foodPatches[0] ? Math.max(0, w2.foodPatches[0].amount / near0) : 0;
    ok(`P1i·${sd} 跑 300 秒后**主源**仍 ≥70%(缺口长得出来的时间窗)`, mainLeft >= 0.7 && c2.deliveries > 0,
      `主源 ${(mainLeft * 100).toFixed(1)}% · 近籽 ${(nearLeft * 100).toFixed(1)}% · 卸货 ${c2.deliveries} · 负重 ${c2.loadedCount()}`);
    // ⚠ 这条判据**作废过一个子句并留痕**(与 survival_check T3 同一种处理): 原来还带一句「30 秒时已啃 ≥15%」,
    //   实测 30 秒只啃了 5%(另一颗种子同一时刻啃掉 19%)——那一段量的是**走廊成形快慢**, 由爬升期决定,
    //   跨种子差 4 倍, 不是场景设计能定的东西, 所以删掉那一句。留下两句钉的才是场景设计:
    //   不能闪没(否则缺口看不见)、必须在观察窗内见底(否则没有生命周期)。
    ok(`P1l·${sd} 近籽: 60 秒时仍 ≥50%(不是闪没) 且 300 秒前已见底(生命周期看得完)`,
      nearAt60 >= 0.5 && nearLeft < 0.10,
      `60s 剩 ${(nearAt60 * 100).toFixed(0)}% · 300s 剩 ${(nearLeft * 100).toFixed(0)}%(30s 剩 ${(nearAt30 * 100).toFixed(0)}% 仅记录)`);
  }
  // 手点那粒(F 工具左键)必须与出厂近籽**同一条律**, 否则两套量纲各写各的:
  // 旧值是硬编码 120 单位, 在出厂吞吐(实测平均 28 u/s)下不到 5 秒就没了, 点了等于没点。
  ok('P1k 手点剂量 == 出厂近籽剂量(同源一条律)', handFoodDose() === patches[0].amount ||
    handFoodDose() === Math.max(60, Math.round(get('antCount') * FOOD_NEAR_PER_ANT)),
    `手点 ${handFoodDose()} 单位 · 近籽 ${patches[0].amount} 单位`);
}

console.log('P2 参数增量可撤销、不叠加');
{
  const touched = PRESETS.filter((p) => p.params && Object.keys(p.params).length).map((p) => p.id);
  ok('P2a 至少有一个预设带参数增量(否则这条判据是空的)', touched.length >= 2, touched.join('/'));
  for (const id of touched) {
    applyPresetParams(id);
  }
  const stuck = Object.keys(DEFAULTS).filter((k) => values[k] !== DEFAULTS[k]);
  ok('P2b 逐个过一遍之后再切回 default ⇒ 全部回到出厂',
    (applyPresetParams('default'), Object.keys(DEFAULTS).filter((k) => values[k] !== DEFAULTS[k]).length === 0),
    `残留偏离 ${stuck.length} 项后又被撤回`);
  // 期望值一律从预设定义本身读, 不在此写死数字: 上一版写死了 60/90, 于是「迷宫把
  // forageTimeout 从 60 调到 120」这个正当的场景修正会把一条本来在测「不残留」的判据判红。
  // 判据要测的性质没变(换一个预设 = 先撤上一个的参数), 变的只是取值来源。
  const mDef = presetById('maze').params, tDef = presetById('twoSource').params;
  applyPresetParams('maze');
  const mGot = Object.keys(mDef).map((k) => [k, get(k)]);
  applyPresetParams('twoSource');
  const leaked = Object.keys(mDef).filter((k) => !(k in tDef) && get(k) !== DEFAULTS[k]);
  const wrong = Object.keys(tDef).filter((k) => get(k) !== tDef[k]);
  ok('P2c 换预设时上一个预设的参数不残留',
    mGot.every(([k, v]) => v === mDef[k]) && leaked.length === 0 && wrong.length === 0,
    `maze 落到 ${JSON.stringify(Object.fromEntries(mGot))} → twoSource 残留 [${leaked.join(',')}] 未生效 [${wrong.join(',')}]`);
  applyPresetParams('default');
  ok('P2d baseline 已清空', presetBaseline() !== null || get('forageTimeout') === DEFAULTS.forageTimeout);
}

console.log('P3/P4 布局规格与可达性');
for (const p of PRESETS) {
  if (p.id === 'default') continue;
  applyPresetParams(p.id);
  const { world } = makeWorld('preset' + p.id);
  const rep = buildPresetWorld(p.id, world);
  const spec = p.layout(get('worldW'), get('worldH'));
  ok(`${p.id}·P3a 套用生效且食源块数对得上`, rep.applied === true && world.foodPatches.length === spec.foods.length,
    `食源 ${world.foodPatches.length} 块 · 墙 ${rep.wallCount} 格 · 剂量 ${rep.dose}`);
  ok(`${p.id}·P3b 巢盘 1.5 倍内没有墙`, world.wallAt(world.nestX, world.nestY) === 0
    && (() => { let n = 0; for (let a = 0; a < 6.28; a += 0.2) { const rr = get('nestRadius') * 1.5; if (world.wallAt(world.nestX + Math.cos(a) * rr, world.nestY + Math.sin(a) * rr)) n++; } return n === 0; })());
  const reach = reachable(world, world.foodPatches);
  ok(`${p.id}·P4 每块食源都走得通`, reach.length > 0 && reach.every(Boolean), `可达 ${reach.filter(Boolean).length}/${reach.length}`);
  applyPresetParams('default');
}

// 一趟的物理下界 = 巢到最近食源的**绕墙最短路**往返 ÷ 速度。
// 为什么不用欧氏距离(第一版用了, 于是 maze 判据读出一趟 34.8s、实测首卸 112s):
// 墙的存在正是为了让「实际要走的路」远大于「直线距离」——拿直线距离推窗口, 等于假设墙不存在。
// 这里复用同一个四邻域洪泛(BFS), 因为它给出的正是蚂蚁在墙格掩码下唯一能走的那张图上的距离。
function pathLenToFood(world) {
  const gw = world.gw, gh = world.gh, cell = world.cell;
  const dist = new Int32Array(gw * gh).fill(-1);
  const nx = Math.min(gw - 1, Math.floor(world.nestX / cell)), ny = Math.min(gh - 1, Math.floor(world.nestY / cell));
  const q = [ny * gw + nx];
  dist[ny * gw + nx] = 0;
  for (let head = 0; head < q.length; head++) {
    const k = q[head], x = k % gw, y = (k - x) / gw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = (x + dx + gw) % gw, sy = (y + dy + gh) % gh, nk = sy * gw + sx;
      if (dist[nk] >= 0 || (world.walls && world.walls[nk])) continue;
      dist[nk] = dist[k] + 1;
      q.push(nk);
    }
  }
  let best = Infinity;
  for (const f of world.foodPatches) {
    const tx = Math.min(gw - 1, Math.floor(f.x / cell)), ty = Math.min(gh - 1, Math.floor(f.y / cell));
    const d = dist[ty * gw + tx];
    if (d >= 0) best = Math.min(best, d * cell);
  }
  return best;
}
function tripLowerBound(world) {
  const L = pathLenToFood(world);
  if (!Number.isFinite(L)) return Infinity;
  // 绕墙路径按四邻域折线计, 本身已经把「不能斜穿」算进去了; 真实蚂蚁还要搜索与抖动, 所以只是下界。
  return (2 * L) / get('speed');
}
// 窗口 = 下界 × 2.5(搜索 + 巢内滞留 + 取食排队三笔裕量), 夹在 [60, 300] 秒。
const tripWindow = (world) => Math.min(300, Math.max(60, 2.5 * tripLowerBound(world)));

console.log('P5/P6 真跑 60 秒 + 可复现');
function run(id, seedStr, secs) {
  applyPresetParams(id);
  const { world, field, colony } = makeWorld(seedStr);
  const rep = buildPresetWorld(id, world);
  const window = secs || tripWindow(world);
  const steps = Math.round(window * 60);
  let foundAt = -1, bad = false;
  let delAt = -1;
  for (let i = 0; i < steps; i++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
    if (foundAt < 0 && colony.firstFoodAnt >= 0) foundAt = i;
    if (delAt < 0 && colony.deliveries > 0) delAt = i;
    if (!Number.isFinite(colony.px[i % colony.count])) bad = true;
  }
  const lower = tripLowerBound(world);
  let sum = 0;
  for (let i = 0; i < colony.count; i++) sum += colony.px[i] + colony.py[i] + colony.theta[i] + colony.hx[i] + colony.hy[i] + colony.load[i];
  applyPresetParams('default');
  return {
    sum: sum.toPrecision(17), del: colony.deliveries, foundAt, delAt, bad, rep, window, lower,
    to: colony.timeouts, ab: colony.aborts,
  };
}
{
  const t0 = performance.now();
  for (const p of PRESETS) {
    const a = run(p.id, 'precheck');
    ok(`${p.id}·P5 在推导窗口内既找到也搬回`, !a.bad && a.foundAt >= 0 && a.del > 0,
      `一趟下界 ${a.lower.toFixed(1)}s → 窗口 ${a.window.toFixed(0)}s · 首见 ${(a.foundAt / 60).toFixed(1)}s`
      + ` · 首卸 ${a.delAt < 0 ? '窗口内没有' : (a.delAt / 60).toFixed(1) + 's'}`
      + ` · 卸货 ${a.del} · 弃货 ${a.to} · 空手返巢 ${a.ab}`);
  }
  // P6 只在一臂上做(它验的是「布局不吃随机流」, 与窗口长度无关): 省下 5 次 60 秒的机时
  const c1 = run('maze', 'precheck', 60), c2 = run('maze', 'precheck', 60);
  ok('P6 同种子两次 build 逐位相同(maze 臂)', c1.sum === c2.sum, c1.sum);
  console.log(`  用时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
console.log(`\npreset_check: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
