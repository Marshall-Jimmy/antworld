// 昼夜与天气（P2.3）：确定性环境时钟 → 一个复用的 env 槽。sim 层只读 env，不 import 本模块。
// 设计依据 docs/ANT_BIOLOGY.md §三：
//  · 昼夜节律是**内源钟**（Camponotus rufipes 恒黑下自由运行 τ≈22.4h）——所以"昼行/夜行"不是
//    "太阳说了算"，而是内源钟与光照的**相位差**：dayPhase=0 昼行、0.5 夜行（物种预设可反转）。
//    本模块因此把"环境光照 light"与"蚁体内源钟 clock"分开算：画面跟 light 走，行为跟 clock 走。
//  · 温度窗口硬门控（10–45°C 量级）：变温动物活动力随体温升降，出不了窗口就待在巢里。
//  · 雨前低压→出巢率 ×2–3（切叶蚁抢收，Sujimoto 2019）：雨前不是躲，是抢。只在"气压正在掉"
//    的窗口里生效，降雨一开始立刻收场（它们已经回家了）。
//  · 雨/风对信息素场是**指数衰减加速器**（时间常数缩短），不是离散抹除：表现为衰减指数的乘子
//    wash，场值连续下降，绝不出现"一步清空"。
// 确定性：风暴时刻用独立随机流（seed+"|wx"）抽取，绝不触碰每只蚂蚁自己的随机流（铁律 4）。

import { mulberry32, hashSeed } from './rng.js';

const PRE_LEAD = 40;    // 雨前低压提前量(秒): 抢收窗口长度
const RECOVER = 90;     // 雨后气压恢复时间(秒)
const DROP = 20;        // 风暴最大气压降幅(mbar, 再乘天气强度)

// 环境光参考色(乘在渲染输出色上): 午夜冷蓝月光 / 晨昏暖金斜阳 / 正午白
const NIGHT_C = [0.40, 0.46, 0.72];
const GOLDEN_C = [1.04, 0.86, 0.62];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function ramp(x, edge) { const t = clamp(x / Math.max(1e-6, edge), 0, 1); return t * t * (3 - 2 * t); }

// 温度响应: [lo,p1] 线性升力, [p1,p2] 平台(满力), [p2,hi] 线性失活, 窗口外 0。
// 默认 tempBase=26 落在 [10,45] 的平台正中 → 恰为 1(不缩放任何旧算术)。
export function tempResponse(T, lo, hi) {
  const w = hi - lo;
  if (w <= 0) return 1;
  const p1 = lo + 0.35 * w, p2 = lo + 0.65 * w;
  if (T <= lo || T >= hi) return 0;
  if (T < p1) return (T - lo) / (p1 - lo);
  if (T <= p2) return 1;
  return (hi - T) / (hi - p2);
}

// 两个开关都关时调用方连 env 都不必构造(旧行为 bit 级不变)
export function weatherActive(p) { return p.dayNight > 0 || p.weather > 0; }

export class Weather {
  constructor(seed) {
    this.rnd = mulberry32(hashSeed(String(seed) + '|wx'));
    this.stepIdx = 0;
    this.shift = 0;          // 手动推时钟的相位偏移(0.5 = 立刻换到对面)
    this.stormAt = 1e12;     // 本次风暴起雨步号(低压前置 PRE_LEAD 已含)
    this.stormEnd = 1e12;
    this.stormLen = 0;
    this.wasOn = false;
    // 复用槽: 每步就地改写, 零分配(热路径)。默认值 = 恒等(乘 1 / 不改变)。
    this.env = {
      phase: 0, light: 1, clock: 1, drive: 1,
      temp: 26, tempF: 1,
      pressure: 1013, rain: 0, wind: 0, windDir: -0.5, pre: 0, rush: 1, raining: false, emig: 1,
      wash: 1, pauseRate: 1, dwellMul: 1, vig: 1, urge: 1, brisk: 1,
      tint: [1, 1, 1],
    };
    this.schedule({});
  }

