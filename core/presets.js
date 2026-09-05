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

export const PRESETS = [
  {
    id: 'default',
    name: '默认走廊',
    desc: '一块随种子落位的食源: 看蚁群自己从零铺出一条主走廊',
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
    name: '饥荒生存(P2.5)',
    desc: '一块又远又小的食源 + 能量代谢开启: 看蚁群会不会战略性放弃, 以及种群如何随储备涨缩',
    // P2.4b 交付时 survivalMode 还不存在(它是 P2.5 的机制), 所以这里**不写这个键**——
    // 写了会被 config.clamp 静默丢掉, 面板上也看不到, 等于给用户一个假开关。P2.5 落地后再补。
    // 但布局先给全: 远而小的一块源, 在 P2.4b 阶段就足以演示「粮荒下的路线崩塌」。
    // 和迷宫同一条推导: 这块源离巢约 860u(环面), 一趟下界 51.8s, 而出厂泄压阀是 40s——
    // 不放宽的话「饥荒」读到的是 弃货 398 / 卸货 219, 也就是绝大多数行程被**参数**掐死,
    // 而不是被**食物不够**饿死。P2.5 要研究的是能量, 别让一个比行程还短的超时替它做决定。
    params: { forageTimeout: 120, carryTimeout: 120 },
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
