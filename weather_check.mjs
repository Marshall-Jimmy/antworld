// P2.3 验收: 昼夜与天气(内源钟 / 温度硬门控 / 雨前低压抢收 / 雨风冲刷轨迹场)。
// 用法:
//   node weather_check.mjs                                  # 全部子测试
//   SUB=identity,storm,antiphase,temp node weather_check.mjs
//   PARAMS=k=v   SEED=wxcheck
//
// 设计原则(铁律见 docs/HANDOVER.md §4):
//  · stepOnce() 逐字复刻 app.js 的 step(): 测的就是浏览器里真正跑的那条路。
//  · 恒等回归是最强考卷: 天气开关打开但 env 恰好各处=恒等时，校验和必须与 P2.2 基线逐位相同。
//  · 每个子测试先 useParams() 重置参数(默认参数=旧行为)，子测试之间不串味。
//  · ②③ 判据在 2026-09-04 依实测重定(首轮 5 个 FAIL 全是判据错、不是机制错):
//    forceStorm 的 stormAt 走"天气时钟"(A 段天气关→step() 从未调用→stepIdx 恒 0)，且必须调用后立刻取值;
//    rush 在雨前窗口内线性 0→1，×2–3 指气压最陡处(峰值段)，整段均值判据把 ramp 也算了进去;
//    开局前 2 个周期是"蚁群从巢里散开"的爬坡期(两组都高)，会淹掉反相信号 → 成熟段才入统计。
//  · 判据用"窗口分布/恢复时间"，不用单点比值(P2.3 教训: cohort 振荡 + 爬坡段会让短基线读数全废)。
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';

const DEFAULTS = { ...values };
const DT = 1 / 60;
const SEED = process.env.SEED || 'wxcheck';
const SUB = (process.env.SUB || 'identity,storm,antiphase,temp').split(',').map(s => s.trim());
const CHECK = [];

if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    DEFAULTS[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}

function useParams(over) {
  for (const k in DEFAULTS) values[k] = DEFAULTS[k];
  if (over) for (const k in over) values[k] = over[k];
}

// ---------- app.js step() 的逐字复刻(无捕食者→alarm 恒 null; 无墙→walls 恒 null) ----------
function stepOnce(S) {
  const env = weatherActive(values) ? S.weather.step(DT, values) : null;
  const wash = env ? env.wash : 1;
  S.field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * wash), null);
  S.colony.step(S.field, S.world, values, DT, null, env);
  return env;
}

function makeSim(over, seed) {
  useParams(over);
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  const s = seed || SEED;
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(s)), world, nestRadius: values.nestRadius });
  return { world: world, field: field, colony: colony, weather: new Weather(s) };
}

// ---------- 逐秒采样器: 巢外蚁数/出巢穿越/卸货/场总量 + env 不变量 ----------
const ENV_NUM = ['phase', 'light', 'clock', 'drive', 'temp', 'tempF', 'pressure', 'rain', 'wind', 'windDir',
  'pre', 'rush', 'wash', 'dwellMul', 'vig', 'urge', 'emig', 'brisk', 'pauseRate'];
class Probe {
  constructor(S) {
    this.S = S; this.rows = []; this.ticks = 0; this.prevDel = 0; this.exitAcc = 0;
    this.state = new Uint8Array(S.colony.count); this.bad = null;
  }
  scan() {
    const c = this.S.colony, w = this.S.world, R = values.nestRadius, st = this.state;
    let outside = 0, exits = 0;
    for (let i = 0; i < c.count; i++) {
      let dx = c.px[i] - w.nestX, dy = c.py[i] - w.nestY;
      if (dx > w.w / 2) dx -= w.w; else if (dx < -w.w / 2) dx += w.w;
      if (dy > w.h / 2) dy -= w.h; else if (dy < -w.h / 2) dy += w.h;
      const o = dx * dx + dy * dy > R * R ? 1 : 0;
      if (o && !st[i]) exits++;
      st[i] = o; outside += o;
    }
    return { outside: outside, exits: exits };
  }
  total() { const b = this.S.field.buf; let s = 0; for (let i = 0; i < b.length; i++) s += b[i]; return s; }
  check(env) {
    for (const k of ENV_NUM) if (!Number.isFinite(env[k])) return k + '=' + env[k];
    if (env.wash < 1) return 'wash<1';
    if (!Number.isFinite(env.tint[0]) || env.tint[0] < 0 || env.tint[1] < 0 || env.tint[2] < 0) return 'tint<0';
    return null;
  }
  step(env) {
    this.ticks++;
    if (env && !this.bad) this.bad = this.check(env);
    if (this.ticks % 15 === 0) this.exitAcc += this.scan().exits;
    if (this.ticks % 60 !== 0) return;
    const sc = this.scan();
    const row = { t: this.ticks / 60, outside: sc.outside, exits: this.exitAcc + sc.exits, del: this.S.colony.deliveries - this.prevDel, total: this.total(), env: env };
    if (env) { row.rain = env.rain; row.wash = env.wash; row.emig = env.emig; row.rush = env.rush; row.vig = env.vig; row.tempF = env.tempF; row.clock = env.clock; row.light = env.light; row.dwellMul = env.dwellMul; }
    this.rows.push(row);
    this.prevDel = this.S.colony.deliveries; this.exitAcc = 0;
  }
}

