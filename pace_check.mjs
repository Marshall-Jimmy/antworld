// P2.4c · 倍速循环门禁(虚拟时钟)。
//
// 为什么需要这一份: core/loop.js 不在任何无头仿真门禁的作用面上 —— perf_check / smoke /
// 各 check 全部自己写死循环推进, 没有一个 import 本文件。而这一页本轮连出两个**在页面上肉眼
// 看不出来**的错: 等效倍速把 步/秒 × step 写成 ×60(160 步/秒印成 9600×), 步/秒的窗口累加了
// 被 maxDt 钳过的 dt(帧越慢高估越多, 恰好在最吃紧的时候朝好的方向骗人)。
// 所以这里用虚拟时钟把「帧多久一次 / 单步多少毫秒 / 出画一次多少毫秒」全部变成可控输入,
// 让循环本身的时间账能被逐条断言。
//
// 纪律: 本脚本不 import sim/*, 不改参数, 不掷随机数, 不写盘。它只量循环。
// 跑法: node pace_check.mjs
import { Loop, paceText } from './core/loop.js';

let nPass = 0, nFail = 0;
const rep = [];
function ok(name, cond, detail) {
  if (cond) { nPass++; rep.push('PASS  ' + name + (detail ? '   [' + detail + ']' : '')); }
  else { nFail++; rep.push('FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
}
const near = (a, b, rel) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-9;
const f3 = (x) => (Math.round(x * 1000) / 1000).toString();

// ---------- 虚拟时钟 ----------
let NOW = 0;
Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: { now: () => NOW } });
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// ---------- 新版驱动器: 每帧调一次 _tick, 时间全走虚拟时钟 ----------
function drive(cfg) {
  const { timeScale, costMs, idleMs = 0.5, renderMs = 6, frames = 120, stepBudgetMs, forceRender } = cfg;
  NOW = 0;
  const R = { renders: 0, steps: 0, simMs: 0, sumFrameDt: 0, maxFrameMs: 0, maxSimMs: 0, rawSum: 0, clampedSum: 0 };
  const loop = new Loop({
    step: 1 / 60,
    onStep: () => { NOW += costMs; R.simMs += costMs; R.steps++; },
    onFrame: (dt) => { NOW += renderMs; R.renders++; R.sumFrameDt += dt; },
  });
  if (stepBudgetMs !== undefined) loop.stepBudgetBase = stepBudgetMs;
  loop.setSpeed(timeScale);
  if (stepBudgetMs !== undefined) loop.budgetMs = Math.max(stepBudgetMs, loop.minRenderMs);
  if (forceRender) loop.forceRender = () => true;
  loop.start();
  let prevT = 0;
  for (let i = 0; i < frames; i++) {
    NOW += idleMs;
    const t = NOW;
    const rawMs = t - prevT;
    R.rawSum += rawMs / 1000;
    R.clampedSum += Math.min(rawMs / 1000, loop.maxDt);   // 旧 tps 口径用的就是这一列
    prevT = t;
    const simBefore = R.simMs;
    loop._tick(t);
    R.maxFrameMs = Math.max(R.maxFrameMs, NOW - t);
    R.maxSimMs = Math.max(R.maxSimMs, R.simMs - simBefore);
  }
  R.wallSec = NOW / 1000;
  R.demandSec = R.clampedSum * timeScale;      // 按 dt 钳位规则【应该】推进的仿真时间
  R.deliveredSec = R.steps / 60;
  R.leftSec = loop.accum;
  R.droppedSec = R.demandSec - R.deliveredSec - R.leftSec;
  R.tps = loop.tps;
  R.fps = loop.fps;
  R.demandTps = loop.demandTps();
  R.accumCap = loop.accumCap;
  R.budgetMs = loop.budgetMs;
  R.loop = loop;
  return R;
}

// ---------- 旧版算法复现(HEAD 的 loop.js + 本轮初稿的 tps 口径), 用来量化病根 ----------
function driveOld(cfg) {
  const { timeScale, costMs, idleMs = 0.5, renderMs = 6, frames = 120 } = cfg;
  NOW = 0;
  const step = 1 / 60;
  let accum = 0, last = 0, steps = 0, renders = 0, droppedSec = 0, maxFrameMs = 0;
  let tps = 0, tpsN = 0, tpsT = 0;
  for (let i = 0; i < frames; i++) {
    NOW += idleMs;
    const t = NOW, frameStart = t;
    let dt = (t - last) / 1000; last = t;
    if (dt > 0.05) dt = 0.05;
    accum += dt * timeScale;
    let guard = 0;
    while (accum >= step && guard < 240) { NOW += costMs; accum -= step; steps++; guard++; }
    if (guard >= 240) { droppedSec += accum; accum = 0; }   // 旧写法: 顶格就整段扔掉
    NOW += renderMs; renders++;
    tpsN += guard; tpsT += dt;                                 // 旧 tps 口径: 用钳过的 dt
    if (tpsT >= 0.5) { tps = tpsN / tpsT; tpsN = 0; tpsT = 0; }
    maxFrameMs = Math.max(maxFrameMs, NOW - frameStart);
  }
  return { steps, renders, droppedSec, maxFrameMs, tps, wallSec: NOW / 1000 };
}

