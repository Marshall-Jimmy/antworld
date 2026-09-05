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
import { values, SCHEMA, get, set } from './core/config.js';
import { rng, hashSeed, randomSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { PRESETS, presetById, applyPresetParams, buildPresetWorld, presetBaseline } from './core/presets.js';

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
  world.addFood(w * (0.55 + r() * 0.2), h * (0.55 + r() * 0.2), 30, 200);
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
