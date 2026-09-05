// P2.6 · 规模化成本仪表板(只读 sim + 纯 CPU 微基准, 不落盘)
//
// 跑法: node scale_dashboard.mjs                 三段全跑(REPS=5 实测 3 分 39 秒)
//       MODE=scale|paired|budget  单跑一段 · ONLY=target  只跑两行目标规模
//       REPS=3  每行重复次数(取中位) · LOAD=4  起 4 个自旋线程抢 CPU(见下面"负载对照")
//
// 为什么这是一个**文件**而不是一段 METRICS 文字: P2.6 的整个决策(不做场 GPU / 行为暂不迁 /
// 只做位级安全的原语优化)全靠"成本在谁身上"这一个量纲。它必须能在任何一台机器上被重新量一遍,
// 否则下一轮就只剩一句"上一轮说场只占 2%", 而那句话和当初的证据一样不可追问(§10 红线:
// 文档里每一条结论都必须有能跑的量具接着)。
//
// ⚠⚠ 更正(2026-09-05 第二轮): 上一轮这个文件头部写着一整串"实测读数"(场占 2.2% / 0.30x 实时 /
//   可归项 447 ns), 而**这个文件当时连加载都失败**——import 写成 '../core/config.js', 它在仓库根,
//   '../' 指到仓库外面去了。那串数来自一份没入库的临时脚本, 不可追问 ⇒ 一律作废。
//   本轮起: ① import 改对, ② 文件头不再放任何"读数"(读数只在 stdout, 每次重跑都刷新),
//   ③ 结论性数字(还差几倍、上限几倍)全部由**同一次运行里量出来的数**算出, 不许再写死常数。
//
// 三条测量, 各自对应一个决策:
//  ① 规模分解: field.step 与 colony.step 分开计时, 扫蚁数与网格数 ⇒ 决定"先迁谁"。
//  ② 原语预算: 每个数学/寻址原语的 ns x 每蚁每步的调用次数(次数是**数代码**得来的, 不是拟合)
//     ⇒ 决定"CPU 上还剩下多少可挤的空间", 并和同一次运行量到的 每蚁每步总 ns 对比出上限倍数。
//  ③ 配对 A/B(跨进程): 每臂一个独立起来的 node 进程, 预热 300 步再量 300 步。两种写法
//     选出的下标**完全相同**(先用 20 万坐标逐位对照证过), 轨迹一致才算同工况对照。
//     上一版是在同一进程里换函数——换一次 Field.prototype.sample 就把已 JIT 好的 colony
//     循环打回解释执行, 重新优化的钱花在被测的那几十步里。同一处改动量出过
//     +6.0% / +7.7% / -3.3% 三个相互矛盾的读数: 那不是优化在抖, 是量具在测自己。
//     现在每次还做一对可见性对照: 故意慢一倍的那臂必须被看见, 否则整段作废。
//  ④ 负载对照(可选, LOAD=n): 本项目的历史 ms/step 读数多次被"同机别的任务在抢 CPU"污染,
//     与其归因完了事, 这里直接造一次负载把那条归因**复现**出来(铁律: 归因必须附一次可复测的证据)。
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { values, set, get } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
const DT = 1 / 60;
const MODE = process.env.MODE || 'all';
const ONLY = process.env.ONLY || '';
const REPS = Number(process.env.REPS || 3);
const LOAD = Number(process.env.LOAD || 0);

