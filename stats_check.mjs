// P2.4b 门禁 I · 量具与观察者(纯 headless, 秒级)
//
// 预登记判据(先写死再跑, 不许看到读数后回头改):
//  S1 环形缓冲语义: 未写满时 at(0) 就是第一个样本(开头不许有假的 0); 写满后 at(0) 是最旧的那个。
//  S2 退化输入: 全零窗 / 空窗 上 spark() 与 downsample() 不产生 NaN、不抛异常。
//  S3 **只读性(本阶段最重要的一条)**: 每步都跑量具(stats.sample + observer.observe)的一臂,
//     与一次都不读的一臂, 最终校验和必须**逐位相同**。量具若参与了测量, 曲线就没有资格当证据。
//     S3d 同时反向兜底: 跟拍对象取「本步第一次咬到食物的那只蚁」——事件数必须 > 0,
//     否则「逐位相同」可能只是因为量具压根没读到东西(第一跑就撞上了这条: 跟拍 7 号蚁 20 秒
//     没出过巢, 事件 0 条, 而它同时又是一条漂亮的「无回归」)。
//  S4 速率语义: 卸货率 = 窗内增量 ÷ 窗长(秒), 不是累计值; 首窗 prev 未建立时增量为 0。
//  S5 事件语义: 六个转移各自能被造出来, 且同一步内多条事件按固定优先级排序。
//  S6 个体故事: 一段人造的「出发→发现→到家→…→被捕杀」序列必须按顺序产出事件。
//  S7 真实动力学故事: 真跑 90 秒(不是 S5/S6 那种人造序列), 跟拍一只真咬到过食物的蚁,
//     故事必须同时含 出发/发现/到家, 三条账必须对得上, 且卸货率最新一秒必须读到非零。
//     为什么值得单独一条: 浏览器第一跑读出「负重 211 · 卸货 0.0/秒」时, 靠肉眼分不出
//     「机制没跑」与「跑得太慢还没到首卸(实测 25.3s)」。S7 把这件事变成会红的判据。
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Ring, ColonyStats, METRIC_DEFS, spark, downsample, foodTotal } from './core/stats.js';
import { AntObserver } from './core/observe.js';

const DT = 1 / 60;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

console.log('S1 环形缓冲');
{
  const r = new Ring(5);
  ok('S1a 空窗 mean/last 归零', r.mean() === 0 && r.last() === 0);
  r.push(1); r.push(2);
  ok('S1b 未写满时 at(0)=首个样本(没有假 0 头)', r.at(0) === 1 && r.n === 2);
  for (const v of [3, 4, 5, 6]) r.push(v);
  ok('S1c 写满后窗口=最近 5 个', r.n === 5 && r.at(0) === 2 && r.last() === 6,
    `窗=[${[0, 1, 2, 3, 4].map((i) => r.at(i)).join(',')}]`);
  ok('S1d min/max/mean 只对窗内负责', r.min() === 2 && r.max() === 6 && near(r.mean(), 4));
}

console.log('S2 退化输入');
{
  const z = new Ring(10);
  ok('S2a 空窗 spark 返回空串', spark(z, 8) === '');
  for (let i = 0; i < 10; i++) z.push(0);
  ok('S2b 全零窗 spark 不产生 NaN/undefined', !/NaN|undefined/.test(spark(z, 8)) && spark(z, 8).length === 8, spark(z, 8));
  const d = downsample(z, 4);
  ok('S2c 全零窗 downsample 全为有限数', d.length === 4 && [...d].every(Number.isFinite));
  const flat = new Ring(8);
  for (let i = 0; i < 8; i++) flat.push(3);
  const spFlat = spark(flat, 8);
  ok('S2d 完全平直的线画出来也是平的(不因归一方式变成阶梯)', /^█+$/.test(spFlat), spFlat);
}

