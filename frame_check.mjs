// P2.4d · 渲染侧每帧成本门禁(倍速性能的证据基础)。
//
// 为什么现在才有一份: P2.6 立项时写的是「场计算是网格数的大头, 先上 GPU 场」——量完发现目标规模下
// 场只占单步成本 0.6–2.5%, 前提被自己的量具否证(METRICS P2.6 §0)。但那次量的是**仿真侧**;
// 「渲染侧一个数都没量过」这条欠账一直留在 P2.6 §5。本轮用户点名「优化倍速下的性能表现」,
// 而倍速的真假恰好由两边的比决定: loop 把每帧墙钟分给仿真(预算)与渲染(出画),
// 渲染侧每贵 1 ms, 倍速档就少 1/单步 步 ≈ 少 (1000/单步毫秒) 步/秒。**没有这份成本表, 任何倍速优化都是猜。**
//
// 方法学(三条, 每条都是本项目交过的学费):
//  ① 不测自己: 每一档单独跑, 跑前 warmup; 微基准的绝对值只当上界用, 结论只建立在两档之比上。
//  ② 负载免疫: 本机 CPU 与其他门禁共享, 所以每档跑 BLOCKS 个计时块、**取最快那块**(取 min 不取 mean:
//     外部抢占只会让某块变慢, 不会让它变快。见教训㉞「ms/step 不当交付判据」)。
//  ③ 判据先登记后跑: 下面的预算全部由量纲推出(见每条注释), 不是看到读数之后回头画的线。
//  ④ 改参数必须成对还原: 本脚本第一版自己就中了这一枪 —— 一个 `if (setup.restore)` 式的条件还原
//     在 restore 没挂上时静默不还原, lateralK 被留在 0, 于是「热路径」量出 0.0001 ms/帧。
//     现在一律用 try/finally, 而且**先断言参数真的在预期的值上**, 再拿它计时。
//
// 纪律: 本脚本只读 sim, 不写任何仿真状态、不掷随机数、不写盘。
// 跑法: node frame_check.mjs   ·   REPS=<每块帧数> STEPS=<预热步数> 可调
import { values, set } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { displayField } from './render/perception.js';
import { updateExposure, resetExposure, exposure, effPeak } from './render/exposure.js';
import { Ring, ColonyStats, spark } from './core/stats.js';

let nPass = 0, nFail = 0;
function ok(name, cond, detail) {
  if (cond) { nPass++; console.log('PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { nFail++; console.log('FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
const f2 = (x) => x.toFixed(2), f4 = (x) => x.toFixed(4);

// 改一个参数跑一段, 无论里面抛不抛都还原成调用前的值(不是还原成"出厂值"——那会让嵌套调用互相踩)
function withParam(key, v, fn) {
  const old = values[key];
  set(key, v);
  try { return fn(); } finally { set(key, old); }
}

// ---------- 场景: 出厂参数 + 跑出一张有走廊的场(空场上测显示量等于没测) ----------
const STEPS = Number(process.env.STEPS || 3600);      // 60 秒仿真: 首卸在 25.3s, 60s 时走廊已经成形
const REPS = Number(process.env.REPS || 240);         // 每块多少"帧"
const BLOCKS = 5;                                     // 计时块数, 取最快那块
const seed = 'framecheck';
const r = rng(hashSeed(seed));
const world = new World(values.worldW, values.worldH, values.gridCell);
// 管饱(20000 单位): 60s 内不许把食源掏空, 否则后半程的场是"蚁群散伙后的指数衰减", 那不是要量的画面
world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 20000);
const field = new Field(values.worldW, values.worldH, values.gridCell);
const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });
const dt = 1 / 60;
for (let t = 0; t < STEPS; t++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, dt), world.wallCount > 0 ? world.walls : null);
  colony.step(field, world, values, dt, null, null);
}
const simT = colony.stepCount / 60;
const stats = new ColonyStats();

// ---------- 计时器 ----------
function timeBlock(fn, reps) {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn(i);
  return (performance.now() - t0) / reps;
}
// 一档 = 先确认参数真的在要量的那一档上, warmup, 再取 BLOCKS 块里最快的那块
function bench(label, key, v, fn, reps) {
  // 档位前提必须在 withParam **里面**核: 放在外面核的是"改之前"的值, 于是门控档永远自杀(第一跑就撞上了)。
  const checked = () => {
    if (values[key] !== v) throw new Error('量 ' + label + ' 时参数 ' + key + ' 没落在 ' + v + ' 上(读到 ' + values[key] + ')');
    return fn();
  };
  const run = key === undefined ? fn : () => withParam(key, v, checked);
  for (let i = 0; i < 60; i++) run(i);
  let best = Infinity, worst = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const ms = timeBlock(run, reps || REPS);
    if (ms < best) best = ms;
    if (ms > worst) worst = ms;
  }
  if (key !== undefined && values[key] === v) throw new Error('量完 ' + label + ' 之后 ' + key + ' 没还原');
  return { label, ms: best, spread: worst - best };
}
const rows = [];
const push = (x) => { rows.push(x); return x; };