// ---- CHILD 模式: ③ 配对 A/B 的被测子进程(只跑一臂, 只往 stdout 写一行 JSON) ----
// 为什么必须跨进程: 同进程里换 Field.prototype.sample 会把已经 JIT 好的 colony 循环打回
// 解释执行, 重新优化的成本落进被测的那几十步里。同一处改动在同进程量具上给出过
// +6.0% / +7.7% / -3.3% 三个读数——那不是优化在抖, 是量具在测自己。
const CHILD = process.env.CHILD || '';
if (CHILD) {
  const W = 2000, H = 1300, N = 20000, WARM = 300, STEPS = 300;
  set('gridCell', 8); set('antCount', N); set('survivalMode', 0);
  if (CHILD === 'old') Field.prototype.sample = sampleModulo;
  else if (CHILD === 'slow') Field.prototype.sample = sampleSlow;
  const world = new World(W, H, 8), field = new Field(W, H, 8);
  const r = rng(hashSeed('p26dash'));
  world.addFood(W * 0.62, H * 0.62, 30, 1e9);
  const colony = new Colony(N, { rng: r, world, nestRadius: get('nestRadius') });
  const dec = Math.pow(values.decayRate, DT);
  const step = () => { field.step(values.diffuseWeight, dec); colony.step(field, world, values, DT); };
  for (let i = 0; i < WARM; i++) step();
  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) step();
  let cs = 0;
  for (let i = 0; i < colony.population; i++) cs += colony.px[i] * 3 + colony.py[i] * 7 + field.buf[i % field.len] * 1e-6;
  process.stdout.write(JSON.stringify({ impl: CHILD, ms: (performance.now() - t0) / STEPS, cs }));
  process.exit(0);
}
const { Worker } = await import('node:worker_threads');
const spinners = [];
for (let k = 0; k < LOAD; k++) {
  spinners.push(new Worker('const t=Date.now();let x=0;while(Date.now()-t<20*60000)x+=Math.sqrt(x+1);', { eval: true }));
}
// os.cpus()[0].model 在部分虚拟机/容器里是 undefined(本机实测踩到), 所以整行都要兜底
const cpu0 = (os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model.trim() : '未知 CPU';
console.log('# 机器: ' + cpu0 + ' · ' + os.cpus().length + ' 逻辑核 · node ' + process.version +
  ' · ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC');
if (LOAD) console.log('!! LOAD=' + LOAD + ': ' + LOAD + ' 个自旋线程正在抢 CPU —— 这一段的每一个数都只与同样带 LOAD 的那一段可比');

// —— 旧写法(双重取模)的等价实现, 只为本文件里的 A/B 存在, 不进任何生产路径 ——
function sampleModulo(x, y) {
  const gx = x / this.cellSize, gy = y / this.cellSize;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const gw = this.gw, gh = this.gh;
  const x0 = ((ix % gw) + gw) % gw;
  const x1 = ((ix + 1) % gw + gw) % gw;
  const y0 = ((iy % gh) + gh) % gh;
  const y1 = ((iy + 1) % gh + gh) % gh;
  const b = this.buf;
  const v00 = b[y0 * gw + x0], v10 = b[y0 * gw + x1];
  const v01 = b[y1 * gw + x0], v11 = b[y1 * gw + x1];
  const a = v00 + (v10 - v00) * fx;
  const b1 = v01 + (v11 - v01) * fx;
  return a + (b1 - a) * fy;
}

// 故意比旧版再做一次完整寻址的 sample。它唯一的存在理由是“可见性对照”:
// §10 那条“量具不许有看起来在测其实没测的行”要求 A/B 必须先证明自己看得见差异。
function sampleSlow(x, y) {
  return sampleModulo.call(this, x, y) + sampleModulo.call(this, y, x) * 0;
}
// 正确性对照: 两种写法在 20 万个坐标上必须返回**逐位相同**的数(这比"跑一遍 sim 看校验和"更直接)
function equivalence() {
  const f = new Field(2000, 1300, 8);
  for (let i = 0; i < f.buf.length; i++) f.buf[i] = ((i * 2654435761) >>> 0) / 4294967296;
  const good = f.sample;
  let bad = 0, n = 0, oob = 0, edge = 0;
  const r = rng(hashSeed('equiv'));
  for (let k = 0; k < 200000; k++) {
    // 覆盖触角点可能出现的越界区: [-80, w+80], 以及正好贴在格边/世界边的刀锋值
    const x = (r() - 0.04) * (2000 + 160), y = (r() - 0.04) * (1300 + 160);
    if (x < 0 || x >= 2000 || y < 0 || y >= 1300) oob++;
    if (Math.abs(x % 8) < 1e-9 || Math.abs(y % 8) < 1e-9) edge++;
    const a = good.call(f, x, y);
    const b = sampleModulo.call(f, x, y);
    n++;
    if (!Object.is(a, b)) bad++;
  }
  console.log('  sample 新旧写法逐位对照: ' + n + ' 个坐标(越界 ' + oob + ' · 贴格边 ' + edge + ') => 不同的 ' + bad + ' 个');
  return bad === 0;
}

const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function simStep(ants, cell, steps, alarm, reps, surv) {
  const W = 2000, H = 1300;
  set('gridCell', cell); set('antCount', ants);
  // 每一行都显式设开关: 上一行留下来的 survivalMode 会串到这一行的读数上
  set('survivalMode', surv ? 1 : 0);
  const world = new World(W, H, cell);
  const field = new Field(W, H, cell);
  const af = alarm ? new Field(W, H, cell) : null;
  const r = rng(hashSeed('p26dash'));
  world.addFood(W * 0.62, H * 0.62, 30, 1e9);
  const colony = new Colony(ants, { rng: r, world, nestRadius: get('nestRadius') });
  const dec = Math.pow(values.decayRate, DT), decA = Math.pow(values.alarmDecay, DT);
  const step = () => {
    field.step(values.diffuseWeight, dec);
    if (af) { af.step(0, decA); colony.step(field, world, values, DT, af); }
    else colony.step(field, world, values, DT);
  };
  const warm = Math.max(30, Math.min(180, steps));
  const TF = [], TC = [];
  for (let rep = 0; rep < (reps || 1); rep++) {
    for (let i = 0; i < warm; i++) step();
    let tf = 0, tc = 0;
    for (let i = 0; i < steps; i++) {
      const a = performance.now(); field.step(values.diffuseWeight, dec); const b = performance.now();
      if (af) { af.step(0, decA); colony.step(field, world, values, DT, af); } else colony.step(field, world, values, DT);
      const c = performance.now();
      tf += b - a; tc += c - b;
    }
    TF.push(tf / steps); TC.push(tc / steps);
  }
  return { gw: field.gw, gh: field.gh, len: field.len, tf: med(TF), tc: med(TC), ants, reps: reps || 1,
    pop: colony.population, births: colony.births, deaths: colony.deaths };
}

let perAntNs = 0;                       // budget 段要用同一次运行量到的"每蚁每步总 ns"
if (MODE === 'all' || MODE === 'scale') {
  console.log('\n① 规模分解(场 vs 蚁) —— 决定"先迁谁"(每行 ' + REPS + ' 次取中位)');
  const all = [
    ['出厂规模    5千蚁 250x163', 'base', () => simStep(5000, 8, 240, false, REPS)],
    ['场x4        5千蚁 500x325', 'field4', () => simStep(5000, 4, 120, false, REPS)],
    ['目标 A     5万蚁 250x163', 'target', () => simStep(50000, 8, 120, false, REPS)],
    ['目标 B     5万蚁 500x325', 'target', () => simStep(50000, 4, 120, false, REPS)],
    ['目标+报警  5万蚁 250x163', 'target', () => simStep(50000, 8, 120, true, REPS)],
    // 唯一一行 survivalMode=1: P2.5 的机器本身也是一笔钱, 它必须进同一张表里
    ['目标+生死  5万蚁 250x163', 'target', () => simStep(50000, 8, 120, false, REPS, true), 'surv'],
  ];
  let targetA = 0;
  for (const [label, id, fn, flag] of all) {
    if (ONLY && !id.split(',').includes(ONLY) && !label.startsWith(ONLY)) continue;
    const st = fn();
    const tot = st.tf + st.tc;
    const sps = 1000 / tot;
    console.log('  ' + label.padEnd(20) + ' ' + st.gw + 'x' + st.gh + '=' + (st.len / 1000).toFixed(0) + 'k 格' +
      '  field ' + st.tf.toFixed(3) + ' + colony ' + st.tc.toFixed(3) + ' = ' + tot.toFixed(2) + ' ms/步' +
      '  => 场占 ' + (100 * st.tf / tot).toFixed(1) + '%' +
      '  | ' + sps.toFixed(1) + ' 步/秒 = ' + (sps / 60).toFixed(2) + 'x 实时' +
      '  | ' + (st.tc * 1e6 / st.ants).toFixed(0) + ' ns/蚁步' +
      (flag === 'surv' ? '  | 存活 ' + st.pop + '/' + st.ants : ''));
    if (label.startsWith('目标 A')) targetA = st.tc;
    if (flag === 'surv' && targetA) {
      console.log('     ^ 同网格同蚁数下与目标 A 的单步差异 = P2.5 这套机器的算力代价: colony +' +
        (100 * (st.tc / targetA - 1)).toFixed(0) + '%  · 出生 ' + st.births + ' 死亡 ' + st.deaths +
        ' => 每**活蚁**步 ' + (st.tc * 1e6 / st.pop).toFixed(0) + ' ns(上行那个 ns 按容量算, 只有这一行作数)');
    }
  }
}

if (MODE === 'all' || MODE === 'paired') {
  const ROUNDS = Math.max(3, REPS);
  console.log('\n③ 配对 A/B(跨进程, 每臂一个独立 node 进程) —— 量 sample() 那一刀到底省了多少');
  if (!equivalence()) console.log('  !! 新旧写法不等价, A/B 无意义');
  const arm = (impl) => JSON.parse(execFileSync(process.execPath, [process.argv[1]], {
    env: { ...process.env, CHILD: impl, MODE: 'abchild', LOAD: '0', ONLY: '', REPS: '1' },
    encoding: 'utf8', maxBuffer: 1 << 20 }));
  const N = 20000;
  const A = [], B = [];
  for (let k = 0; k < ROUNDS; k++) {
    const r1 = arm(k % 2 ? 'old' : 'new'), r2 = arm(k % 2 ? 'new' : 'old');
    const n = k % 2 ? r2 : r1, o = k % 2 ? r1 : r2;
    A.push(o.ms); B.push(n.ms);
    console.log('  轮' + k + (k % 2 ? '(old先)' : '(new先)') + ': 新=' + n.ms.toFixed(2) + ' 旧=' + o.ms.toFixed(2) +
      ' ms/步  Δ=' + (n.ms - o.ms).toFixed(2) + '  两臂轨迹逐位相同=' + Object.is(n.cs, o.cs));
  }
  const lo = (xs) => Math.min.apply(null, xs);
  const mn = lo(B), mo = lo(A);
  const neg = B.filter((v, i) => v < A[i]).length;
  console.log('  取 min(V8 微基准的常规口径): 新=' + mn.toFixed(2) + ' 旧=' + mo.toFixed(2) +
    ' => 省 ' + (100 * (1 - mn / mo)).toFixed(1) + '%  · ' + ROUNDS + ' 轮里 ' + neg + ' 轮新更快');
  perAntNs = mn * 1e6 / N;
  console.log('  每蚁每步: 旧=' + (mo * 1e6 / N).toFixed(0) + ' ns -> 新=' + perAntNs.toFixed(0) + ' ns  (2 万蚁, 无报警场)');
  const s1 = arm('slow'), n1 = arm('new');
  const sight = s1.ms / n1.ms - 1;
  console.log('  可见性对照(判据: 先证明量具看得见差异): 故意慢一倍的 sample 读到 ' + s1.ms.toFixed(2) +
    ' vs 新 ' + n1.ms.toFixed(2) + ' ms/步 => 本量具能看见 ' + (100 * sight).toFixed(0) + '% 的退化' +
    (sight > 0.1 ? ' (足以看见这一刀的量级)' : ' !! 量具看不见差异, 上面的 A/B 不作数'));
}
if (MODE === 'all' || MODE === 'budget') {
  console.log('\n② 原语预算(ns/次 x 每蚁每步调用次数, 次数为数代码所得)');
  if (!perAntNs) {
    const st = simStep(20000, 8, 45, false, 1);
    perAntNs = st.tc * 1e6 / 20000;
    console.log('  (预算的分母来自本次运行实跑: 2 万蚁 ' + st.tc.toFixed(2) + ' ms/步 => ' + perAntNs.toFixed(0) + ' ns/蚁步)');
  }
  const f = new Field(2000, 1300, 8);
  for (let i = 0; i < f.buf.length; i++) f.buf[i] = (i % 977) / 977;
  const M = 8_000_000;
  let sink = 0;
  const t = (fn) => { fn(2000); const a = performance.now(); fn(M); return (performance.now() - a) * 1e6 / M; };
  const items = [
    ['field.sample', () => t((n) => { for (let i = 0; i < n; i++) sink += f.sample((i * 7) % 2000, (i * 13) % 1300); }), 3],
    ['cos+sin(触角方向)', () => t((n) => { for (let i = 0; i < n; i++) sink += Math.cos(i * 1e-3) + Math.sin(i * 1e-3); }), 3],
    ['Math.atan2', () => t((n) => { for (let i = 0; i < n; i++) sink += Math.atan2(i % 300, i % 211); }), 1],
    ['Math.hypot', () => t((n) => { for (let i = 0; i < n; i++) sink += Math.hypot((i % 300) - 150, (i % 211) - 100); }), 1],
    ['field.deposit', () => t((n) => { for (let i = 0; i < n; i++) f.deposit((i * 7) % 2000, (i * 13) % 1300, 1e-9); }), 1],
    ['mulberry32', () => t((n) => { let s = 1; for (let i = 0; i < n; i++) { s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; sink += ((x ^ (x >>> 14)) >>> 0) / 4294967296; } }), 1],
    // 最后一条**不计入 sum**: 分母(每蚁每步总 ns)是 survivalMode=0 的实跑值, 把只在生死开着时
    // 才发生的折旧掷骰算进去会串账。它单独印一行, 给 P2.5 开着的场合做参考。
    ['wearRollP(仅生死开着)', () => t((n) => { for (let i = 0; i < n; i++) sink += 1 - Math.exp(-((3 / 1635) * Math.pow(i * 1e-4, 2)) * 0.5333); }), 0.03125, false],
  ];
  let sum = 0;
  for (const [label, run, k, inSum] of items) {
    const ns = run(); const v = ns * k;
    if (inSum !== false) sum += v;
    console.log('  ' + label.padEnd(20) + ns.toFixed(1) + ' ns x' + k + (k < 1 ? '(每32步)' : '') + ' = ' + v.toFixed(0) + ' ns/蚁步' +
      (inSum === false ? '  <- 不计入(口径: survivalMode=0)' : ''));
  }
  const rest = perAntNs - sum;
  console.log('  合计可归项 ' + sum.toFixed(0) + ' ns / 实跑总量 ' + perAntNs.toFixed(0) + ' ns/蚁步 = ' +
    (100 * sum / perAntNs).toFixed(0) + '%  => 未归项 ' + rest.toFixed(0) + ' ns');
  console.log('  上限: 把可归项**全部清零**也只有 ' + (perAntNs / rest).toFixed(2) + ' 倍(这是上界, 不是可达值)');
  console.log('  60fps@5万蚁 = 16.67 ms/步: 需要 ' + (perAntNs * 50000 / 1e6 / 16.67).toFixed(2) + ' 倍于当前单蚁成本的提速(见 ① 的实读 ms/步)');
}
for (const w of spinners) await w.terminate();
if (LOAD) console.log('  (负载对照结束, 自旋线程已回收)');