// ============ T1 档位表: 哪些数字定了倍速的行为, 钉死它 ============
{
  const mk = () => new Loop({ step: 1 / 60, onStep() {}, onFrame() {} });
  const tbl = [[1, 0, 12, 0.05], [0.125, 0, 12, 0.05], [4, 28, 28, 0.2], [16, 40, 40, 0.8], [64, 40, 40, 3.2]];
  let allOk = true, detail = [];
  for (const [x, minR, budget, cap] of tbl) {
    const l = mk(); l.setSpeed(x);
    if (l.minRenderMs !== minR || l.budgetMs !== budget || Math.abs(l.accumCap - cap) > 1e-9) {
      allOk = false; detail.push(x + '→' + l.minRenderMs + '/' + l.budgetMs + '/' + f3(l.accumCap));
    }
  }
  ok('T1a 倍速档位表(渲染门槛/仿真预算/积压上限)逐项命中', allOk, detail.join(' '));
  const l64 = mk(); l64.setSpeed(64);
  ok('T1b 积压上限未放宽: 64× 的 accumCap 3.2s ≤ 旧版 240 步窗口 4.0s', l64.accumCap <= 4.0, f3(l64.accumCap) + 's vs 4.0s');
  ok('T1c 需求步率 demandTps = 倍速/step', l64.demandTps() === 3840, '3840 步/秒');
  const slow = drive({ timeScale: 64, costMs: 7, idleMs: 0.5, renderMs: 6, frames: 60 });
  ok('T1d 预算闸真的生效: 单帧仿真 ≤ 预算+4步超冲', slow.maxSimMs <= slow.budgetMs + 4 * 7 + 0.01,
    '最大单帧仿真 ' + f3(slow.maxSimMs) + ' ms ≤ ' + f3(slow.budgetMs + 28) + ' ms');
  const oldSlow = driveOld({ timeScale: 64, costMs: 7, idleMs: 0.5, renderMs: 6, frames: 60 });
  ok('T1e 病根②量化: 旧写法一帧能跑爆(帧时 >600 ms), 新写法一帧封顶 <200 ms',
    oldSlow.maxFrameMs > 600 && slow.maxFrameMs < 200,
    '旧 最大帧 ' + f3(oldSlow.maxFrameMs) + ' ms / 新 最大帧 ' + f3(slow.maxFrameMs) + ' ms');
  // 判据约束的是【真吞吐 = 步/秒】, 不是【固定帧数下的步数】—— 后者比错了量: 同样 60 帧,
  // 旧写法一帧 1.3 秒(79 秒跑完), 新写法一帧 62 ms(3.7 秒跑完), 拿步数直接比会得出 24 倍的假差距。
  // 这条本身就是教训 ⑫(判据要写清它约束的是谁)在本轮的复发, 所以把两个数都印出来。
  const rateNew = slow.steps / slow.wallSec, rateOld = oldSlow.steps / oldSlow.wallSec;
  ok('T1f 真吞吐(步/秒)基本不降级(≥旧版 70%), 换来的是不卡死的帧',
    rateNew >= rateOld * 0.7 && slow.maxFrameMs < 200,
    '新 ' + f3(rateNew) + ' 步/秒(墙钟 ' + f3(slow.wallSec) + 's) vs 旧 ' + f3(rateOld) + ' 步/秒(墙钟 ' + f3(oldSlow.wallSec) + 's)');
}