  // 排下一次风暴: 间隔/时长各在均值 ±20~40% 内抽(独立随机流, 同种子可复现)
  schedule(p) {
    const every = clamp(p.stormEvery || 300, 30, 7200);
    const len = clamp(p.stormLen || 45, 5, 3600);
    this.stormAt = this.stepIdx + Math.round(every * 60 * (0.6 + 0.8 * this.rnd()));
    this.stormLen = Math.round(len * 60 * (0.7 + 0.6 * this.rnd()));
    this.stormEnd = this.stormAt + this.stormLen;
    // 本次风暴的主风向 [-1,1](负=往左斜): 同一场雨里保持一致, 不是逐帧换向
    this.windDir = this.rnd() * 2 - 1;
  }

  // 手动来一场雨(交互 R 键 / headless 验收): 留足完整的低压前置窗口, 抢收过程看得见
  forceStorm(p) {
    if (this.stepIdx >= this.stormAt - PRE_LEAD * 60 && this.stepIdx < this.stormEnd) return false;
    const len = clamp(p.stormLen || 45, 5, 3600);
    this.stormAt = this.stepIdx + PRE_LEAD * 60;
    this.stormLen = Math.round(len * 60);
    this.stormEnd = this.stormAt + this.stormLen;
    this.windDir = this.rnd() * 2 - 1;
    this.wasOn = true;   // 否则下一步的"开关刚打开→重排期"会把这场风暴泡掉
    return true;
  }

  // 把时钟推到对面(N 键): 半周期相位偏移, 演示昼↔夜
  jumpClock() { this.shift = (this.shift + 0.5) % 1; }