const win = (rows, a, b) => rows.filter(r => r.t > a && r.t <= b);
const avg = (rows, k) => rows.length ? rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length : 0;
const last = (rows, k) => rows.length ? rows[rows.length - 1][k] : 0;
function spark(rows, k, n) {
  const v = rows.map(r => r[k] || 0); const mx = Math.max.apply(null, v) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * v.length / n), b = Math.max(a + 1, Math.floor((i + 1) * v.length / n));
    out.push('▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(v.slice(a, b).reduce((s, x) => s + x, 0) / (b - a) / mx * 7.999))]);
  }
  return out.join('');
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length); const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxy / Math.sqrt(sxx * syy || 1);
}
function check(name, ok, detail) { CHECK.push({ name: name, ok: !!ok, detail: detail }); console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' :: ' + detail); }

// ================== ① 恒等回归(最强考卷) ==================
// 复刻 perf_check 布局(World 不带 cell=无墙格, Field 带 gridCell, 食物 400@中心偏移)。
// 三种配置: (a) 两开关全关 (b) 天气全开但 env 处处=恒等 (c) 灵敏度对照:只开昼夜→必须变。
// P2.3 重定基: 返巢结算改判物理到家后, 空手蚁的导航不再被"假家"劫持 → ants/aborts 变,
// 负重链(deliveries/timeouts/field)逐位不变。旧值 8314152.3050845265 / aborts 1522 作废(METRICS 记录)。
// P2.4 第 6 次重定基: K_mem 出厂值 0→2(真实蚁本有个体路线记忆, 默认关=宣称这窝蚁没有记忆)。
// 记忆改变每一步的走位 → ants 校验和变; 但这个布局的宏观账本逐位不变(field/del/timeouts/aborts
// 全同), 因为单食源+强场下双通道份额制让记忆几乎不抢方向盘(METRICS ②b/③c 的"不伤害"判据)。
// 恒等逻辑本身仍成立: (a)===(b) 逐位相同见下。旧值 8296930.9330737181 = PARAMS=K_mem=0 的门控对照。
// P2.3.2 第 7 次重定基: diffuseWeight 出厂 0.06→0.02(推导依据: 云的衰减长度 ℓ=sqrt(D/λ) 必须 ≤ 触角长度,
//   否则场里存着没有蚂蚁能读的信息, 而且实测会把蚂蚁带偏)。
// 这是 sim 参数不是渲染参数 → 每步邻居混合量变了, ants/field 校验和必然全变。
// 旧基线不删除, 降级为 EXPECT_P24 常驻: 恒等跑 (d) 显式钉回 dw=0.06 必须逐位复现它。
// 没有 (d), 「EXPECT 换新数」就是改考卷凑绿; 有了 (d), 它被证明只动了 dw 这一个自由度。
// 新基线(2026-09-05 实测, dw=0.02 出厂): 与旧值同布局同种子,只有 dw 这一个自由度不同。
// 变化方向合理: 场摊得慢了 → 浓核更浓、外围更淡 → 蚂蚁读到的图样更锐,吞吐账本随之改写
// (del 752→750, timeouts 100→69, aborts 1552→1482: 更少蚁在途中超时/弃货)。
const EXPECT = { ants: '8285161.7223546822', field: '195.34836906715111', del: 750, timeouts: 69, aborts: 1474 };
// P2.3.3: 出厂多了成熟度门 K_route=2。field 总量与 del/timeouts 一个都没变(750/69),
// 变的只有蚂蚁自己的位置与空手返巢 1482→1474 ⇒ 门确实只改"往哪儿走", 不改"踩了多少进去"。
const EXPECT_P232 = { ants: '8288491.3883813173', field: '195.34836906715111', del: 750, timeouts: 69, aborts: 1482 };
const EXPECT_P24 = { ants: '8297548.1091679782', field: '285.06957330616132', del: 752, timeouts: 100, aborts: 1552 };
function identityRun(over) {
  useParams(over);
  const STEPS = 3600, WARM = 100, N = 5000;
  const world = new World(values.worldW, values.worldH);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  world.addFood(values.worldW / 2 + 80, values.worldH / 2 + 30, 30, 400);   // 与 perf_check 同一块食物
  const colony = new Colony(N, { rng: rng(hashSeed('perfseed')), world, nestRadius: values.nestRadius });
  const S = { world: world, field: field, colony: colony, weather: new Weather('perfseed') };
  for (let i = 0; i < WARM + STEPS; i++) stepOnce(S);
  let sum = 0;
  for (let i = 0; i < N; i++) sum += colony.px[i] + colony.py[i] + colony.theta[i] + colony.hx[i] + colony.hy[i] + colony.load[i];
  let fs = 0;
  for (let i = 0; i < field.buf.length; i++) fs += field.buf[i];
  return { ants: sum.toPrecision(17), field: fs.toPrecision(17), del: colony.deliveries, timeouts: colony.timeouts, aborts: colony.aborts };
}
function identityTest() {
  console.log('\n--- ① 恒等回归 (3700 步, N=5000, seed=perfseed) ---');
  const a = identityRun({ dayNight: 0, weather: 0 });
  console.log('(a) 双开关全关      : ants ' + a.ants + ' | field ' + a.field + ' | del ' + a.del + ' timeouts ' + a.timeouts + ' aborts ' + a.aborts);
  check('恒等(a) 天气关闭=旧行为逐位不变', a.ants === EXPECT.ants && a.field === EXPECT.field && a.del === EXPECT.del && a.timeouts === EXPECT.timeouts && a.aborts === EXPECT.aborts, '对基线 ' + EXPECT.ants);
  const b = identityRun({ dayNight: 0, weather: 1, tempSwing: 0, rainCooling: 0, stormEvery: 7200 });
  console.log('(b) 天气开·恒等构造 : ants ' + b.ants + ' | field ' + b.field + ' | del ' + b.del + ' timeouts ' + b.timeouts + ' aborts ' + b.aborts);
  check('恒等(b) 天气开但无风暴=逐位不变', b.ants === EXPECT.ants && b.field === EXPECT.field && b.del === EXPECT.del && b.timeouts === EXPECT.timeouts && b.aborts === EXPECT.aborts, 'rush/vig/urge/wash/dwellMul/tempF 全=1 的构造必须不动任何算术');
  const c = identityRun({ dayNight: 1, weather: 0, tempSwing: 0 });
  console.log('(c) 灵敏度对照(昼夜) : ants ' + c.ants + ' | field ' + c.field);
  check('恒等(c) 灵敏度对照: 真机制必须改变校验和', c.ants !== EXPECT.ants, '内源钟一开就该破恒等(否则说明①②是假绿)');
  // (d) 门控对照: 把改掉的 sim 参数显式钉回 P2.4 的值, 必须逐位复现旧基线。
  // P2.3.3 起这一臂要同时钉 K_route=0: (d) 的语义是逐位复现 P2.4, 而成熟度门是 P2.4 之后引入的
  // sim 层自由度。不钉的话这一臂会变成厚场+门控的混合体, 不再是任何已发布版本的对照。
  const d = identityRun({ dayNight: 0, weather: 0, diffuseWeight: 0.06, K_route: 0 });
  console.log('(d) 旧 dw=0.06 门控 : ants ' + d.ants + ' | field ' + d.field + ' | del ' + d.del + ' timeouts ' + d.timeouts + ' aborts ' + d.aborts);
  check('恒等(d) 门控: dw 钉回 0.06 必须逐位复现 P2.4 基线', d.ants === EXPECT_P24.ants && d.field === EXPECT_P24.field && d.del === EXPECT_P24.del && d.timeouts === EXPECT_P24.timeouts && d.aborts === EXPECT_P24.aborts, '对 P2.4 基线 ' + EXPECT_P24.ants);
  const e = identityRun({ dayNight: 0, weather: 0, K_route: 0 });
  console.log('(e) 旧 K_route=0 门控: ants ' + e.ants + ' | field ' + e.field + ' | del ' + e.del + ' timeouts ' + e.timeouts + ' aborts ' + e.aborts);
  check('恒等(e) 门控: 成熟度门钉回 0 必须逐位复现 P2.3.2 出厂基线', e.ants === EXPECT_P232.ants && e.field === EXPECT_P232.field && e.del === EXPECT_P232.del && e.timeouts === EXPECT_P232.timeouts && e.aborts === EXPECT_P232.aborts, '对 P2.3.2 基线 ' + EXPECT_P232.ants);
}

