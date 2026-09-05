// P2.4b · 场景预设: 一套「参数增量 + 世界布局」的具名组合, 一键加载。
//
// 三条设计约束(为什么长这样):
//  1) **默认路径零影响**: 预设只在**显式动作**(下拉/按钮/URL `?preset=`)时才执行。
//     出厂不带 preset ⇒ reset() 走原来的默认走廊, sim 四钉逐位不变(红线 1/2)。
//  2) **坐标用比例不用绝对值**: 世界是环面, 而且 worldW/H 是可调参数。写死绝对坐标
//     会在用户改世界尺寸时把墙糊在巢上; 全部按 W/H 比例给, 再由 brush 半径(世界单位)决定墙厚。
//  3) **只碰布局与行为参数, 不碰结构性参数**(worldW/H、gridCell、antCount)——那些一改就要重建
//     整群蚂蚁和场, 预设的语义是「换一个场景看」, 不是「换一窝蚂蚁」; 重建交给 reset()。
//
// 每个预设的 desc 写「该看什么」而不是「有什么」——预设的目的是让人知道往哪盯。

import { SCHEMA, get, set } from './config.js';

// 墙刷半径(世界单位): 与 app.js 手画墙同一个量级(5~6 格宽)。刻意不用更细的刷:
// 真实蚁挤不过两格宽的斜缝, 细刷出来的墙会在对角缝处漏蚁, 把「绕行」变成「穿墙」的假象。
export const PRESET_BRUSH = 22;

// ---- 出厂默认场景: 野外散粮(P2.4e) ----
// 为什么不再是「一块 200 单位的源」: 那块源在出厂 5000 蚁下**平均几十秒就见底**(对照臂实测
// 10 秒搬空, 见 METRICS P2.4e §2)。后果不是崩溃, 是**验收项在实时画面里等于不存在**: P2.3.5 的
// 「种子被啃出缺口」需要剂量撑得过观察窗口; 高倍速下 HUD 常年读「负重 0」是同一件事的另一个症状。
//
// 剂量为什么按蚁数标定, 以及为什么**每块源各有一个常数**——
// 取食速率不是常数, 往三个方向都会错:
//  ① 爬升期: 网络没成熟时是「搜索受限」, 速率远低于饱和值(第一版拿它标定 ⇒ 算出 890 秒而实测 95 秒见底);
//  ② 振荡: 网络成熟了也稳不住——出厂 5000 蚁自己会在「全力搬运」与「几乎全停」之间来回摆
//     (food_drain_probe: 吞吐 0.09↔137 单位/秒、负重 4↔3210, 周期约 180 秒);
//  ③ 种子方差: 换一颗种子, **全程平均**吞吐能差 6 倍以上(P2.4f 三颗门禁种子实测 45~135 单位/秒),
//     而**饱和期平台**只差 ~1.5 倍(123~198)。平均这个动作同时压低速率、抹平方差, 两头都骗人。
// P2.4e 用**全程平均**(72 单位/秒)标定, 被自己的判据当场否证: 全程平均把最该负责的饱和段摊平了,
// 75,000 单位在两颗门禁种子上 510~630 秒就见底, 连它自己写的「整群口粮 ≥600 秒」都没守住
// (而门禁当时只跑一颗种子, 恰好是「300 秒那一窗读数最低」的那颗——不是「最慢」, 见 METRICS §1 第 3 条),
// 所以它一直绿着。定案过程见 METRICS P2.4f。
// ⇒ 两条改法: (a) 标定基准换成**饱和期平台速率**(实测下沿, 不是严格上界);
//    (b) 两块源各给各的常数, 因为要演的本来就是两个时间窗——
//     近籽负责「快」(两分钟内演完整条生命周期), 主源负责「久」(连吃得最快的种子也得啃 15 分钟以上)。
export const FOOD_NEAR_PER_ANT = 1.35;   // 近籽: 三颗种子实测 100~150 秒见底(「整粒→缺口→消失」看得完)
export const FOOD_MAIN_PER_ANT = 28;     // 主源: 28 ÷ 0.030 = 933 秒, 用平台速率反解出来的「久」;
  //       实测三颗 1,000~1,215 秒见底(见 METRICS P2.4f §2.3), 全部过 900 秒下限
