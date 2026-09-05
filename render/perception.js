// 侧抑制背景减除（P2.3.4 光污染 III）——把「场里有多少化学物质」换成「蚂蚁的鼻子分得出多少」。
//
// 为什么还要第三轮治光污染（前两轮的成绩与天花板）：
//   P2.3.1 把色阶改成有界对数上肩（不再截断成白）；P2.3.2 把扩散长度压回触角尺度 + 曝光锚点跟
//   蚁脚剂量走。三种子复测：离路>触角的那些格子仍发出全图 7.6% 的光（相对旧色阶已是 0.20×）。
//   更关键的是**靠曝光已经压不动**：同一份场数据把曝光乘数从 ×1 加到 ×4，死光只从 5.4% 降到 4.4%，
//   走廊可辨级数却从 85 塌到 25——继续收光只会把画面整体抹平，治不了病。
//   ⇒ 残留的雾不是「太亮」，而是它在空间上是**共模的**：一大片缓变的背景，任何蚂蚁都从里面读不出
//     方向，却和走廊一样占着亮度预算。这种信号要靠「减掉局部平均」才压得掉，而恰好——
//
// 真实昆虫嗅觉就是这么干的（本模块的生物学依据，同时记进 docs/ANT_BIOLOGY.md 与 METRICS）：
//   1) Olsen & Wilson 2008, Nature 452(7190):956-960, doi:10.1038/nature06864「Lateral presynaptic
//      inhibition mediates gain control in an olfactory circuit」(PMID 18344978)：果蝇触角叶里的
//      侧抑制压在**嗅觉传入神经末梢上**做增益控制——「邻居们都在响」那份共模被压掉，只有相对差
//      能往下传。这正是「减局部平均」的神经学原型。
//   2) Kim & Wang 2009, J Biol 8(1):4「Lateral inhibition and concentration-invariant odor
//      perception」(PMID 19216732)：侧抑制是**浓度不变性**的来源之一——同一团气味在不同绝对浓度下
//      要被认成同一个东西，靠的正是除掉共模尺度。⇒ 显示「差」而不是「量」不是美术加工。
//   3) Draft, McGill, Kapoor & Murthy 2018, J Exp Biol 221(Pt 22):jeb185124,
//      doi:10.1242/jeb.185124「Carpenter ants use diverse antennae sampling strategies to track
//      odor trails」(PMID 30266788)：弓背蚁循迹时两根触角反复**跨轨迹边缘采样**(左右之差)来决定
//      下一步转向 ⇒ 那才是这只蚂蚁真正用来导航的量；显示「每格有多少分子」是替它回答它没问的问题
//      (与 P2.3.2 的 ℓ≤触角同一条思路)。
//   ※ 引用纪律：以上三条 2026-09-05 逐条对 NCBI PubMed 核到作者/年份/卷期页/PMID。上一轮这里写的
//     「Bahrey & Wilson 2004 Nature 452:246」与「Draft, Burd-Field, Kain & Graham 2018」**都是错的**
//     （前者作者与年份全记岔，后者的中间三位作者姓是凭印象编的）；另有一条「Galizia & Szyszka,
//     J Comp Physiol A 综述」查无实据，已删。作废过程同步记在 METRICS P2.3.4 §2——与本项目
//     「旧数字掺假要大声作废」是同一条纪律，只是这次掺假的是文献而不是数据。
//
// 抑制环的半径不新增旋钮，由触角长度派生：round(sensorDist 26u / gridCell 8u) = **3 格**。
//   巧合得很扎实：dw=0.02 时信息素云的衰减长度 ℓ=25.1u = 3.14 格——两条独立推导撞上同一个数，
//   都指向「比触角更宽的均匀场没有方向信息」。
//   用**环**（半径恰为 R 的那一圈，8R 个格）而不是实心盒做周边，是为了给走廊留活路。三档差别解析
//   可推，而且已被合成门禁逐位核过（node perception_check.mjs 的 ③④ 组，秒级、不跑 sim）：
//     · ③a 孤立方核（边长 ≤ 2R−1）：环上无物 ⇒ 环式**一分不掉**；盒式 = 1−K(2h+1)²/(2R+1)²
//         ⇒ K=0.5 时 5×5 的一堆残迹只剩 74.5%。
//     · ③b 又长又直的走廊（宽 w ≤ 2R−1）：环 = 1−K·w/(4R)、盒 = 1−K·w/(2R+1)
//         ⇒ w=5、K=0.5 时环保 79.2% / 盒保 64.3%（盒比环多砍 19%）。
//         **别把它读成「环对走廊不动」**：走廊自己在触角方向上就占掉环的 w/(4R)——站在路上的
//         蚂蚁看得见路往前延伸，这是物理不是 bug。
//     · ④ 宽 ≥ 2R+1(=7 格) 且内部均匀的板：两种都减到 c(1−K)，K=1 归零。
//   最后一档不是 bug，正是本模块的语义：**比触角还宽、内部又均匀的一片，蚂蚁从里面读不出任何方向
//   信息**，它该暗。真场上这一步差多少：v1 扫描里同锚点、K=1 的三种子原文，盒式走廊
//   0.077/0.076/0.076 vs 环式 0.114/0.105/0.111（盒只剩环的 0.67×）⇒ 只引逐种子原文，v1 的聚合表
//   自相矛盾（同一对读数的两行聚合差 2.4×），见 METRICS P2.3.4 §5 更正(4)。
//   半径这个派生量确实在起作用：③c 把同一张场的半径从 3 覆写成 1，宽 3 的走廊立刻 87.5% → 0%。
//
// 为什么减在**线性浓度域**（tone 之前）：侧抑制发生在感受器末梢、饱和之前（外周增益控制），
//   而 tone() 里那条对数已经是更高层的压缩。在 log 域减法 = 在线性域做除法（Weber 比），
//   会和 tone 的对数重复补偿同一个东西，参数 K 也就失去可解释性。
//
// 两条硬约束（与 render/exposure.js 同一条纪律）：
//   1) **纯渲染层**：只读 field.buf，不写任何 sim 状态、不掷随机数 ⇒ 校验和不可能受影响。
//   2) **门控 = 逐字节不变**：lateralK ≤ 0 时**直接返回 field.buf 这一个数组对象本身**，连拷贝都不做
//      ⇒ 三条渲染路径（WebGL2 / Canvas2D / PNG）的输出与今天逐字节相同。这是可证明的，不是「看起来没变」。
//
// 代价（必须如实记，不许藏着）：凡是「空间上大范围缓变的积累」都会变暗甚至消失——探索网、
//   巢周的老堆、雨后的均匀场都在此列。这是设计意图的另一面，判据压不住它，靠出图肉眼裁决。
import { values } from "../core/config.js";