// ================== ② 风暴时序 A→B→C→D ==================
// A 0-120s 常态(天气关) → t=120s 开天气并立刻 forceStorm → B 雨前低压40s(抢收)
// → C 降雨45s(躲避+冲刷) → D 105s(气压回升+轨迹重建)
function stormTest() {
  console.log('\n--- ② 风暴时序 (A常态 / B雨前低压 / C降雨 / D重建) ---');
  const S = makeSim({ weather: 0, dayNight: 0, tempSwing: 0 });
  const fx = values.worldW * 0.62, fy = values.worldH * 0.62;
  S.world.addFood(fx, fy, 30, 1e9);            // 真·管饱: P2.2 的 1e5 只够健康蚁群吃 440s
  const P = new Probe(S);
  for (let t = 0; t < 120 * 60; t++) P.step(stepOnce(S));
  values.weather = 1;
  const forced = S.weather.forceStorm(values);
  // 立刻捕获: stormAt 走的是"天气时钟"(A 段天气关→stepIdx 恒 0)，跑完后还会被 schedule() 排到下一场
  const stormAt = S.weather.stormAt, stormEnd = S.weather.stormEnd;
  for (let t = 0; t < 190 * 60; t++) P.step(stepOnce(S));
  const R = P.rows, segA = win(R, 60, 120), segB = win(R, 120, 160), segB2 = win(R, 140, 160);
  const segC = win(R, 160, 205), Cmid = win(R, 168, 192), segD = win(R, 205, 310), Dend = win(R, 280, 310);
  const line = (n, g) => console.log(n.padEnd(12) + ' 出巢 ' + avg(g, 'exits').toFixed(1) + '/s  巢外 ' + avg(g, 'outside').toFixed(0) +
    '  卸货 ' + avg(g, 'del').toFixed(1) + '/s  场总量 ' + avg(g, 'total').toFixed(1) + '→' + last(g, 'total').toFixed(1) +
    '  emig ' + avg(g, 'emig').toFixed(2) + '  rush ' + avg(g, 'rush').toFixed(2) + '  rain ' + avg(g, 'rain').toFixed(2) + '  wash ' + avg(g, 'wash').toFixed(2));
  line('A(61-120)', segA); line('B(121-160)', segB); line('C(161-205)', segC); line('D(206-310)', segD); line('D末30s', Dend);
  console.log('出巢/spark ' + spark(R, 'exits', 44) + '  雨/spark ' + spark(R, 'rain', 44) + '  场/spark ' + spark(R, 'total', 44));
  console.log('对A比值: 出巢 B全程 ' + (avg(segB, 'exits') / avg(segA, 'exits')).toFixed(2) + '  B峰值段 ' + (avg(segB2, 'exits') / avg(segA, 'exits')).toFixed(2) +
    '  | 卸货 B ' + (avg(segB, 'del') / avg(segA, 'del')).toFixed(2) + '  C全程 ' + (avg(segC, 'del') / avg(segA, 'del')).toFixed(2) + '  C满雨平台 ' + (avg(Cmid, 'del') / avg(segA, 'del')).toFixed(2));
  check('forceStorm 排期: 起雨在天气时钟 +40s', forced && stormAt === 40 * 60 && stormEnd === stormAt + 45 * 60,
    'stormAt=' + stormAt + ' 步 = 天气时钟 40s = 墙上 160s(C 段起点) | stormEnd=' + stormEnd + ' = 墙上 205s(C 段终点)');
  // 雨前 40s 内 rush 线性 1→preStormRush(2.8): 生物学的 ×2–3 指气压最陡处(末段)，故分"峰值段/全程"两档
  check('B 雨前抢收: 峰值段(141-160)出巢 ≥1.5×A 且全程 ≥1.3×A',
    avg(segB2, 'exits') >= 1.5 * avg(segA, 'exits') && avg(segB, 'exits') >= 1.3 * avg(segA, 'exits'),
    '峰值段/A = ' + (avg(segB2, 'exits') / avg(segA, 'exits')).toFixed(2) + '×  全程/A = ' + (avg(segB, 'exits') / avg(segA, 'exits')).toFixed(2) + '×  (env emig ' + avg(segA, 'emig').toFixed(2) + '→' + avg(segB2, 'emig').toFixed(2) + ')');
  check('C 冲刷: 场总量 ≤ 0.6×B末', last(segC, 'total') <= 0.6 * last(segB, 'total'), 'B末 ' + last(segB, 'total').toFixed(1) + ' → C末 ' + last(segC, 'total').toFixed(1));
  check('C 雨中停摆: 卸货 ≤ 0.7×A', avg(segC, 'del') <= 0.7 * avg(segA, 'del'),
    'C全程/A = ' + (avg(segC, 'del') / avg(segA, 'del')).toFixed(2) + '×  满雨平台(168-192)/A = ' + (avg(Cmid, 'del') / avg(segA, 'del')).toFixed(2) + '×' +
    '  (平台巢外 ' + avg(Cmid, 'outside').toFixed(0) + ' vs A ' + avg(segA, 'outside').toFixed(0) + ' | dwellMul ' + avg(Cmid, 'dwellMul').toFixed(1) + ' emig ' + avg(Cmid, 'emig').toFixed(3) + ')');
  check('D 雨后重建: 卸货 ≥ 0.8×A', avg(Dend, 'del') >= 0.8 * avg(segA, 'del'), 'D末30s/A = ' + (avg(Dend, 'del') / avg(segA, 'del')).toFixed(2) + '×  (D全程 ' + (avg(segD, 'del') / avg(segA, 'del')).toFixed(2) + '×)');
  check('D 轨迹复原: 场总量 ≥ 0.5×A', last(Dend, 'total') >= 0.5 * last(segA, 'total'), 'A末 ' + last(segA, 'total').toFixed(1) + ' → D末 ' + last(Dend, 'total').toFixed(1));
  check('env 不变量(有限/wash≥1/tint≥0)', P.bad === null, P.bad || 'ok');
}