// ---------- ① 显示量(侧抑制): 出厂 lateralK=0.5 每帧两次盒式滑窗 + 一次全格减法 ----------
// 先钉住"参数确实在档上", 否则这一档会像第一版那样静默量到门控路径(0.0001 ms/帧)
ok('F0a 出厂 lateralK 确实是 0.5(量具的档位前提)', values.lateralK === 0.5, '读到 ' + values.lateralK);
ok('F0b 出厂 autoPeak 确实是 1(量具的档位前提)', values.autoPeak === 1, '读到 ' + values.autoPeak);
const hot = push(bench('displayField 出厂(lateralK=0.5)', undefined, undefined, () => displayField(field)));
const gate = push(bench('displayField 门控(lateralK=0)', 'lateralK', 0, () => displayField(field)));
// 门控的**结构**证明(比计时更硬): lateralK=0 时返回的对象必须就是 field 本身, 连壳都不造
const gateObj = withParam('lateralK', 0, () => displayField(field));
const hotObj = displayField(field);
const a1 = displayField(field).buf, a2 = displayField(field).buf;

// ---------- ② 自适应曝光 ----------
const expoHot = push(bench('updateExposure 出厂(autoPeak=1)', undefined, undefined, () => updateExposure(hotObj, colony, simT)));
const expoGate = push(bench('updateExposure 门控(autoPeak=0)', 'autoPeak', 0, () => updateExposure(hotObj, colony, simT)));
// ---------- F3 的三条腿(判据重述见下面的注释): 计时只留绝对地板, 其余换成【结构】与【对照臂】 ----------
// 先让热路径真的跑一次, 拿到「门关着会清零、门开着会留下读数」的对照状态
resetExposure();
withParam('autoPeak', 1, () => updateExposure(hotObj, colony, simT));
const expoOn = { peak: exposure.peak, ref: exposure.ref, n: exposure.n, eff: effPeak() };
resetExposure();
withParam('autoPeak', 0, () => updateExposure(hotObj, colony, simT));
const expoOff = { peak: exposure.peak, ref: exposure.ref, n: exposure.n, eff: effPeak() };
resetExposure();
// 对照臂: 一个「采一次样就抛」的假场。门关着 ⇒ 一次都不许调它(不抛); 门开着 ⇒ 必须抛。
// 这一条是给判据自己做的灵敏度测试: 没有它, 「全零」可能只是「模块压根没被调用」的另一种写法。
const boom = { gw: 1, gh: 1, buf: new Float32Array(1), sample() { throw new Error('BOOM'); } };
let offThrew = false, onThrew = false;
try { withParam('autoPeak', 0, () => updateExposure(boom, colony, simT)); } catch (e) { offThrew = true; }
try { withParam('autoPeak', 1, () => updateExposure(boom, colony, simT)); } catch (e) { onThrew = true; }
resetExposure();

// ---------- ③ HUD 文本装配与每帧计数 ----------
const ring = new Ring(60);
for (let i = 0; i < 60; i++) ring.push(i % 7);
const sparkHot = push(bench('spark() ×4 (HUD 曲线)', undefined, undefined, () => { spark(ring); spark(ring); spark(ring); spark(ring); }));
const loadedHot = push(bench('colony.loadedCount()', undefined, undefined, () => colony.loadedCount()));
const statsHot = push(bench('stats.sample(每步一次的对照)', undefined, undefined, () => stats.sample(colony, world)));

// ---------- ④ 每帧上传字节(不是时间, 是必须搬过总线的量) ----------
const bytesField = field.gw * field.gh * 4;
const bytesAnt = colony.count * 5 * 4;

// ---------- ⑤ 仿真侧单步(同一次运行现量, F5/倍速换算要用它当分母) ----------
const simStep = push(bench('仿真单步(对照用)', undefined, undefined, () => {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, dt), null);
  colony.step(field, world, values, dt, null, null);
}, 40));

// ---------- 报告 ----------
console.log('');
console.log('场景: ' + values.antCount + ' 蚁 · 场 ' + field.gw + 'x' + field.gh + ' = ' + field.buf.length + ' 格 · 仿真 ' + f2(simT) + ' s · 卸货 ' + colony.deliveries);
console.log('每档 = ' + BLOCKS + ' 个计时块取最快(块内 ' + REPS + ' 帧), 本机 CPU 与其他门禁共享 ⇒ 取 min 不取 mean');
for (const rw of rows) console.log('  ' + rw.label.padEnd(36) + f4(rw.ms) + ' ms   块间离散 ' + f4(rw.spread) + ' ms');
const simMs = simStep.ms;
console.log('  → 1× 需要 60 步/秒 = ' + f2(simMs * 60) + ' ms 仿真/秒 (帧预算 16.7 ms)');
console.log('  每帧上传: 场 ' + (bytesField / 1024).toFixed(0) + ' KB + 蚁 ' + (bytesAnt / 1024).toFixed(0) + ' KB = ' + ((bytesField + bytesAnt) / 1024).toFixed(0) + ' KB/帧');
console.log('');