// 诊断出口：HUD / render_png 的统计行可以读它，确认「这一帧到底减没减、按下的半径是几」。
export const perception = { on: false, radius: 0, cells: 0 };

// 环半径（格）：派生量，不是自由度。夹到 [1, 半格数) 以免窗口自重叠（环面寻址下会重复计数）。
export function lateralRadius(field) {
  const cell = field.cellSize || 8;
  let r = Math.round(values.sensorDist / cell);
  if (!(r >= 1)) r = 1;
  const cap = Math.min(field.gw, field.gh) >> 1;
  if (r >= cap) r = Math.max(1, cap - 1);
  return r;
}

// 逐帧复用的缓冲（零分配红线：4 万个格，一次分配到位）
let _tmp = null;      // 盒式滑窗的行向中间量
let _outer = null;    // 盒(半径 r) 的和
let _inner = null;    // 盒(半径 r−1) 的和 ⇒ 两者之差 = 环，且自动不含中心格
let _out = null;      // 显示量 v'（Float32：要直接喂给 texSubImage2D(gl.FLOAT)，与 field.buf 同类型）

function ensureBuffers(n) {
  if (!_tmp || _tmp.length !== n) {
    // 三份和缓冲用 Float64：滑窗是「加一项减一项」的累积过程，存成 Float32 会白送显示误差——实测
    // （perception_check.mjs ⑥：41×41、浓度 0–50、K=0.5）最大偏差 3.81e-6 绝对 / 9.0e-8 相对。
    // 和的绝对上界 = (2R+1)²×浓度 = 49×浓度，Float32 那 7 位有效数字在这个量级上不够看。
    // （旧注释这里写的是「合成用例 ⑤ 从逐位一致退到 8.9e-8」：那个脚本在本轮开工时**并不存在**，
    //   数字无从复核。现在这一行是当场可复现的；相对误差恰好也是 9e-8 量级，可见旧数字是相对口径，
    //   但口径没写清楚 = 不可用。以后写误差必须同时写绝对值和分母。）
    _tmp = new Float64Array(n); _outer = new Float64Array(n); _inner = new Float64Array(n);
    _out = new Float32Array(n);
  }
}