// ================== ③ 昼夜反相(内源钟可反转) ==================
function clockRun(phase, T) {
  const S = makeSim({ dayNight: 1, weather: 0, tempSwing: 0, dayLength: 120, dayPhase: phase });
  S.world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 1e9);
  const P = new Probe(S);
  for (let t = 0; t < T * 60; t++) P.step(stepOnce(S));
  return P;
}
function antiphaseTest() {
  console.log('\n--- ③ 昼夜反相 (dayLength=120s, dayPhase 0 vs 0.5, 各 360s, 同种子) ---');
  const A = clockRun(0, 360), B = clockRun(0.5, 360);
  // 爬坡期(t<130s ≈ 头两个周期)两组都在"从巢里散开"，读数同样高 → 不进相关/幅度统计
  const ma = A.rows.filter(r => r.t >= 130), mb = B.rows.filter(r => r.t >= 130);
  const rho = pearson(ma.map(r => r.outside), mb.map(r => r.outside));
  console.log('昼行(0)   巢外 ' + spark(A.rows, 'outside', 44) + '  出巢 ' + spark(A.rows, 'exits', 44));
  console.log('夜行(.5)  巢外 ' + spark(B.rows, 'outside', 44) + '  出巢 ' + spark(B.rows, 'exits', 44));
  const noon = (rs) => rs.filter(r => r.light > 0.95), night = (rs) => rs.filter(r => r.light < 0.05);
  const an = avg(noon(ma), 'outside'), bn = avg(noon(mb), 'outside'), ai = avg(night(ma), 'outside'), bi = avg(night(mb), 'outside');
  console.log('幅度窗(成熟段): 正午 light>0.95 n=' + noon(ma).length + ' 昼行 ' + an.toFixed(0) + ' vs 夜行 ' + bn.toFixed(0) +
    '   深夜 light<0.05 n=' + night(ma).length + ' 昼行 ' + ai.toFixed(0) + ' vs 夜行 ' + bi.toFixed(0));
  check('反相: 成熟段(t≥130)巢外蚁数 Pearson ≤ −0.85', rho <= -0.85, 'rho = ' + rho.toFixed(4) + '  (全段含爬坡期只有 ' + pearson(A.rows.map(r => r.outside), B.rows.map(r => r.outside)).toFixed(4) + ' → 爬坡期是主要污染源)');
  console.log('注: light 不进 sim(只喂渲染色温), 夜行组在环境夜里吃的唯一惩罚是 tempF; 本测试 tempSwing=0 故 tempF≡' + (mb[0].tempF || 0).toFixed(3) + ' → 反相全靠内源钟 phase-dayPhase 相位差');
  check('反相幅度(环境正午): 昼行 ≥ 3×夜行', bn > 0 && an / bn >= 3, '正午巢外 昼行 ' + an.toFixed(0) + ' / 夜行 ' + bn.toFixed(0) + ' = ' + (an / (bn || 1)).toFixed(2) + '×');
  check('反相幅度(环境深夜): 夜行 ≥ 3×昼行', ai > 0 && bi / ai >= 3, '深夜巢外 夜行 ' + bi.toFixed(0) + ' / 昼行 ' + ai.toFixed(0) + ' = ' + (bi / (ai || 1)).toFixed(2) + '×');
}