// ---------- 判据 ----------
// F1 预算(量纲推导): 1× 要 60fps ⇒ 每帧 16.7 ms, 其中仿真 5000 蚁就要 3 ms。渲染侧 JS 若吃掉
//     4 ms 以上, 1× 在单核上必然掉帧; 倍速档里这 4 ms 更是直接从"能跑几步"里扣。
const renderCpu = hot.ms + expoHot.ms + sparkHot.ms + loadedHot.ms;
ok('F1 渲染侧每帧 CPU 总账(显示量+曝光+HUD 文本+计数) ≤ 4.00 ms', renderCpu <= 4.0, f4(renderCpu) + ' ms');
ok('F2a lateralK=0 时 displayField 返回的就是 field 本身(零拷贝)', gateObj === field);
ok('F2b lateralK=0 的成本 ≤ 热路径的 5%', gate.ms <= hot.ms * 0.05 + 1e-4, f4(gate.ms) + ' vs ' + f4(hot.ms) + ' ms');
ok('F2c lateralK>0 时确实造了壳(否则 F2a 是空转)', hotObj !== field && Object.getPrototypeOf(hotObj) === field);
ok('F2d 连续两帧复用同一个显示数组(零分配的结构证据)', a1 === a2 && a1.length === field.buf.length);
// F3 (2026-09-05 重述 · 交底见 METRICS P2.4d §1: 绝不为凑绿改判据, 但线要画在量得出差异的地方)
//     旧写法「门控 ≤ 热路径的 5%」在 13 µs 的绝对量级上要求门控 ≤ 0.66 µs, 而一次 performance.now()
//     的分辨率就是零点几微秒 ⇒ 它量的不是代码, 是计时器。门控那条腿结构上是「读一个 config 数 + 写五个 0」,
//     正确量级的上界是纳秒, 于是把这一条换成四件可证伪的事: 绝对地板 / 前提非空 / 状态真的清零 / 判据对差异敏感。
ok('F3a 门控 updateExposure 绝对成本 ≤ 5 µs/帧', expoGate.ms <= 0.005,
   (expoGate.ms * 1000).toFixed(2) + ' µs (预算 5 µs; 热路径 ' + (expoHot.ms * 1000).toFixed(2) + ' µs)');
ok('F3b 门控时热路径读数确实存在(否则 F3d/F3e 是空转)', expoOn.n > 0 && expoOn.peak > 0,
   'n=' + expoOn.n + ' peak=' + expoOn.peak.toFixed(3));
ok('F3c 门控后 exposure 全清零且 effPeak 退回滑杆值(画面逐位不变的构造性证据)',
   expoOff.peak === 0 && expoOff.ref === 0 && expoOff.n === 0 && expoOff.eff === values.peak,
   'peak=' + expoOff.peak + ' ref=' + expoOff.ref + ' n=' + expoOff.n + ' eff=' + expoOff.eff + ' 滑杆=' + values.peak);
ok('F3d 门关着 ⇒ 一次都不采样(假场会抛, 没抛就是真没调)', offThrew === false);
ok('F3e 门开着 ⇒ 同一个假场确实抛(对照臂, 证明 F3d 看得见差异)', onThrew === true);
console.log('  F3 信息行(原相对判据已降级为参考, 不参与通过/失败): 门控/热路径 = ' +
  (expoGate.ms / expoHot.ms * 100).toFixed(1) + '% (' + f4(expoGate.ms) + ' vs ' + f4(expoHot.ms) + ' ms)');
ok('F4a 每帧上传 ≤ 512 KB(60fps 下 30 MB/s)', (bytesField + bytesAnt) <= 512 * 1024,
   ((bytesField + bytesAnt) / 1024).toFixed(0) + ' KB/帧');
ok('F4b 蚁的实例流按 5 float/蚁登记(P2.3.5 加了第 5 个)', bytesAnt === colony.count * 20);
// F5 loop 的分档前提("倍速时把毫秒买给仿真")只有在渲染侧不比仿真单步贵时才成立
ok('F5 渲染侧 CPU ≤ 仿真单步成本(倍速分档的前提)', renderCpu <= simMs, f4(renderCpu) + ' ms vs 单步 ' + f4(simMs) + ' ms');
const gainMs = hot.ms + expoHot.ms;
ok('F6 侧抑制+曝光合计 ≤ 1.50 ms/帧(为画面服务的两项, 不许吃掉一帧的十分之一)', gainMs <= 1.5, f4(gainMs) + ' ms');
console.log('  倍速换算: 省掉显示量+曝光这 ' + f4(gainMs) + ' ms/帧 = 每帧多 ' + (gainMs / simMs).toFixed(2) +
  ' 步 = ' + f2(gainMs / simMs * 1000) + ' 步/秒(单步 ' + f4(simMs) + ' ms)');
console.log('');
console.log('frame_check: ' + nPass + ' PASS / ' + nFail + ' FAIL');
process.exit(nFail ? 1 : 0);