console.log('S4 速率语义(合成计数器)');
{
  const fake = (del, to, ab, kill, loaded, count) => ({
    deliveries: del, timeouts: to, aborts: ab, kills: kill, count, loadedCount: () => loaded,
  });
  const st = new ColonyStats({ stepHz: 60, periodSec: 1, cap: 60 });
  const w = { foodPatches: [{ amount: 500 }, { amount: -3 }] };
  ok('S4a foodTotal 不把采空的斑块算进存粮(负数被跳过)', foodTotal(w) === 500);
  let c = fake(0, 0, 0, 0, 10, 100);
  for (let i = 0; i < 60; i++) st.sample(c, w);
  ok('S4b 首窗增量为 0(prev 在本窗起点建立, 不虚报起步红利)', st.rings.del.last() === 0);
  c = fake(30, 6, 3, 0, 20, 100);
  for (let i = 0; i < 60; i++) st.sample(c, w);
  ok('S4c 卸货率=窗内增量/窗长秒 = 30/1', near(st.rings.del.last(), 30), `读数 ${st.rings.del.last()}`);
  ok('S4d 负重是瞬时量取窗内均值(=20)', near(st.rings.load.last(), 20));
  ok('S4e 曲线不是累计计数器(累计会单调上涨)', st.rings.del.n === 2 && st.rings.del.at(0) === 0);
  c = fake(45, 6, 9, 6, 20, 100);
  for (let i = 0; i < 30; i++) st.sample(c, w);      // 还没攒满一个窗
  ok('S4f 不足一个窗不吐样本(版本号不变)', st.version === 2 && st.rings.del.n === 2);
  // S4g 换一种窗长(0.5s): 同一个批速率必须读出一样的数。窗一伸缩, 不除以窗长就会漏成 7.5。
  const stHalf = new ColonyStats({ stepHz: 60, periodSec: 0.5, cap: 120 });
  let h = fake(0, 0, 0, 0, 20, 100);
  for (let i = 0; i < 30; i++) stHalf.sample(h, w);
  h = fake(15, 0, 0, 0, 20, 100);
  for (let i = 0; i < 30; i++) stHalf.sample(h, w);
  ok('S4g 窗长 0.5s 时按窗长归一(15 次 / 0.5 秒 = 30/秒)', near(stHalf.rings.del.last(), 30),
    `读数 ${stHalf.rings.del.last()}`);
}

console.log('S5/S6 个体事件观察器');
{
  const world = { w: 1000, h: 1000, nestX: 500, nestY: 500 };
  const mk = () => {
    const n = 2;
    return {
      count: n, kills: 0,
      px: new Float32Array(n), py: new Float32Array(n), load: new Float32Array(n),
      pauseT: new Float32Array(n), forageT: new Float32Array(n), misses: new Float32Array(n),
    };
  };
  const ob = new AntObserver({ trailCap: 32, eventCap: 32, crumbEvery: 1, nestRadius: 30 });
  const c = mk();
  c.px[0] = 505; c.py[0] = 505;      // 基线: 空手在巢盘内(「出发」= 物理跨出巢盘)
  ob.select(0, c);
  let t = 0;
  const step = (mut) => { mut(c); ob.observe(c, world, ++t, t / 60); };
  step(() => { c.pauseT[0] = 1; });                                 // 巢内滞留
  step(() => { c.pauseT[0] = 0; c.px[0] = 700; c.py[0] = 700; });   // 空手跨出巢盘 = 出发
  step(() => { c.pauseT[0] = 1; });                                 // 野外触角扫描微停顿
  step(() => { c.pauseT[0] = 0; });                                 // 微停顿结束(不许算第二次出发)
  step(() => { c.load[0] = 1; });                                   // 发现取食
  step(() => { c.load[0] = 0; c.px[0] = 500; c.py[0] = 500; });     // 到家卸货
  step(() => { c.px[0] = 800; c.py[0] = 500; c.load[0] = 1; });     // 又一次取食
  step(() => { c.load[0] = 0; });                                   // 在野外清零 = 弃货(不是卸货)
  step(() => { c.misses[0] = 1; });                                 // 觅食失败
  c.kills = 1;
  step(() => { c.px[0] = 500; c.py[0] = 502; });                    // 被捕杀后瞬移回巢
  const codes = ob.events.map((e) => e.code).join('>');
  ok('S5a 六种事件都能造出来', ['start', 'found', 'home', 'drop', 'lost', 'died'].every((k) => (ob.summary[k] || 0) >= 1), codes);
  ok('S6a 故事顺序正确', codes === 'start>found>home>found>drop>lost>died', codes);
  ok('S5b 「负载清零发生在巢外」绝不记成到家', ob.events.filter((e) => e.code === 'home').length === 1);
  // S5f 是浏览器验收逼出来的: 跟拍迷宫里的 #7 三分钟只回过一次巢, 事件表却写着「出发 3」——
  // 旧判据拿 pauseT 归零当出发, 而野外的触角扫描微停顿走的是同一个计时器。
  // 量具不许把别的事件记成本事件(和「占比型量具退化分母」同族): 这条断言只可能因正真变少而红。
  ok('S5f 出发只数物理离巢: 野外微停顿结束不许混进故事',
    (ob.summary.start || 0) === 1, `start=${ob.summary.start || 0} 全序列 ${codes}`);
  const same = new AntObserver({ crumbEvery: 1, nestRadius: 30 });
  const c2 = mk();
  c2.px[0] = 500; c2.py[0] = 500;                 // 基线: 在巢盘内
  same.select(0, c2);
  same.observe(c2, world, 1, 1);                  // 建立 prevInNest = true
  c2.px[0] = 900; c2.py[0] = 500; c2.misses[0] = 1;  // 同一步: 觅食失败结算 + 又跨出巢盘
  same.observe(c2, world, 2, 2);
  ok('S5c 同步多事件按固定优先级排(出发最像噪声, 永远排最后)',
    same.events.map((e) => e.code).join('>') === 'lost>start', same.events.map((e) => e.code).join('>'));
  const tr = same.trail();
  ok('S5d 面包屑是扁平数组且长度为偶数(x,y 成对)', tr.length % 2 === 0 && tr.length >= 2);
  const ob2 = new AntObserver({ nestRadius: 30 });
  ob2.select(1, mk());
  ok('S5e 换蚁即清空历史(两只蚁的故事不许缝成一只)', ob2.events.length === 0 && ob2.tn === 0);
}