// 饱和期(平台段)实测**下沿**: 150 单位/秒 ÷ 5000 蚁 = 0.030 单位/秒/蚁(三颗平台 123~198 单位/秒)。
// 标定用它, 不用全程平均。⚠ 它不是严格上界——比它快的种子撑不到 933 秒, 那句话由 P1i 的实测兜底。
export const FOOD_RATE_SAT_PER_ANT = 0.030;
export const FOOD_OBS_MIN = 900;         // 判据下限: **主源**至少被啃 15 分钟仿真(上一版钉的是整群口粮 600 秒)
// 兼容旧名字: 出厂**总**剂量 = 两块之和。改蚁数不用改代码(P1f 钉这条算术)。
export const FOOD_UNITS_PER_ANT = FOOD_NEAR_PER_ANT + FOOD_MAIN_PER_ANT;   // = 29.35

// **两块, 不是一块也不是三块**——这个数量是实测定下来的, 不是审美:
//  · 一块: 缺口要长到看得清得等它被啃掉两三成; 而一吃完整张图就空了, 没有生命周期可看。
//  · 三块(本文件的第一版): **赢家通吃**。225,000 单位那一次跑到 810 秒, 近籽已被啃掉 84%,
//    主源与远副源都还停在 100%——一块没人碰的种子摆在场面里, 它那个永远不变的圆比空地更刺眼。
//  · 两块: 近籽先被找到、先被吃完(「整粒 → 缺口 → 吃完了」在两分钟内跑完一遍, P1l 钉这个窗口),
//    然后全群搬到主源, 主源再用十几分钟长缺口(P1i 钉那条时间窗)。两段是**先后发生**的, 所以
//    出厂最招牌的那条单一主走廊仍然只有一条, 不会撕成三条细线。
// 剂量所以是**每块源自己的常数**(P2.4f): 面积决定吞吐速率、剂量决定能吃多久, 而两块源要演的是两个
// 不同的时间窗——一根弦拉不动两台戏, 上一版就是这么把近籽调对了、把主源调没了。
// 两块都沿「巢 → 主源」这条射线摆, 随机流**仍然只消耗两次 r()**——与改动前逐字相同,
// 蚂蚁那侧的随机流一个字节都没有被挪动。
export const DEFAULT_FOOD_SPOTS = [
  { kind: 'near', r: 22, upa: FOOD_NEAR_PER_ANT },   // 6,750 单位 @5000 蚁
  { kind: 'main', r: 32, upa: FOOD_MAIN_PER_ANT },   // 140,000 单位 @5000 蚁
];

// 行程预算(世界单位): 一块源离巢多远才算「蚁够得着」的**必要条件**。
// 为什么必须有这条: 第一版把远副源摆在 1.62× 主源距离 = 733u, 那一次它 540 秒一口没被吃掉。
// 不只是蚁在偏心: carryTimeout=40 秒下 733u 往返要 32 秒, 加上装货 2 秒与巢内磨蹭就超了,
// 于是正在赶路的蚁被当成「死循环」在半路丢了货(那一次 负重 从 2544 掉到 59)。
// 同一件事迷宫与饥荒预设都踩过, 当时的解法是放宽参数迁就场景; 这里选另一条——让场景迁就参数,
// 因为默认视图不该要求用户先弄懂一串超时滑杆, 才知道远处那颗种子为什么没人吃。
// ⚠ 反过来不成立: 预算之内也**未必**吃得到(上一条的赢家通吃就是反例, 那块远籽在预算之内)。
//   所以它被 P1j 钉成「不许摆预算外的种子」, 不是「摆了就一定会被吃」的承诺。
export const TRIP_BUDGET_KEEP = 0.75;   // 只用泄压阀的 75%, 剩下 25% 留给绕路与停顿
export function tripBudget() {
  const secs = get('carryTimeout') * TRIP_BUDGET_KEEP - get('nestDwell') - 1 / get('foodLoadRate');
  return Math.max(40, (secs * get('speed')) / 2);
}
// 某块源走一趟的秒数(判定它够不够得着用; 门禁 P1j 与 buildDefaultFoods 共用这一条式子)
export function tripSeconds(dist) {
  return (2 * dist) / get('speed') + 1 / get('foodLoadRate') + get('nestDwell');
}

