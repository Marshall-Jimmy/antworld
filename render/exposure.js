// 自适应曝光（P2.3.2 光污染治理 II 的渲染层腿）：色阶的参考浓度跟随蚁群自己的工作剂量。
//
// 机制理由（为什么固定曝光必然治不好光污染）：
// 同一个 peak=0.35 在两种局面下相差两个数量级——常规玩法 60s 全场最浓的格子只有 0.8×peak，
// 管饱昼间 240s 的「蚂蚁脚下中位剂量」是 135×peak。glow_check 实测：后者让走廊压在色阶顶端
// 5.6 个倍频程处，而雾只比走廊低 2.2 个倍频程 —— 对数肩部把这点差距压成「雾和路一样亮」，
// 于是雾的可见半径长到 17 格（触角只够 3.25 格）。**任何固定 peak 都只能选一边**：调高则常规
// 玩法一片黑，调低则富场糊成一坨。
//
// 生物学依据：昆虫触角的外周感受器会按背景浓度自适应（dynamic range 整体平移），
// 感受的是**相对**差而不是绝对量——这正是 config 里 K_sat 存在的理由（感知饱和常数）。
// 既然蚂蚁的鼻子会跟着剂量平移，替蚂蚁看画面的这块屏幕没有理由钉死在一个绝对浓度上。
//
// 锚点取「蚂蚁脚下的剂量中位数」：不是全场最大值（那是几格热点，会把整体压黑），
// 也不是均值（被热点支配），而是**一半蚂蚁此刻实际闻到的水平**。色阶半亮点钉在这个数的
// GAIN 倍处 ⇒ 走廊永远落在曲线斜坡上最好读的一段，而雾按浓度比自动掉进暗部。
//
// 两条硬约束：
//  1) 只收光不加光 —— effPeak = max(滑杆值, 自适应值)。常规玩法自适应值远低于滑杆，
//     于是主画面与今天**逐位相同**，这条改动不可能把没过曝的场景做亮或做暗。
//  2) 纯渲染层 —— 只读 field/colony，不写任何 sim 状态，不消耗随机流，因此不影响校验和。
//     autoPeak=0 时整个模块直接返回滑杆值，画面逐位不变（门控证明见 METRICS P2.3.2）。
import { values } from "../core/config.js";

// GAIN：半亮点相对「蚁脚中位剂量」的位置。0.5 ⇒ 中位剂量落在 2×peak（tone=0.56，电蓝→亮青之间），
// 走廊最亮的那批格子在 8×peak 附近（tone≈0.69），雾按浓度比落到 0.2 以下（暗蓝）。
// 取 0.5 而不是 1：1 会把走廊整体压进线性段（tone=0.5 封顶），主廊道反而读不出热核。
export const GAIN = 0.5;
const STRIDE = 8;              // 每 8 只蚁采一个样（5000 蚁 → 625 样）：中位数的抖动由下面的死区吸收
const ATTACK = 1.5;            // 秒：需要「收光」时的时间常数。过曝是这张图的主要毛病，所以跟得快
const RELEASE = 6;             // 秒：需要「给光」时慢 4 倍，免得蚁群一进一出就把画面推来推去
const DEADBAND = 0.14;         // 约 1/8 倍频程的死区：目标离当前不到这个相对量就完全不动，消除呼吸感
const CAP = 4096;              // 参考浓度上限：极端堆量下也不许把画面收到看不见

export const exposure = { peak: 0, ref: 0, n: 0 };

let _s = null;                 // 采样缓冲（复用，逐帧零分配）
let _cur = 0;                  // 当前参考浓度（对数域一阶滤波后的值）
let _lastT = -1;

// 重置（重开一局/换参数时调用，避免拿上一窝的曝光看这一窝）
export function resetExposure() { _cur = 0; _lastT = -1; exposure.peak = 0; exposure.ref = 0; exposure.n = 0; }

// simT = 已经跑过的模拟秒数（colony.stepCount/60）。用模拟时间而不是真实帧时间做滤波，
// 否则 4 倍速下曝光会慢四倍跟不上，暂停时又会自己漂走。
export function updateExposure(field, colony, simT) {
  if (!(values.autoPeak > 0.5)) { _cur = 0; _lastT = -1; exposure.peak = 0; exposure.ref = 0; exposure.n = 0; return; }
  let dt = _lastT < 0 ? -1 : simT - _lastT;
  _lastT = simT;
  const m = Math.max(1, Math.ceil(colony.count / STRIDE));
  if (!_s || _s.length !== m) _s = new Float32Array(m);
  let j = 0;
  for (let i = 0; i < colony.count && j < m; i += STRIDE) _s[j++] = field.sample(colony.px[i], colony.py[i]);
  const sub = _s.subarray(0, j);
  sub.sort();
  const ref = sub[j >> 1];
  exposure.ref = ref; exposure.n = j;
  const target = Math.min(CAP, Math.max(values.peak, ref * GAIN));
  if (_cur <= 0 || !(dt > 0) || dt > 1) {
    _cur = target;                       // 首帧/重开/长停顿：直接落位，不从黑场慢慢爬
  } else {
    const ratio = target / _cur;
    if (ratio > 1 + DEADBAND || ratio < 1 / (1 + DEADBAND)) {
      const tau = target > _cur ? ATTACK : RELEASE;
      const k = 1 - Math.exp(-dt / tau);        // 一阶低通系数：dt 越接近 tau 就越接近一步到位
      _cur *= Math.pow(ratio, k);                 // 对数域滤波：log2 上线性靠拢，等效胶片加减档
    }
  }
  exposure.peak = _cur;
}

// 三条渲染路径统一从这里取参考浓度。没调用过 updateExposure（或自动曝光关着）就退回滑杆值，
// 所以「忘了接线」的表现是今天的画面，而不是黑屏——这个方向上的失败是安全的。
export function effPeak() {
  return values.autoPeak > 0.5 && exposure.peak > 0 ? exposure.peak : values.peak;
}