console.log('S3 只读性(核心): 开着量具跑 ≡ 一次都不读');
// 步数/剂量是参数而不是硬编码: S3 要「同一设置跑两臂, 逐位相同」(20 秒够),
// S7 要「跑得够久, 讲得出一整趟」(90 秒 + 管饱剂量, 与 ?food= 同一个理由)。
async function arm(withInstruments, steps = 1200, dose = 400) {
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  const r = rng(hashSeed('instcheck'));
  world.addFood(values.worldW / 2 + 80, values.worldH / 2 + 30, 30, dose);
  const colony = new Colony(1200, { rng: r, world, nestRadius: values.nestRadius });
  const stats = new ColonyStats({ stepHz: 60, periodSec: 1, cap: 60 });
  const obs = new AntObserver({ nestRadius: values.nestRadius });
  for (let i = 0; i < steps; i++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT));
    colony.step(field, world, values, DT);
    if (withInstruments) {
      // 跟拍对象: 第一只咬到食物的蚁(真实使用场景就是这个——用户点的是「正在干活的那只」)
      if (obs.idx < 0 && colony.firstFoodAnt >= 0) obs.select(colony.firstFoodAnt, colony);
      stats.sample(colony, world);
      obs.observe(colony, world, colony.stepCount, colony.stepCount / 60);
    }
  }
  let sum = 0;
  for (let i = 0; i < colony.count; i++) {
    sum += colony.px[i] + colony.py[i] + colony.theta[i] + colony.hx[i] + colony.hy[i] + colony.load[i];
  }
  let fs = 0;
  for (let i = 0; i < field.buf.length; i++) fs += field.buf[i];
  return {
    ants: sum.toPrecision(17), field: fs.toPrecision(17),
    del: colony.deliveries, to: colony.timeouts, ab: colony.aborts,
    samples: withInstruments ? stats.rings.del.n : 0,
    events: withInstruments ? obs.events.length : 0,
    crumbs: withInstruments ? obs.tn : 0,
    // 曲线最新一秒 + 观察者本体(S7 要读事件表; S3 只用上面那几个标量, 两臂仍逐位可比)
    delNow: withInstruments ? stats.rings.del.last() : 0,
    story: withInstruments ? { ...obs.summary } : null,
    obs: withInstruments ? obs : null,
  };
}
{
  const a = await arm(false);
  const b = await arm(true);
  ok('S3a 蚂蚁校验和逐位相同', a.ants === b.ants, `${b.ants}`);
  ok('S3b 场校验和逐位相同', a.field === b.field, `${b.field}`);
  ok('S3c 三个经济计数器相同', a.del === b.del && a.to === b.to && a.ab === b.ab,
    `del ${b.del} / to ${b.to} / ab ${b.ab}`);
  ok('S3d 量具确实在读数(不是靠空转假装无影响)', b.samples === 20 && b.events > 0 && b.crumbs > 0,
    `样本 ${b.samples} 窗 · 事件 ${b.events} 条 · 面包屑 ${b.crumbs} 粒`);
  console.log(`  读数 曲线 ${METRIC_DEFS.length} 条 · 无干预约收 del=${a.del}`);
}
console.log('S7 真实动力学下的完整故事(不是 S5/S6 那种人造序列)');
{
  const b = await arm(true, 5400, 200000);        // 90 秒 · 管饱剂量
  const s = b.story;
  const acct = ['start', 'found', 'home', 'drop', 'lost', 'died'].map((k) => `${k}=${s[k] || 0}`).join(' ');
  ok('S7a 真跑出来的故事含 出发+发现+到家',
    (s.start || 0) >= 1 && (s.found || 0) >= 1 && (s.home || 0) >= 1, acct);
  ok('S7b 三条账对得上: 到家≤出发(先出门才可能回) 且 到家≤发现(先咬到才可能卸)',
    (s.home || 0) <= (s.start || 0) && (s.home || 0) <= (s.found || 0), acct);
  ok('S7c 卸货率不是死量具: 90 秒末的最新一秒读到非零', b.delNow > 0,
    `最新一秒 ${b.delNow.toFixed(2)} 次/秒 · 累计 ${b.del} 趟 · 曲线 ${b.samples} 窗`);
  const evs = b.obs.events;
  let mono = evs.length > 1;
  for (let i = 1; i < evs.length; i++) if (evs[i].tSec < evs[i - 1].tSec) mono = false;
  ok('S7d 事件表按仿真时间单调不倒流(时间轴用 simSec, 倍速下墙钟差 64 倍)', mono,
    `表内 ${evs.length} 条(cap 截断, 计数看 summary=${acct})`);
}
console.log(`\nstats_check: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
