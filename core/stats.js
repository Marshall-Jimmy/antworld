// P2.4b · 统计滑窗(纯数据结构: 无 DOM / 无渲染 / 不掷随机数)。
//
// 为什么单独一个文件: 曲线是**量具**。量具一旦和渲染或 DOM 混在一起写, 就会出现「看着在测、
// 其实没测」的行(红线第⑩条)。这里只有环形缓冲和读数, stats/preset 门禁能对每条断言。
//
// 三条采样纪律(逐条钉在 stats_check.mjs):
//  1) **只读**: 采样不写 colony/world 任何字段, 不消耗随机流(铁律 4)。这是本模块唯一要紧的
//     正确性属性——开着曲线跑仿真, 四钉校验和必须逐位不变(perf_check 复核)。
//  2) **定窗**: 滑窗固定 cap 个样本(默认 60 个 × 每 1 秒一个 = 最近 60 秒)。窗口外的读数被覆盖,
//     不做「全生命周期平均」——那会把十分钟前的旧习惯算进今天的曲线里。
//  3) **分清量纲**: 卸货/弃货/空手返巢是**累加计数器**, 曲线量的是「窗内增量 ÷ 窗长(秒)」= 速率;
//     负重数/种群/田外存粮是**瞬时量**, 曲线取窗内均值。把这两类混在同一个刻度上是 sparkline
//     最常见的谎(累加器画出来永远是一条单调上升的直线, 看着像「一切都在变好」)。

export class Ring {
  constructor(cap) {
    this.cap = cap | 0;
    this.buf = new Float64Array(this.cap);
    this.n = 0;      // 已写入的样本数(≤cap)
    this.head = 0;   // 下一个写入位置
  }

  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }

  // i=0 是最旧的样本, i=n-1 是最新的。窗口没写满时前面不留空位——
  // 否则曲线开头会出现一段假的 0(看起来像「曾经一片空白」)。
  at(i) {
    if (i < 0 || i >= this.n) return 0;
    return this.buf[this._start(i)];
  }

  _start(i) { return (this.head - this.n + this.cap + i) % this.cap; }

  last() { return this.n ? this.buf[(this.head - 1 + this.cap) % this.cap] : 0; }
  full() { return this.n === this.cap; }

  min() { let m = Infinity; for (let i = 0; i < this.n; i++) { const v = this.buf[this._start(i)]; if (v < m) m = v; } return this.n ? m : 0; }
  max() { let m = -Infinity; for (let i = 0; i < this.n; i++) { const v = this.buf[this._start(i)]; if (v > m) m = v; } return this.n ? m : 0; }
  sum() { let s = 0; for (let i = 0; i < this.n; i++) s += this.buf[this._start(i)]; return s; }
  mean() { return this.n ? this.sum() / this.n : 0; }

  clear() { this.n = 0; this.head = 0; this.buf.fill(0); }
}

// 曲线定义。kind: rate=计数器增量÷窗长(次/秒), mean=瞬时量窗内均值。
// 前四条是 P2.4b 的主角; 后三条现在就是平线, 它们是 P2.5(能量与生死)要用的那两条腿。
export const METRIC_DEFS = [
  { key: 'del',  label: '卸货率',   unit: '次/秒', kind: 'rate' },
  { key: 'load', label: '负重数',   unit: '只',   kind: 'mean' },
  { key: 'ab',   label: '空手返巢', unit: '次/秒', kind: 'rate' },
  { key: 'to',   label: '弃货',     unit: '次/秒', kind: 'rate' },
  { key: 'kill', label: '被捕杀',   unit: '次/秒', kind: 'rate' },
  { key: 'pop',  label: '种群',     unit: '只',   kind: 'mean' },
  { key: 'food', label: '田外存粮', unit: '单位', kind: 'mean' },
];

// 田外存粮: 世界里还没被搬走的食源余量(所有斑块 amount 之和)。只读。
export function foodTotal(world) {
  const p = world.foodPatches;
  let s = 0;
  for (let i = 0; i < p.length; i++) if (p[i].amount > 0) s += p[i].amount;
  return s;
}