// 环面寻址的 (2r+1)² 盒式和，可分离：先横后竖各一趟滑窗 ⇒ O(n)，与 r 无关。
// 为什么不用前缀和：前缀和在环面上要分「跨界/不跨界」两支，代码翻倍还容易错；滑窗只要两个游标。
function boxSum(src, gw, gh, r, tmp, out) {
  const n = gw * gh;
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + (((x % gw) + gw) % gw)];
    // x=0 的窗口是 [-r, r]；滑到 x=1 要进 r+1、出 -r（环形游标，r < gw 所以一次归位就够）
    let e = r + 1; if (e >= gw) e -= gw;
    let l = gw - r; if (l >= gw) l -= gw;
    for (let x = 0; x < gw; x++) {
      tmp[row + x] = s;
      s += src[row + e] - src[row + l];
      if (++e === gw) e = 0;
      if (++l === gw) l = 0;
    }
  }
  for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[(((y % gh) + gh) % gh) * gw + x];
    let e = (r + 1) * gw + x;
    let l = (gh - r) * gw + x;
    for (let y = 0; y < gh; y++) {
      out[y * gw + x] = s;
      s += tmp[e] - tmp[l];
      e += gw; if (e >= n) e -= n;
      l += gw; if (l >= n) l -= n;
    }
  }
}

// 实心盒(半径 r) 的平均值，含中心格。**只有 lateral_probe 的敏感性对照会调它**——产品路径一律走环式。
// 留着是因为「选环不选盒」这个决定必须有数据支撑，不能只靠上面那段分析。
export function boxMean(field, r, dst) {
  ensureBuffers(field.gw * field.gh);
  boxSum(field.buf, field.gw, field.gh, r, _tmp, dst);
  const c = (2 * r + 1) * (2 * r + 1);
  for (let i = 0; i < dst.length; i++) dst[i] /= c;
  return dst;
}

// 「给屏幕看的那份场」。lateralK=0 ⇒ 原样返回 field.buf（门控的逐字节证明就在这三行里）。
// rOverride 只给 lateral_probe 做半径敏感性检查用，产品路径一律不传 ⇒ 半径永远是触角派生值。
export function perceivedField(field, rOverride) {
  const k = values.lateralK;
  if (!(k > 0)) { perception.on = false; perception.radius = 0; return field.buf; }
  perception.on = true;

  const gw = field.gw, gh = field.gh, n = gw * gh;
  ensureBuffers(n);
  const cap = Math.min(gw, gh) >> 1;
  let r = rOverride > 0 ? (rOverride | 0) : lateralRadius(field);
  if (r >= cap) r = Math.max(1, cap - 1);
  perception.radius = r;

  // 环 = 盒(r) − 盒(r−1)。中心格同时属于两个盒 ⇒ 相减之后自动被排除，这正是 center-surround 要的
  // （否则一根孤立的热点会被自己减掉一截，等于凭空发明一种「越孤立越暗」的毛病）。
  boxSum(field.buf, gw, gh, r, _tmp, _outer);
  boxSum(field.buf, gw, gh, r - 1, _tmp, _inner);
  const inv = 1 / (8 * r);
  const src = field.buf;
  let lit = 0;
  for (let i = 0; i < n; i++) {
    const bg = (_outer[i] - _inner[i]) * inv;
    const v = src[i] - k * bg;
    if (v > 0) { _out[i] = v; lit++; } else _out[i] = 0;
  }
  perception.cells = lit;
  return _out;
}

// 「这一帧该画哪个场对象」——渲染层与曝光锚点**共用同一个返回值**，这是本阶段的接线要点：
//   为什么不是把数组传来传去，而是包一层对象：Field.sample() 的双线性插值与环面寻址只有一份实现，
//   显示路径(WebGL 上传 buf / Canvas2D 逐格取 buf)和锚点路径(蚁脚剂量 sample)必须共用它，
//   否则又会出两份定义——那正是 P2.3.1 教训15 的病灶(三条路径各写一套色阶常数)。
//   Object.create(field) 造出来的壳：gw/gh/w/h/cellSize/sample 全部沿原型链落到真场上，
//   只有 buf 是被遮住的那一格 ⇒ "改的是显示量，动不到 sim 一根毫毛"。
//   lateralK=0 时**连壳都不造**，直接返回原对象 ⇒ 下游每条代码路径逐字不变。
let _disp = null;
export function displayField(field, rOverride) {
  const arr = perceivedField(field, rOverride);
  if (arr === field.buf) return field;
  if (!_disp || Object.getPrototypeOf(_disp) !== field) _disp = Object.create(field);
  _disp.buf = arr;
  return _disp;
}

// 换一局/换世界尺寸时不必显式调用：本模块没有跨帧状态（缓冲按长度复用，输出纯函数于输入）。
// 留个空壳是给 HUD 复位用的，也方便将来加统计量时不至于没有落点。
export function resetPerception() { perception.on = false; perception.radius = 0; perception.cells = 0; }