// ============ T2 时间守恒: 不再"整段消失" ============
{
  const fast = drive({ timeScale: 2, costMs: 0.1, idleMs: 16.6, renderMs: 0.1, frames: 300 });
  ok('T2a 机器追得上时零丢失(丢弃=0)', Math.abs(fast.droppedSec) < 1 / 60,
    '丢弃 ' + f3(fast.droppedSec) + 's / 300 帧');
  const expectSteps = Math.round(fast.demandSec * 60);
  ok('T2b 追得上时步数=需求步数(不多不少)', fast.steps === expectSteps, fast.steps + ' vs ' + expectSteps);
  ok('T2c 时间账恒等式闭合(需求=交付+在途+丢弃)', Math.abs(fast.demandSec - fast.deliveredSec - fast.leftSec - fast.droppedSec) < 1e-9);
  const sat = drive({ timeScale: 64, costMs: 7, idleMs: 16.6, renderMs: 6, frames: 120 });
  ok('T2d 饱和时在途积压不越上限', sat.loop.accum <= sat.accumCap + 1e-9, f3(sat.loop.accum) + ' ≤ ' + f3(sat.accumCap));
  ok('T2e 饱和时账仍然闭合', Math.abs(sat.demandSec - sat.deliveredSec - sat.leftSec - sat.droppedSec) < 1e-6,
    '需求 ' + f3(sat.demandSec) + 's = 交付 ' + f3(sat.deliveredSec) + 's + 在途 ' + f3(sat.leftSec) + 's + 丢弃 ' + f3(sat.droppedSec) + 's');
  // 旧写法真正咬人的那一格: 64× 碰不到 240 步顶格(3.2s<4.0s), 要 ≥80× 才会整段丢
  const o64 = driveOld({ timeScale: 64, costMs: 0.1, idleMs: 16.6, renderMs: 0.1, frames: 120 });
  ok('T2f 更正入档: 旧写法在 64× 确实丢不到时间(上一轮的归因不完整)', o64.droppedSec < 1e-9,
    '64× 旧丢弃 ' + f3(o64.droppedSec) + 's');
  const o128 = driveOld({ timeScale: 128, costMs: 0.1, idleMs: 60, renderMs: 0.1, frames: 120 });
  const n128 = drive({ timeScale: 128, costMs: 0.1, idleMs: 60, renderMs: 0.1, frames: 120 });
  ok('T2g 旧写法在 ≥80× 顶格后整段丢弃, 新写法不丢', o128.droppedSec > 10 && n128.droppedSec < 1 / 60,
    '128×/慢帧: 旧丢 ' + f3(o128.droppedSec) + 's(=扔掉 ' + Math.round(o128.droppedSec * 60) + ' 步) / 新丢 ' + f3(n128.droppedSec) + 's');
}

// ============ T3 计量诚实: 倍速读数不许随帧率漂移 ============
{
  const slow = drive({ timeScale: 1, costMs: 0.05, idleMs: 200, renderMs: 0.1, frames: 40 });
  const realTps = slow.steps / slow.wallSec;
  const oldMeter = slow.steps / slow.clampedSum;   // 旧口径复现(窗口用钳过的 dt)
  ok('T3a tps 用未钳位真实时间: 与 步数/真实秒 相符(≤3%)', near(slow.tps, realTps, 0.03),
    '报 ' + f3(slow.tps) + ' vs 真 ' + f3(realTps) + ' 步/秒');
  ok('T3b 旧口径确实会高估(≥3.5×) —— 这条断言钉的是"为什么必须改"', oldMeter / realTps >= 3.5,
    '旧口径会报 ' + f3(oldMeter) + ' 步/秒 = 真值的 ' + f3(oldMeter / realTps) + ' 倍');
  const every = drive({ timeScale: 1, costMs: 0.1, idleMs: 16.6, renderMs: 0.1, frames: 200 });
  ok('T3c onFrame 收到的是"距上次出画的真实间隔"(求和≈墙钟)', Math.abs(every.sumFrameDt - every.wallSec) < 0.05,
    'Σ=' + f3(every.sumFrameDt) + 's vs 墙钟 ' + f3(every.wallSec) + 's');
  const sat = drive({ timeScale: 64, costMs: 7, idleMs: 0.5, renderMs: 6, frames: 60 });
  ok('T3d fps 字段是渲染帧率而不是步率', near(sat.fps, sat.renders / sat.wallSec, 0.35),
    'fps ' + f3(sat.fps) + ' vs 渲染 ' + f3(sat.renders / sat.wallSec) + ' 次/秒, 步率 ' + f3(sat.tps) + ' 步/秒');
  const paused = drive({ timeScale: 0, costMs: 1, idleMs: 16.6, renderMs: 6, frames: 60 });
  ok('T3e 暂停(0×)一步都不推进, 但画面照常出', paused.steps === 0 && paused.renders === 60,
    '步 ' + paused.steps + ' / 出画 ' + paused.renders + ' 次');
}