export class ColonyStats {
  constructor({ stepHz = 60, periodSec = 1, cap = 60 } = {}) {
    this.stepHz = stepHz;
    this.periodSec = periodSec;
    this.every = Math.max(1, Math.round(stepHz * periodSec));
    this.cap = cap;
    this.rings = {};
    this._acc = {};
    for (const d of METRIC_DEFS) this.rings[d.key] = new Ring(cap);
    this.prev = null;
    this._k = 0;
    this._zeroAcc();
    // 样本版本号: 每吐出一个样本 +1, reset() 也 +1。
    // 为什么要有它: 曲线面板/文本读数都想知道「这一秒到底有没有新样本」, 好据此决定要不要重画。
    // 靠比对缓冲区内容来判断迟早会写成「取一个恰好会变的字段当指纹」——那是假指纹(内容相同、
    // 含义不同的情况真实存在: 一整年不变的卸货率就该完全不重画)。版本号是唯一诚实的失效信号。
    this.version = 0;
  }

  _zeroAcc() {
    for (const d of METRIC_DEFS) this._acc[d.key] = 0;
    this._k = 0;
  }

  _snap(colony) {
    return { del: colony.deliveries, to: colony.timeouts, ab: colony.aborts, kill: colony.kills };
  }

  reset() {
    for (const d of METRIC_DEFS) this.rings[d.key].clear();
    this.prev = null;
    this._zeroAcc();
    this.version++;
  }

  // 每个逻辑步调用一次(app 的 step() 末尾)。攒满 every 步才产出一个样本 ⇒ 平摊成本 ≈ 0。
  // 返回 true = 这一步吐出了一个新样本(HUD/曲线据此决定要不要重画)。
  sample(colony, world) {
    if (!colony) return false;
    if (!this.prev) this.prev = this._snap(colony);
    this._acc.load += colony.loadedCount();
    this._acc.pop += colony.count;
    this._acc.food += world ? foodTotal(world) : 0;
    this._k++;
    if (this._k < this.every) return false;

    const k = this._k, secs = k / this.stepHz, p = this.prev, R = this.rings;
    R.del.push((colony.deliveries - p.del) / secs);
    R.to.push((colony.timeouts - p.to) / secs);
    R.ab.push((colony.aborts - p.ab) / secs);
    R.kill.push((colony.kills - p.kill) / secs);
    R.load.push(this._acc.load / k);
    R.pop.push(this._acc.pop / k);
    R.food.push(this._acc.food / k);
    this.prev = this._snap(colony);
    this._zeroAcc();
    this.version++;
    return true;
  }

  // 读数(给 HUD 与门禁共用一份, 免得两边各算一遍算出两个数)
  get(key) { return this.rings[key]; }

  label(key, digits = 1) {
    const r = this.rings[key];
    const d = METRIC_DEFS.find((x) => x.key === key);
    if (!r || !r.n) return '—';
    const v = r.last();
    return (d && d.kind === 'mean' ? v.toFixed(0) : v.toFixed(digits));
  }
}

export const SPARK_GLYPHS = '▁▂▄▆█';

// 文本 sparkline(单行高, 适合塞进状态条)。
// ref>0 ⇒ 按固定刻度归一(跨时刻可比);否则按窗内 max 归一(看「最近这一分钟的形状」)。
// 为什么两种都要: 只用窗内 max 时, 一条完全平直的线会因为某个偶然尖峰而被画成大峡谷;
// 只用固定刻度时, 慢变量(种群)整条线会平得看不出任何变化。
export function spark(ring, width = 40, ref = 0) {
  const n = ring.n;
  if (!n) return '';
  const scale = ref > 0 ? ref : ring.max();
  const start = n > width ? n - width : 0;
  let s = '';
  for (let i = start; i < n; i++) {
    const v = scale > 0 ? ring.at(i) / scale : 0;
    s += SPARK_GLYPHS[v <= 0 ? 0 : v < 0.25 ? 1 : v < 0.5 ? 2 : v < 0.75 ? 3 : 4];
  }
  return s;
}

// 把曲线降采样成 width 个点(供 canvas 画)。桶内**取最大值**:
// 卸货率是尖峰型信号, 「取第一个点」会把整根尖峰丢掉, 看起来像「这一分钟啥也没发生」。
export function downsample(ring, width) {
  const n = ring.n;
  const out = new Float64Array(n < width ? n : width);
  if (!n) return out;
  if (n <= width) { for (let i = 0; i < n; i++) out[i] = ring.at(i); return out; }
  const bucket = n / width;
  for (let b = 0; b < out.length; b++) {
    const i0 = Math.floor(b * bucket);
    const i1 = Math.max(i0 + 1, Math.floor((b + 1) * bucket));
    let m = -Infinity;
    for (let i = i0; i < i1 && i < n; i++) { const v = ring.at(i); if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}