// 用户手点一粒种子该给多少: 与出厂**近籽**同一剂量(每蚁 1.35 单位), 因为它要的正是同一件事——
// 几分钟内被啃完并消失。出厂吞吐 150~380 单位/秒之下, 旧的那个 120 单位不到一秒就没了,
// 点了等于没点: 剂量量纲要跟场景一致, 不能各写各的。
export function handFoodDose() {
  return Math.max(60, Math.round(get('antCount') * FOOD_NEAR_PER_ANT));
}

// 往 world 里放出厂散粮; 返回剂量读数, 给 toast 与门禁用(不靠肉眼确认场景生效了)。
// 与预设 layout 不同: 这里不清空世界, 因为它本身就是被 clear() 之后那个默认布局。
export function buildDefaultFoods(world, r, totalOverride) {
  const total = totalOverride > 0 ? totalOverride : Math.round(get('antCount') * FOOD_UNITS_PER_ANT);
  // 巢半径只在 config 里(World 不设这个字段, 它只记 nestX/nestY)。写成 world.nestRadius 会得到
  // undefined, 于是下面那句「不许压巢盘」的保险变成跟 NaN 比大小——**永远不成立也永远不报**。
  // 这一条是 P1h 第一跑逼出来的: 判据抓的是我自己刚写的哑哨兵, 不是既有代码。
  const nestR = get('nestRadius');
  const mx = world.w * (0.55 + r() * 0.2);      // 主源: 出厂原样(巢的右下象限内随机)
  const my = world.h * (0.55 + r() * 0.2);
  const vx = mx - world.nestX, vy = my - world.nestY;
  const mid = Math.hypot(vx, vy) || 1;
  const ux = vx / mid, uy = vy / mid;
  const budget = tripBudget();
  let dose = 0;
  for (const s of DEFAULT_FOOD_SPOTS) {
    // 近籽在主源的一半距离上(出厂参数下主源 100~596u ⇒ 近籽 50~298u, 恒在预算 616u 之内;
    // 那个 min() 管的是用户把世界拉大或把 speed 调低的情况——预算外的种子必然吃不到, 见 tripBudget)
    const dist = s.kind === 'near' ? Math.min(mid * 0.5, budget) : mid;
    let x = world.nestX + ux * dist, y = world.nestY + uy * dist;
    // 界内夹取: 环面上「种子从对侧露出来」看着像 bug 而不是特性, 宁可靠巢也不出界
    x = Math.min(world.w - s.r - 2, Math.max(s.r + 2, x));
    y = Math.min(world.h - s.r - 2, Math.max(s.r + 2, y));
    // 不压巢盘: 一粒种子糊在巢门口, 「觅食」就没有距离可言了
    const d = Math.hypot(x - world.nestX, y - world.nestY);
    const minD = nestR + s.r + 8;
    if (d < minD) {
      const k = d > 1e-6 ? minD / d : minD / 1;
      x = world.nestX + (x - world.nestX) * k;
      y = world.nestY + (y - world.nestY) * k;
      // 推出巢盘之后再夹一次界(极端参数下两个约束会打架: 世界很小而 nestRadius 很大,
      // 那时「界内」优先——出厂参数下永远走不到这里, P1h 钉的就是出厂这一支)。
      x = Math.min(world.w - s.r - 2, Math.max(s.r + 2, x));
      y = Math.min(world.h - s.r - 2, Math.max(s.r + 2, y));
    }
    // total 覆盖(?food=N)时按出厂比例切两块, 不改变「近籽快、主源久」这个剧本
    const amount = Math.max(8, Math.round(total * s.upa / FOOD_UNITS_PER_ANT));
    world.addFood(x, y, s.r, amount);
    dose += amount;
  }
  return { total, dose };
}

