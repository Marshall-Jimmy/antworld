// P2.4b · 个体事件观察器: 把一只蚂蚁的 SoA 状态变化翻译成**能讲出来的故事**。
//
// 为什么不改 sim 去发事件: colony.step 是热路径, 在里面塞 emit 要么每步走一遍判空回调,
// 要么引入一个「有没有人在听」的分支——两种都要碰 bit 级基线(红线 1)。而跟拍只需要**一只**蚁的
// 状态转移: 在 sim 之外按步读它的四个标量(位置/负载/失败计数)做前后差分, 成本 O(1),
// 完全只读, 基线一根手指都没动。只读**判据真用得着**的那几个: 第一版顺手把 pauseT/forageT
// 也抄进快照, 后来改判据之后它们成了没人看的死读数——量具里的死读数同样要清掉。
//
// 事件语义全部来自现有机制(所以每条都写清了它对应谁, 不新造概念):
//   start 出发       —— 空手**跨出巢盘**(物理): 位置从巢内变巢外
//   found 发现取食   —— load 从 0 变 >0: 咬到食物(colony 的取食结算)
//   home  到家卸货   —— load 从 >0 变 0 且当步在巢盘内: 纯物理到家(P2.2 的诚实化判定)
//   drop  弃货       —— load 从 >0 变 0 且人在巢盘外: 负重超时泄压阀(carryTimeout)
//   lost  超时返巢   —— misses 增加: 空手觅食超时并真的走回巢盘(P1.9)
//   died  被捕杀重生 —— 本步位移远超一步能走的距离(瞬移)且落点在巢盘内, 同群 kills 确实涨了(P2.2)
//
// ⚠ 顺序敏感: 同一步里多个转移同时发生是常态(「到家卸货」当步往往就是下一次「出发」的起点),
//   所以每条事件带 step 号, 同步内按固定优先级稳定排序, 不靠数组下标猜先后。
export const EVENT_KINDS = [
  { code: 'start', label: '出发',   mark: '▶', color: '#7fd6ff' },
  { code: 'found', label: '发现食物', mark: '✦', color: '#ffd166' },
  { code: 'home',  label: '到家卸货', mark: '⌂', color: '#8ef0a8' },
  { code: 'drop',  label: '弃货',   mark: '✕', color: '#ff8f6b' },
  { code: 'lost',  label: '超时返巢', mark: '↩', color: '#c39bff' },
  { code: 'died',  label: '被捕杀', mark: '☠', color: '#ff5d5d' },
];
export const eventKind = (code) => EVENT_KINDS.find((e) => e.code === code) || null;

// 同一步内的稳定次序: 死 > 弃 > 到 > 发现 > 迷路 > 出发(死最该被看见, 出发最像噪声)
const ORDER = { died: 0, drop: 1, home: 2, found: 3, lost: 4, start: 5 };

// 一步内的"合法位移"上限(世界单位): speed 滑杆最大 200 ⇒ 一步最多 200/60≈3.3u, 取 8u 已留 2.4 倍余量。
// 为什么用位移而不是只用 kills: kills 是**整群**的计数器, 只看它会把「同伴被吃、我正好在巢里」
// 误记成我被吃(stats_check S3 第一跑就是这么暴露的: 跟拍那只蚁 20 秒根本没出门, 事件数为 0)。
const MAX_STEP_DIST = 8;

export class AntObserver {
  constructor({ trailCap = 240, eventCap = 48, crumbEvery = 8, nestRadius = 30 } = {}) {
    this.trailCap = trailCap;
    this.crumbEvery = crumbEvery;
    this.nestRadius = nestRadius;
    this.tx = new Float32Array(trailCap);
    this.ty = new Float32Array(trailCap);
    this.tn = 0;
    this.thead = 0;
    this.eventCap = eventCap;
    this.events = [];          // {step, tSec, code, x, y}
    this.idx = -1;
    this.prev = null;
    this.prevInNest = false;
    this.prevMisses = 0;
    this.prevKills = 0;
    this.sinceCrumb = 0;
    this.summary = {};         // 每种事件各几次(验收「讲出完整故事」直接读这个)
  }

  // 换蚁/换一窝都必须清空: 面包屑留着上一只的路, 等于把两只蚁的故事缝成一只的。
  select(idx, colony) {
    this.idx = idx;
    this.tn = 0; this.thead = 0; this.sinceCrumb = 0;
    this.events.length = 0;
    this.summary = {};
    this.prevInNest = false;
    this.prevMisses = 0;
    this.prevKills = colony ? colony.kills : 0;
    this.prev = idx >= 0 && colony ? this._read(colony) : null;
  }