// ================== ④ 温度硬门控 ==================
function tempRun(base, T) {
  const S = makeSim({ weather: 1, dayNight: 0, tempSwing: 0, stormEvery: 7200, tempBase: base });
  S.world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 1e9);
  const P = new Probe(S);
  for (let t = 0; t < T * 60; t++) P.step(stepOnce(S));
  return P;
}
function tempTest() {
  console.log('\n--- ④ 温度硬门控 (tempBase 5°C vs 26°C, 各 150s, 无风暴) ---');
  const C = tempRun(5, 150), Wa = tempRun(26, 150);
  const late = g => win(g.rows, 60, 150);
  console.log('暖 26°C  出巢 ' + avg(late(Wa), 'exits').toFixed(1) + '/s  巢外 ' + avg(late(Wa), 'outside').toFixed(0) + '  tempF ' + avg(late(Wa), 'tempF').toFixed(2) + '  vig ' + avg(late(Wa), 'vig').toFixed(2));
  console.log('冷 5°C   出巢 ' + avg(late(C), 'exits').toFixed(1) + '/s  巢外 ' + avg(late(C), 'outside').toFixed(0) + '  tempF ' + avg(late(C), 'tempF').toFixed(2) + '  vig ' + avg(late(C), 'vig').toFixed(2));
  check('温度门控: 冷组出巢率 ≤ 0.25×暖组', avg(late(C), 'exits') <= 0.25 * avg(late(Wa), 'exits'), '冷/暖 = ' + (avg(late(C), 'exits') / (avg(late(Wa), 'exits') || 1)).toFixed(3) + '×  (tempF ' + avg(late(C), 'tempF').toFixed(2) + ' vs ' + avg(late(Wa), 'tempF').toFixed(2) + ')');
  check('冷组不变量', C.bad === null && Wa.bad === null, C.bad || Wa.bad || 'ok');
}

// ================== main ==================
const t0 = Date.now();
console.log('=== P2.3 昼夜与天气验收 (seed=' + SEED + ') ===');
if (SUB.indexOf('identity') >= 0) identityTest();
if (SUB.indexOf('storm') >= 0) stormTest();
if (SUB.indexOf('antiphase') >= 0) antiphaseTest();
if (SUB.indexOf('temp') >= 0) tempTest();
const bad = CHECK.filter(c => !c.ok);
console.log('\n=== ' + (bad.length ? bad.length + ' FAIL / ' : '') + CHECK.length + ' 项断言, 耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's ===');
if (bad.length) process.exit(1);