export const PRESETS = [
  {
    id: 'default',
    name: '默认走廊',
    desc: '一近一主两块随种子落位的种子: 看蚁群自己从零铺出一条主走廊',
    params: {},
    layout: null,           // null = 保持 reset() 的默认布局(一个字节都不改)
  },
  {
    id: 'maze',
    name: '迷宫(P2.1)',
    desc: '四片交替锚顶/锚底的梳齿墙: 看信息素如何翻过几何障碍选出通道',
    // 两条超时都要放宽, 而且要**跟着场景几何走**:
    //  ① forageTimeout(空手觅食超时): 迷宫里空手找出口本来就要绕好几片梳齿, 出厂 30s 直接判死;
    //  ② carryTimeout(负重超时泄压阀): 这条是 preset_check 第一跑逼出来的——出厂 40s 下蚁群
    //     42.2s 就找到了食物(判据 P5 的 foundAt), 但**一趟 0 次卸货、21 次弃货**:
    //     负重蚁凭航位推算的回家向量是**穿墙直指巢心**的, 在梳齿之间它必须绕行, 绕一段就要几十秒。
    //     于是 40s 的泄压阀把「正在绕行」当成了「死循环」, 在半路把货丢在走廊中间。
    //     这不是蚁群不会走迷宫, 是场景参数比场景本身短——泄压阀的值必须大于场景的最长合法行程。
    params: { forageTimeout: 120, carryTimeout: 120 },
    layout: (w, h) => ({
      walls: [
        [0.26, 0.00, 0.26, 0.58],
        [0.46, 1.00, 0.46, 0.30],
        [0.66, 0.00, 0.66, 0.58],
        [0.86, 1.00, 0.86, 0.30],
      ],
      // 食源从 0.93 往里挪到 0.90 并加厚(3000 单位): 出口那一格是整张图最挤的地方,
      // 太薄的源会在被找到后几秒内掏空, 于是「走通迷宫」这件事在曲线上只留一个尖峰, 看不出结构。
      foods: [{ fx: 0.90, fy: 0.50, r: 32, amount: 3000 }],
    }),
  },
  {
    id: 'twoSource',
    name: '双源竞争',
    desc: '近处小源 vs 远处 10 倍大源: 看群体如何在「省事」与「值得」之间分票',
    // 远源要 60s 一趟, 默认 30s 超时会让它永远开不出来(那不是取舍, 是判据把选项删了)。
    params: { forageTimeout: 90 },
    layout: (w, h) => ({
      walls: [],
      foods: [
        { fx: 0.62, fy: 0.62, r: 26, amount: 800 },    // 近: 绕回距离约 0.17W
        { fx: 0.16, fy: 0.16, r: 40, amount: 8000 },   // 远: 约 0.48W(环面两轴都算最近)
      ],
    }),
  },

  {
    id: 'breakpoint',
    name: '断口剂量',
    desc: '一堵横墙开三个断口(宽 40/120/240u), 每个断口后一块等量食源: 看群体把走廊灌进哪个口',
    params: { forageTimeout: 90 },
    // 断口宽度按**净宽**给(30/100/220 世界单位≈4/12/28 格), 再按刷径补回两端被刷子吃掉的部分:
    // 画笔沿断口两端各覆盖一个半径, 直接按名义宽度画会让最窄那个口被刷子糊死。
    layout: (w, h) => {
      const chans = [30, 100, 220];
      const centers = [0.20, 0.50, 0.80];
      const Y = 0.74;
      const segs = [];
      let x = 0;
      for (let i = 0; i < centers.length; i++) {
        const half = (chans[i] / 2 + PRESET_BRUSH) / w;   // 半宽(比例): 净宽一半 + 刷子吃进去的一格半径
        segs.push([x, centers[i] - half]);
        x = centers[i] + half;
      }
      segs.push([x, 1]);
      return {
        walls: segs.filter((s) => s[1] > s[0] + 1e-9).map((s) => [s[0], Y, s[1], Y]),
        foods: centers.map((fx) => ({ fx, fy: 0.90, r: 26, amount: 1200 })),
      };
    },
  },
  {
    id: 'famine',
    name: '饥荒生存',
    desc: '一块又远又小的食源 + 能量代谢开启: 看蚁群会不会战略性放弃, 以及种群如何随储备涨缩',
    // P2.4b 交付时 survivalMode 还不存在, 所以当时这里**故意不写这个键**——写了会被 config.clamp
    // 静默丢掉, 面板上也看不到, 等于给用户一个假开关。P2.5 已落地 ⇒ 现在补上, 这个预设才真的会饿死人。
    // 和迷宫同一条推导: 这块源离巢约 860u(环面), 一趟下界 51.8s, 而出厂泄压阀是 40s——
    // 不放宽的话「饥荒」读到的是 弃货 398 / 卸货 219, 也就是绝大多数行程被**参数**掐死,
    // 而不是被**食物不够**饿死。P2.5 要研究的是能量, 别让一个比行程还短的超时替它做决定。
    params: { forageTimeout: 120, carryTimeout: 120, survivalMode: 1 },
    layout: (w, h) => ({
      walls: [],
      foods: [{ fx: 0.86, fy: 0.14, r: 20, amount: 260 }],
    }),
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

// ---- 参数增量的「可撤销」应用 ----
// 上一个预设改过的键, 在换预设前先退回改之前的值。为什么: 预设的语义是「换一个场景」,
// 如果 maze 把 forageTimeout 调到 60, 切到 twoSource 之后这个 60 会悄悄留着,
// 于是「双源竞争」跑的其实是上一个场景的参数——预设变成参数累积器, 复现就没了。
let baseline = null;

export function applyPresetParams(id) {
  const preset = presetById(id);
  if (baseline) {
    for (const k of Object.keys(baseline)) set(k, baseline[k]);
  }
  baseline = null;
  if (!preset || !preset.params) return [];
  const known = new Set(SCHEMA.map((s) => s.key));
  const applied = [];
  const saved = {};
  for (const k of Object.keys(preset.params)) {
    if (!known.has(k)) continue;      // 未注册的键不写进 baseline, 否则会造出一个撤不掉的幽灵
    saved[k] = get(k);
    set(k, preset.params[k]);
    applied.push(k);
  }
  baseline = saved;
  return applied;
}

export function presetBaseline() { return baseline ? { ...baseline } : null; }

// ---- 世界布局 ----
// 沿直线按 brush/2 采样补点(与 app.js 手画墙的插值同一语义): 快速长线段不会留斜向断口。
function paintSegment(world, x0, y0, x1, y1, brush) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / (brush * 0.5)));
  for (let k = 0; k <= steps; k++) {
    world.paintWall(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps, brush, true);
  }
}

// 返回一份读数摘要(墙格数/食源数/总剂量), 门禁与 toast 都用它——**不要**让用户靠肉眼确认预设生效了。
export function buildPresetWorld(id, world) {
  const preset = presetById(id);
  if (!preset || !preset.layout) {
    return { id, applied: false, wallCount: world.wallCount, foods: world.foodPatches.length, dose: 0 };
  }
  const spec = preset.layout(world.w, world.h);
  world.clear();                 // 清掉 reset() 默认那块食源: 预设场景里不该有来路不明的第四块源
  world.clearWalls();
  for (const seg of spec.walls || []) {
    paintSegment(world, seg[0] * world.w, seg[1] * world.h, seg[2] * world.w, seg[3] * world.h, PRESET_BRUSH);
  }
  let dose = 0;
  for (const f of spec.foods || []) {
    world.addFood(f.fx * world.w, f.fy * world.h, f.r, f.amount);
    dose += f.amount;
  }
  return { id, applied: true, wallCount: world.wallCount, foods: world.foodPatches.length, dose };
}