  clear() { this.select(-1, null); }

  _read(colony) {
    const i = this.idx;
    return {
      px: colony.px[i], py: colony.py[i], load: colony.load[i], misses: colony.misses[i],
    };
  }

  // 每逻辑步调用一次(colony.step 之后)。只读: 不写 colony, 不掷随机数(铁律 3/4)。
  observe(colony, world, stepCount, tSec) {
    if (this.idx < 0 || this.idx >= colony.count) return;
    const cur = this._read(colony);
    const p = this.prev;
    this.prev = cur;
    const inNest = this._inNest(cur, world);
    const wasInNest = this.prevInNest;
    this.prevInNest = inNest;
    if (!p) { this.prevMisses = cur.misses; return; }
    const jump = this._jump(p, cur, world);

    const out = [];
    const push = (code) => out.push({ step: stepCount, tSec, code, x: cur.px, y: cur.py });

    if (p.load === 0 && cur.load > 0) push('found');
    // 「负载清零」这一个物理事实按当步位置劈成两条语义: 在巢=卸货, 在野=弃货。
    // 这一劈是 P2.2 那笔假永动卸货账的直接推论, 不能只按计数器增量记账。
    if (p.load > 0 && cur.load === 0) push(inNest ? 'home' : 'drop');

    // 被捕杀 = 「整群多了一具」∧「这一只当步发生了瞬移」∧「瞬移落在巢盘内且空手」。三条同时成立才记。
    const dk = colony.kills - this.prevKills;
    if (dk > 0 && jump > MAX_STEP_DIST && inNest && cur.load === 0) push('died');
    if (dk !== 0) this.prevKills = colony.kills;

    if (cur.misses > this.prevMisses) push('lost');
    this.prevMisses = cur.misses;

    // 出发 = 空手**跨出巢盘**这个物理事件, 不是"滞留计时归零"。
    // 为什么改(浏览器验收抓到的假读数): 第一版用 pauseT>0→<=0 判出发, 跟拍迷宫里的 #7
    // 读出「出发 3 · 到家卸货 1」——它三分钟内只回过一次巢, 另外两次是外勤途中的**触角扫描
    // 微停顿**结束(pauseRate 每步都可能在野外触发), 被当成了两次出门。pauseT 在模型里被
    // 巢内滞留与野外微停顿两件事复用, 它归零说明不了"它正在离巢"; 位置才是诚实的。
    // (上一版修的是 `=== 0` 倒数成负数那个 off-by-one, 那条仍然成立: 现在压根不依赖 pauseT。)
    // 仍要求 load===0: 负重跨出巢盘只可能是卸完货又被食源黏住, 不是一次新的出发。
    if (wasInNest && !inNest && cur.load === 0) push('start');

    if (out.length) {
      out.sort((a, b) => (ORDER[a.code] | 0) - (ORDER[b.code] | 0));
      for (const e of out) {
        this.events.push(e);
        this.summary[e.code] = (this.summary[e.code] || 0) + 1;
      }
      while (this.events.length > this.eventCap) this.events.shift();
    }

    // 面包屑按步长采样(默认 8 步≈0.13s 一粒, 240 粒≈32 秒的路)。
    // 采样而不是逐点存: 镜头拉远时几千个点里绝大部分落在同一个像素上, 白存白画。
    if (++this.sinceCrumb >= this.crumbEvery) {
      this.sinceCrumb = 0;
      this.tx[this.thead] = cur.px; this.ty[this.thead] = cur.py;
      this.thead = (this.thead + 1) % this.trailCap;
      if (this.tn < this.trailCap) this.tn++;
    }
  }

  _inNest(s, world) {
    const R = this.nestRadius;
    let dx = s.px - world.nestX, dy = s.py - world.nestY;
    return dx * dx + dy * dy < R * R;
  }

  // 环面上的两步位移(瞬移检测用)
  _jump(p, cur, world) {
    let dx = cur.px - p.px, dy = cur.py - p.py;
    if (dx > world.w / 2) dx -= world.w; else if (dx < -world.w / 2) dx += world.w;
    if (dy > world.h / 2) dy -= world.h; else if (dy < -world.h / 2) dy += world.h;
    return Math.hypot(dx, dy);
  }

  // 环形面包屑摊平成「最旧→最新」的普通数组(渲染层不必懂环形算术)
  trail() {
    const n = this.tn, out = [];
    const start = (this.thead - n + this.trailCap) % this.trailCap;
    for (let k = 0; k < n; k++) {
      const j = (start + k) % this.trailCap;
      out.push(this.tx[j], this.ty[j]);
    }
    return out;
  }
}