  // 每逻辑步推进一次, 返回复用的 env 槽
  step(dt, p) {
    const e = this.env;
    this.stepIdx++;
    const step = this.stepIdx;

    // ---- 环境光照 + 内源活动钟(相位差 = 昼行/夜行) ----
    const dayLen = clamp(p.dayLength || 240, 20, 7200);
    const phase = ((step * dt / dayLen) + this.shift) % 1;   // 0 = 正午
    const light = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
    const clock = 0.5 + 0.5 * Math.cos(2 * Math.PI * (phase - clamp(p.dayPhase || 0, 0, 1)));
    e.phase = phase; e.light = light; e.clock = clock;
    // 内源钟→活动力的响应是**超线性**的(dayCurve=k, 默认 3): 真实蚁群的觅食列是"突然开张、
    // 突然收档"的, 而不是沿钟的余弦线性渐弱。k=1(线性)时实测群体的活动相位占了整周期 85%
    // (可重跑: MODE=wave node weather_diag.mjs; 峰 4910 谷 349, 但只有午夜前后 15% 真的停)——因为滞留
    // 拉伸倍数 = 1/drive, 基准滞留只有 1.2s, drive 要掉到 0.02 以下才压得住一整趟行程,
    // 线性响应下那只剩下午夜前后的几十秒。k=3 让"该睡了"覆盖约半个周期, 晨昏两端陡峭。
    // clock=1(正午/节律关)时 clock^k 精确等于 1 → 恒等路径逐字不变。
    const k = clamp(p.dayCurve === undefined ? 3 : p.dayCurve, 1, 6);
    e.drive = 1 - clamp(p.dayNight || 0, 0, 1) * (1 - Math.pow(clock, k));

    // ---- 风暴调度 ----
    const ws = clamp(p.weather || 0, 0, 1);
    if (ws > 0 && !this.wasOn) this.schedule(p);   // 面板刚打开天气: 重新排期
    this.wasOn = ws > 0;
    if (step >= this.stormEnd + RECOVER * 60) this.schedule(p);

    const sPre = this.stormAt - PRE_LEAD * 60;
    let pre = 0, low = 0, rainShape = 0, post = 0;
    // 天气强度为 0 时整段风暴作废: 否则气压/抢收窗口仍会随机漂移, 违反"关闭即恒等"
    const on = ws > 0;
    if (on && step >= sPre && step < this.stormAt) {
      pre = (step - sPre) / (PRE_LEAD * 60);                    // 气压持续下降中
      low = pre;
    } else if (on && step >= this.stormAt && step < this.stormEnd) {
      const q = (step - this.stormAt) / Math.max(1, this.stormLen);
      rainShape = ramp(q, 0.18) * (1 - ramp(q - 0.72, 0.28));   // 雨势: 快起、后半程收
      // 抢收的生理触发量是"气压还在往下掉"(dP/dt<0)，不是"气压低": 雨一落地气压就钉在谷底不再下降，
      // 所以抢收必须跟着雨势爬升立刻退场。旧写法 pre=1-3q 让 ×2.8 的油门在雨里继续烧掉 1/3 场雨
      // (45s 雨的前 15s)——那段时间蚂蚁反而比平时更能干(实测 2.3×常态)，把雨中的停摆整个抹平。
      pre = 1 - ramp(rainShape, 0.25);   // 退场比雨势本身更快: 第一股急雨就足以判定"来不及了"
      low = 1;                                                  // 风暴期气压钉在谷底
    } else if (on && step >= this.stormEnd && step < this.stormEnd + RECOVER * 60) {
      post = (step - this.stormEnd) / (RECOVER * 60);           // 气压回升
      low = 1 - post;
    }
    const raining = on && step >= this.stormAt && step < this.stormEnd && rainShape > 0;

    const rain = ws * rainShape;
    const wind = ws * (raining ? 0.45 + 0.55 * rainShape : (step < this.stormAt ? 0.5 * pre : 0.4 * low));
    e.pre = pre; e.rain = rain; e.wind = wind; e.windDir = this.windDir; e.raining = raining;
    e.pressure = 1013 - DROP * ws * low;

    // ---- 温度: 光照日变化 + 降雨降温(变温动物的活动力天花板) ----
    const swing = clamp(p.tempSwing === undefined ? 6 : p.tempSwing, 0, 30);
    e.temp = clamp(p.tempBase === undefined ? 26 : p.tempBase, -20, 70)
      + swing * (2 * light - 1) - clamp(p.rainCooling === undefined ? 4 : p.rainCooling, 0, 20) * rain;
    const lo = clamp(p.tempMin === undefined ? 10 : p.tempMin, -30, 60);
    const hi = clamp(p.tempMax === undefined ? 45 : p.tempMax, -20, 90);
    e.tempF = tempResponse(e.temp, lo, hi);

    // ---- 三条行为通道(全 1 = 恒等) ----
    // 出巢率 = 内源钟 drive × 温度窗口 tempF × 雨前抢收 rush × 降雨蛰巢(1 − rainShelter·雨量)
    // 降雨躲避旧值 0.9 太轻: 满雨时 dwellMul 只有 10×, 而巢内滞留(1.2s)只占一个觅食周期(≈15.6s)
    // 的 7% —— 时间膨胀被行程稀释, 实测雨中卸货仍有 0.94×常态, 画面完全看不到"雨停忙"(P2.3 验收②)。
    // 0.95 → 满雨滞留 ≈24s(比一个行程还长) → 群体真的停下来; 设 0 即关闭此通道(恒等)。
    const pr = clamp(p.preStormRush === undefined ? 2.8 : p.preStormRush, 1, 6);
    e.rush = 1 + (pr - 1) * pre;
    const shelter = clamp(p.rainShelter === undefined ? 0.95 : p.rainShelter, 0, 0.99);
    const emig = clamp(e.drive * e.tempF * e.rush * (1 - shelter * rain), 0, 8);
    e.emig = emig;               // 只给 HUD 读数用, 不参与任何行为算术
    // 干练度: 出巢驱动高于常态时才生效的下压项——动机强的觅食者**少做环境评估**(触角扫描
    // 频率↓), 直接把预算换成搬运。只向上限流(clamp 下限=1): 夜里/雨中绝不让外勤蚁停更久,
    // 那会把它们钉在野外回不了巢(见 sim/ant.js 的微停顿)。brisk=1 时 ant.js 的判定式逐字不变。
    e.brisk = clamp(emig, 1, 8);
    // 巢内滞留的**走表速率**(P2.3 验收③): 滞留按生物钟的速率流逝, 而不是在卸货那一刻乘死
    // 一个常数(见 sim/colony.js 的 dwellClock)。深夜 emig→0 时滞留表几乎停走, 蚁真的出不来;
    // 天亮速率回到 1, 表上剩的余量瞬时走完 → 停摆得深、恢复得快, 不必放宽判据。
    // emig 恒定时与旧写法数学等价(总时长都 = 基准/emig) → 风暴段读数不变。
    // 1 = 恒等(正午晴天/两开关全关): 关闭路径逐字不动任何算术。下限 1/240 → 最长滞留 240×基准。
    e.pauseRate = clamp(emig, 1 / 240, 8);
    e.dwellMul = 1 / e.pauseRate;   // 等效滞留倍数(旧字段), 只给 HUD 与验收读数, 不参与行为
    // 行动力 = 温度能力(tempF=1 时恒等 1, 下限 0.3 别让蚁当场冻成木头) × 抢收提速(切运量 1.5–2× 靠个体提速)
    e.vig = (1 - 0.7 * (1 - e.tempF)) * (1 + 0.55 * (e.rush - 1));
    // 催回: 空手觅食计时走得更快 → 提前放弃回家(雨中避雨 / 夜息收工)
    // P2.3 验收③实测: 内源钟原先只作用于"巢内滞留"，夜里的蚂蚁照样把一整轮 30s 觅食走完 →
    // 昼夜波谷只降到峰值的 69%(正午 3043 vs 深夜 2082 巢外)，画面看不出"夜里停摆"。
    // 真实的夜息是整个活动预算被钟收走: 出门意愿(dwellMul)与觅食坚持度(urge)一起降级。
    // drive=1(正午, 或 dayNight=0 关闭节律)时 2.5*(1-drive) 精确为 0 → 恒等不变。
    // 抢收还有第二条腿: 低气压期不瞎找, 直接上成熟主路(觅食计时减速 → 单趟行程更短)。
    // 只有"出巢驱动"一条通道时验收②的出巢倍率卡在 1.50×: 稳态出巢 = N/(滞留+行程),
    // 滞留已被 rush 压到 0.4s, 瓶颈变成行程 → 再怎么加油门也追不上文献的 ×2–3。
    // rush=1(不抢收)时本项精确为 0 → 恒等路径逐字不变。
    e.urge = clamp(1 + clamp(p.rainUrge === undefined ? 1.5 : p.rainUrge, 0, 6) * rain
      + 2.5 * (1 - e.drive) - 0.5 * (e.rush - 1), 0.2, 8);
    // 冲刷: 衰减指数的时间加速器(雨 + 风), 1 = 不加速
    e.wash = 1 + clamp(p.rainWash || 0, 0, 40) * rain + clamp(p.windWash || 0, 0, 40) * wind;

    // ---- 画面色温: 午夜冷蓝月光 → 晨昏暖金 → 正午白，三段单调插值 ----
    // (旧写法在 light≈0.5 处把 R 抬到 1.28、下一步又跌到 0.70，晨昏出现亮度悬崖 →
    //  改为参考色段 + smoothstep 权重的单调链: 总亮度随光照只增不减。)
    const tw = e.tint;
    const a = ramp(light, 0.5);                        // 午夜(0) → 晨昏(1)
    const b = ramp((light - 0.5) * 2, 1);              // 晨昏(0) → 正午(1)
    const wet = Math.max(rain, 0.5 * wind);            // 雨天: 压暗 + 轻度偏冷
    for (let i = 0; i < 3; i++) {
      const c = NIGHT_C[i] + (GOLDEN_C[i] - NIGHT_C[i]) * a;
      tw[i] = (c + (1 - c) * b) * (1 - (0.32 - 0.11 * i) * wet);
    }
    return e;
  }
}
