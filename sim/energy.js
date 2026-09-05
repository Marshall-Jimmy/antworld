// P2.5 · 能量与生死的**纯模型**：只有数学与推导，不持状态、不碰数组、不掷随机数。
// 结算全部在 sim/colony.js 里(它持有 SoA 数组和自己的随机流)，这样 ant.js 一个字都不必改
// ——导航是"怎么动"，能量是"还动不动得了"，两层混在一起会让基线校验和失去意义。
//
// 生物学依据一律指向 docs/ANT_BIOLOGY.md §四(那一份的引用已核实并附 URL，本文件不另立新引用)。
// 三条落地事实与它们怎么变成参数：
//
// ① **外勤折寿**：Cataglyphis bicolor 开外勤后期望寿命仅 6.1 天，而巢内可活数月；
//    P. badius 外勤后 ~1 个月 vs 实验室 ~200 天。⇒ 折旧只按**累计外勤秒**(workT)走，巢内不折旧。
//    时间压缩：本项目 dayLength=240 s 表示一个昼夜，即 1 天 = 240 s ⇒
//    workLife 出厂 = 6.1 × 240 ≈ **1460 s**。真实"巢内/外勤折旧比 ~20–30×"在本模型里表现为
//    "巢内 workT 不涨"这一条(比值不是参数，因为它作用在同一个折旧率的两档上，取一档为 0 即无参数)。
//
// ② **分布形状**：工蚁死亡是"衰老+损耗"叠加，风险率随龄上升而非恒定 ⇒ 用 Weibull(形状 k>1)
//    而不是指数。取 k=3(常数记在 WEAR_SHAPE，不做成参数：滑杆上没人能分辨 k=2 与 k=4，
//    但它决定了"集体同一天全死"还是"细水长流"，写死比可调更诚实)。
//    期望寿命 = η·Γ(1+1/k)，k=3 时 Γ(4/3)=0.892997 ⇒ η = workLife/0.892997。
//    这样 **workLife 这个参数的含义就是"期望外勤寿命"**，不用解释特征寿命。
//
// ③ **搬运经济**：成功一趟的能量收益 ≈ 路途成本 ~100 倍(Weier & Feener 1995，见 §四)——
//    真实切叶蚁搬回的生物量绝大部分喂菌圃，工蚁自己取食的只是零头。⇒ 兑换比必须远大于 1。
//    标定(speed=46 u/s，default 走廊巢–源 ≈286 u ⇒ 往返 598 u ≈ 13 s)：
//      一趟代谢成本 = 空手 299×metWalk + 负重 299×metLoad + 13×metBasal
//               = 299×1.5e-4 + 299×3.0e-4 + 13×2e-3 = 0.045 + 0.090 + 0.026 = **0.161 能量**
//      一载入库 = 1 食物单位 = cropFood=30 能量 ⇒ 收益/成本 = 30/0.161 ≈ **186×**(§四 的"~100 倍"量级)
//    5000 蚁连续外勤的需求 = 5000×0.161/13 ≈ 62 能量/s ≈ **2.1 食物/s**；
//    而 perf 场景实测入库 ≈12.5 食物/s ⇒ **储备必然饱和**，所以 storageCap 与 overflow 是必需的，
//    不是装饰(没有上限时储备会以 10 食物/s 涨到无穷，"饥荒"就永远测不出来)。
//
// ⚠ 一条必须交底的结构性事实：**默认走廊只有 200 单位食源**(app.js)，5000 只蚁分 ⇒
//   平均每只 0.04 单位 ≈ 一次都用不上 ⇒ 默认场景开 survivalMode 必然缩员。这不是 bug 是发现，
//   已在 METRICS P2.5 里量过；"自我维持"的验收必须在大剂量食源下做(preset dose / ?food=)。

export const ENERGY_FULL = 1;      // 满胃 = 1 能量(个体能量的显示与计算单位)
export const WEAR_SHAPE = 3;       // Weibull 形状因子 k(见文件头 ②)
const GAMMA_1_PLUS_1K = 0.892996;  // Γ(1+1/3)：把"期望寿命"换算成 Weibull 的 η

// 折寿风险率的掷骰节拍(步)：每只蚁每 32 步才掷一次。
// 为什么要省：5000 蚁 × 每步一次 exp ≈ 每步 5000 次超越函数，而这正是 P2.6 之前 CPU 最贵的地方。
// 32 步 = 0.53 s 仿真时间，而 hazard 在分钟尺度上才动，采样定理上绰绰有余。
export const WEAR_ROLL_EVERY = 32;

export function etaFromMean(workLife) {
  return workLife / GAMMA_1_PLUS_1K;
}

// 瞬时风险率(1/秒)。age 已经是"该蚁自己的期望尺度折算过的"外勤年龄。
export function wearHazard(ageSec, workLife) {
  const eta = etaFromMean(workLife);
  const z = ageSec / eta;
  // k=3 ⇒ 指数是 2, 直接乘。写 Math.pow(z, WEAR_SHAPE - 1) 是"更通用"的写法, 但 pow 是超越函数,
  // 而这条在生死开着时是每 32 步/蚁都要跑的(5000 蚁实测整块 +50% 单步成本, 见 METRICS P2.5 §6)。
  // 换形状因子就要同时换这里——所以 WEAR_SHAPE 是常数而不是参数, 这条才有资格写死。
  return (WEAR_SHAPE / eta) * (WEAR_SHAPE === 3 ? z * z : Math.pow(z, WEAR_SHAPE - 1));
}

// 一次掷骰(跨度 rollDt 秒)的死亡概率：1 − exp(−h·rollDt)。
// 用 1−exp 而不是 h·dt 的线性近似：h·dt 在寿命末期会 >1(概率不能大于 1)，线性近似就悄悄失真。
export function wearRollP(ageSec, workLife, rollDt) {
  const h = wearHazard(ageSec, workLife);
  return 1 - Math.exp(-h * rollDt);
}

// 个体寿命散布(±30%)：**不消耗任何随机流**，从该蚁出生就固定的 seedNoise 派生。
// seedNoise 的 32 位已经被 speedMul/turnMul/depMul 用完了(MEM 见 colony 构造)，所以先过一次
// splitmix32 终函数把它们搅成一个新数，再取低 12 位——同一个 seed 永远得同一个倍率(可复现)，
// 而"这一只比平均长寿 20%"和"这一只跑得快"之间不会相关(两个位段来自不同的搅动)。
export function lifeScale(noise) {
  let z = (noise >>> 0) + 0x9e3779b9;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  return 0.7 + (z & 4095) / 4095 * 0.6;
}

// 储备账(质量守恒)的一行摘要，给 HUD 与门禁同一个口径。
export function reserveLedger(colony) {
  const expect = colony.inflow - colony.foodEaten - colony.birthFood - colony.overflow;
  return { expect, actual: colony.reserve, err: colony.reserve - expect };
}