// ============ T4 渲染分档 ============
{
  const r1 = drive({ timeScale: 1, costMs: 0.1, idleMs: 16.6, renderMs: 6, frames: 120 });
  ok('T4a 1× 每帧都画(出厂路径不变)', r1.renders === r1.loop.stepsDone / 1 || r1.renders === 120, '出画 ' + r1.renders + '/120 帧');
  const rs = drive({ timeScale: 0.125, costMs: 0.1, idleMs: 16.6, renderMs: 6, frames: 120 });
  ok('T4b 慢动作 1/8× 也每帧都画', rs.renders === 120, '出画 ' + rs.renders + '/120 帧');
  const r64 = drive({ timeScale: 64, costMs: 0.05, idleMs: 16.6, renderMs: 6, frames: 240 });
  const ratio = r64.renders / 240;
  ok('T4c 64× 快机器上按 40 ms 门槛降频出画', ratio > 0.15 && ratio < 0.7, '出画/帧 = ' + f3(ratio));
  ok('T4d 64× 在够快的机器上能满达成(循环不是瓶颈)', r64.droppedSec < 1 / 60 && near(r64.tps, r64.demandTps, 0.05),
    '报 ' + f3(r64.tps) + ' 步/秒 vs 需 ' + r64.demandTps + ' → 达成 ' + Math.round(100 * r64.tps / r64.demandTps) + '%');
  const rf = drive({ timeScale: 64, costMs: 0.05, idleMs: 16.6, renderMs: 6, frames: 240, forceRender: true });
  ok('T4e 录像期间不许跳帧(forceRender 每帧出画)', rf.renders === 240, '出画 ' + rf.renders + '/240 帧');
}

// ============ T5 paceText 数字 ============
{
  const mk = (ts, tps) => { const l = new Loop({ step: 1 / 60, onStep() {}, onFrame() {} }); l.setSpeed(ts); l.tps = tps; return l; };
  ok('T5a 1× 与暂停不显示倍速行', paceText(mk(1, 60)) === '' && paceText(mk(0, 0)) === '' && paceText(mk(0.125, 8)) === '');
  const s = paceText(mk(64, 120));
  ok('T5b 量纲钉: 120 步/秒 = 2.00× 而不是 7680×', s.includes('=2.00×') && !s.includes('7680'), s);
  const full = paceText(mk(64, 3840));
  ok('T5c 满达成读数', full === '仿真 3840 步/秒=64.00× (需 3840 步/秒≈64×, 达成 100%)', full);
  let bounded = true;
  for (const tps of [0, 1, 37, 3839, 99999]) { const t = paceText(mk(64, tps)); const p = Number(/达成 (\d+)%/.exec(t)[1]); if (!(p >= 0 && p <= 100)) bounded = false; }
  ok('T5d 达成 % 恒在 0..100(超机器时不报虚高)', bounded);
  const browser = paceText(mk(64, 160));
  ok('T5e 本轮浏览器初稿读数留档(160 步/秒 → 2.67×, 达成 4%)', browser.includes('=2.67×') && browser.includes('达成 4%'), browser);
  // ---- T5f-T5h 上限那一段(P2.4d 新增读数的三条自证) ----
  // 为什么要有 T5f: 「本机上限」是一个【算出来的数】, 而它的两个输入都来自 tick 里的计时。
  // 如果哪天有人在重构里把计时写死成 0, 这一段会【静默消失】—— 页面上看不出任何异常,
  // 而丢掉的是「这台机器到底能跑几倍」这句唯一能回答用户问题的话。所以先钉它非零。
  const d64 = drive({ timeScale: 64, costMs: 7, idleMs: 0.5, renderMs: 6, frames: 120 });
  const lp = d64.loop;
  ok('T5f tick 墙钟分解非零且 tick ≥ sim(上限那一段的输入是活的)',
    lp.simMs > 1 && lp.tickMs >= lp.simMs, 'sim=' + f3(lp.simMs) + ' ms tick=' + f3(lp.tickMs) + ' ms');
  const withCeil = paceText(lp);
  const ceilWant = lp.tps * (lp.tickMs / lp.simMs) * lp.step;
  const overWant = Math.round(100 * (1 - lp.simMs / lp.tickMs));
  ok('T5g 上限算式: 出画占比与倍速上限都由 tick/sim 现算(独立复算一遍)',
    withCeil.includes('出画JS占 ' + overWant + '%') && withCeil.includes('本机上限 ' + ceilWant.toFixed(1) + '×'),
    withCeil + '   ← 期望含 出画JS占 ' + overWant + '% / 上限 ' + ceilWant.toFixed(1) + '×');
  ok('T5h 上限不许低于已达到的等效倍速(比值退化时不报虚低)', ceilWant >= lp.tps * lp.step,
    '上限 ' + ceilWant.toFixed(2) + '× vs 已达 ' + (lp.tps * lp.step).toFixed(2) + '×');
  const quick = mk(4, 240); quick.simMs = 0.4; quick.tickMs = 16.6;
  ok('T5i 机器追得上时不报上限(sim 太小时那个比值没有意义)', !paceText(quick).includes('上限'), paceText(quick));
}

rep.push('');
rep.push('汇总: ' + nPass + ' PASS / ' + nFail + ' FAIL');
console.log(rep.join('\n'));
process.exit(nFail ? 1 : 0);