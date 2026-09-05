// 固定步长累加器: 逻辑步长固定 STEP, 渲染按倍速分档降频。
// 逻辑与渲染解耦, 支持 1/8 / 64 倍速(仅改变推进速度, 不改变步长本身)。
//
// P2.4c · 倍速性能(用户点名: 优化倍速下的性能表现)。这一页有三处会把倍速变成假倍速, 逐条交代:
//
// ① 顶格整段丢时间(旧写法 while(accum>=step && guard<240) + if(guard>=240) this.accum=0)。
//    先把量算清楚再说它什么时候咬人: 一帧最多能带进 accum 的仿真时间 = maxDt×倍速(dt 先被钳到
//    0.05s), 而 240 步 = 4.0s ⇒ **倍速 ≤ 80× 时这个顶格根本碰不到**(64× 只有 3.2s=192 步)。
//    上一轮把它写成「64× 顶格即整段时间被丢弃」, 是没算这一步就下的结论 —— 已更正(METRICS P2.4c §2)。
//    真正咬人的是 ≥128×, 以及下面第 ② 条。
// ② 一帧跑爆(旧写法没有每帧预算): 64× 时一帧要跑 192 步, 本机无头实测单步 8.2 ms ⇒ 一帧 1.6 秒,
//    rAF 掉到 1fps, HUD/镜头/输入全停; 而**吞吐并没有因此变高** —— 步/秒 ≈ 1/单步成本, 与一帧里
//    跑多少步无关(单核就那么多 CPU)。所以现在的改法不是「跑得更快」, 是把这笔 CPU 分时分得对:
//    (a) stepBudgetMs: 一帧里仿真最多占这么多墙钟, 跑不完的留在 accum 里下一帧继续。accum 上限
//        accumCap = maxDt×倍速 —— 与旧版 240 步窗口(4.0s)同一量级且**更紧**(64× 时 3.2s), 没有放宽。
//        预算取多少不是拍脑袋: 吞吐 = (B/单步成本)/(B+渲染摊销) 对 B 单调上升, 帧的卡顿感由 B 决定
//        ⇒ 倍速越高 B 越大: <4× 用出厂 12 ms(等于不改变出厂路径), ≥4× 用该档的渲染周期(28/40 ms),
//        含义就是「上次出画到这次出画之间的时间全给仿真」。数值留口子 ?stepBudgetMs= 供浏览器实扫。
//        ⚠ 但本轮的**浏览器实扫没有跑成**: 该 tab 处于后台/遮挡态, rAF 被宿主节流到 fps 1, 这时候任何倍速读数
//        量的都是宿主的调度假政策, 不是这一页的逻辑(见 METRICS P2.4c §5 与教训 ㉟)。想补实扫: 窗口放到前台再跑
//        ?speed=64, 看 HUD 第二行的达成%。所以这一页的权威证据只有 pace_check.mjs 的虚拟时钟(28/0):
//        墙钟不可复现, 而注入的假时钟每一步都可复现。
//    (b) 原来每一帧都做完整渲染(场纹理上传 + 蚂蚁 instance + 覆盖层 + HUD + 合成)。64× 时一帧里
//        世界已经走了 64 帧的逻辑量, 画面 30fps 与 60fps 的差别肉眼读不出来, 但渲染省下来的
//        每一毫秒都直接变成步数 ⇒ 按倍速分档降渲染频率(见 setSpeed; 1× 以下每帧都画, 出厂路径不变)。
// ③ tps 计量用了钳位后的 dt(本轮自己装的时候写错的): 窗口长度累加的是被 maxDt 钳过的 dt, 帧越慢
//    高估越多(200 ms/帧 ⇒ 高估 4 倍), 于是「达成 %」恰好在最吃紧的时候朝好的方向骗人。
//    现在窗口用未钳位的真实间隔; 这条由 pace_check T3 钉住。
//
// ⚠ 这一页**不在任何无头仿真门禁的作用面上**: perf_check 等 harness 自己写死循环推进, 不 import 本
//   文件。覆盖它的是 pace_check.mjs(虚拟时钟, 不碰 sim): 时间守恒 / 预算生效 / 渲染分档 /
//   onFrame 收到的是真实间隔 / paceText 的数字。别把四钉当成「循环改对了」的证据 —— 它看不见这里。

export class Loop {
  constructor({ step = 1 / 60, onStep, onFrame, stepBudgetMs = 12, maxDt = 0.05 }) {
    this.step = step;         // 固定逻辑步长(秒)
    this.onStep = onStep;     // called once per fixed step
    this.onFrame = onFrame;   // called once per rendered frame
    this.timeScale = 1.0;     // 1/8 / 1 / 4 / 64 ...
    this.accum = 0;
    this.last = 0;
    this.stepsDone = 0;
    this.fps = 0;             // **渲染**帧率的指数滑动平均(不是仿真步率)
    this.tps = 0;             // 实测仿真步/秒(未钳位真实时间, 0.5s 窗口) —— 倍速是否名副其实只看这个
    this.running = false;
    this._raf = 0;
    this.stepBudgetBase = stepBudgetMs;
    this.budgetMs = stepBudgetMs;  // 生效预算, setSpeed 按倍速档抬高(见文件头 ②a)
    this.maxDt = maxDt;       // 失焦/切标签回来, 一次最多补这么多墙钟(旧值, 未改)
    this.accumCap = maxDt;    // accum 的仿真时间上限, setSpeed 里按倍速放大
    this.minRenderMs = 0;     // 渲染节流门槛(1× 与暂停=0 ⇒ 出厂路径每帧都画)
    this._lastRender = 0;
    this._tpsT = 0; this._tpsN = 0;
    // 一个 tick 的墙钟分解(P2.4d): simMs = 仿真占掉多少, tickMs = 整个 tick 多少。
    // 为什么要量这个而不是只量 fps: 倍速的【天花板】= 1/单步成本, 而 (tickMs - simMs) 就是被出画与
    // 合成吃掉的那一份 —— 它是「64× 只跑到 5×」里唯一还能买回来的部分。两者都取 EMA(单帧噪声太大)。
    this.simMs = 0; this.tickMs = 0;
    this.forceRender = null;  // () => bool: 录像期间必须每帧出画(见 app.js)
  }

  start() {
    this.running = true;
    this.last = performance.now();
    this._lastRender = this.last;
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  setSpeed(x) {
    this.timeScale = x;
    // 渲染封顶档: <4× 每帧都画(慢动作与常速是要盯着看的, 也是出厂路径); 4× ≈ 35fps 封顶;
    // 16×/64× ≈ 25fps 封顶。倍速越高, 省下来的渲染毫秒越多地转给仿真 —— 但见文件头 ②:
    // 步/秒的物理上限 = 1/单步成本, 调这一档买不到额外的吞吐, 买到的是不卡死的镜头与 HUD。
    this.minRenderMs = x >= 16 ? 40 : (x >= 4 ? 28 : 0);
    // accumCap = maxDt×倍速: 64× 时 3.2s = 192 步, 与旧版 240 步窗口同级且更紧 —— 没有放宽。
    this.accumCap = this.maxDt * Math.max(1, x);
    // 预算跟着渲染周期走: 倍速档里「两次出画之间的时间全给仿真」, 常速保持出厂 12 ms。
    this.budgetMs = Math.max(this.stepBudgetBase, this.minRenderMs);
  }

  // 需要多少步/秒才配得上当前倍速: 一步 = step 秒仿真时间。
  demandTps() { return this.timeScale / this.step; }

  _tick(now) {
    if (!this.running) return;
    const raw = (now - this.last) / 1000;              // 未钳位: 距上次进这一帧真正过了多久
    let dt = raw > this.maxDt ? this.maxDt : raw;      // 钳位只作用于【要补多少仿真时间】, 不作用于计量
    this.last = now;

    this.accum += dt * this.timeScale;

    const t0 = performance.now();
    let n = 0;
    while (this.accum >= this.step) {
      // 预算闸: 每帧给仿真这么多墙钟, 剩下的下一帧再来(不丢)。
      // n >= 4000 是防御性保险(步长为 0 或 onStep 不再推进 accum 时不至于死循环), 正常永远碰不到。
      // 每 4 步查一次: performance.now() 不是免费的, 每步都查会污染它自己量的东西; 而「第 8 步之后
      // 才查」等于要求慢机器一帧至少跑满 8 步 —— 单步 8 ms 时 12 ms 的预算要跑到 64 ms 才刹车。
      if (n >= 4000 || (n >= 4 && (n & 3) === 0 && performance.now() - t0 > this.budgetMs)) break;
      this.onStep(this.step);
      this.accum -= this.step;
      this.stepsDone++;
      n++;
    }
    if (this.accum > this.accumCap) this.accum = this.accumCap;
    const simMs = performance.now() - t0;   // 每 tick 多一次 performance.now(), 换掉一整类猜测

    // tps 的窗口用真实时间 raw(未钳位), 见文件头 ③。
    this._tpsN += n; this._tpsT += raw;
    if (this._tpsT >= 0.5) { this.tps = this._tpsN / this._tpsT; this._tpsN = 0; this._tpsT = 0; }

    const since = now - this._lastRender;
    if (since >= this.minRenderMs || (this.forceRender && this.forceRender())) {
      this.onFrame(since / 1000);          // 注意: 传的是「距上次出画」的真实间隔, 相机平滑才不跳
      this.fps = this.fps * 0.95 + (1 / Math.max(since / 1000, 1e-4)) * 0.05;
      this._lastRender = now;
    }
    // EMA 0.9/0.1: 与 fps 同一套平滑系数。放在 tick 最末尾 ⇒ tickMs 含仿真 + 出画 + 提交前的全部 JS。
    const tickMs = performance.now() - t0;
    this.simMs = this.simMs * 0.9 + simMs * 0.1;
    this.tickMs = this.tickMs * 0.9 + tickMs * 0.1;
    this._raf = requestAnimationFrame(this._tick);
  }
}

// 倍速读数(HUD 用)。为什么单独成函数、为什么写在这一页而不是在 app.js 里现拼字符串:
// 这一行是【用户唯一能看出倍速是真是假的东西】。P2.4c 初稿把等效倍速算成 步/秒 × 60, 于是
// 160 步/秒被印成 9600× —— 单位弄反的读数比没有读数更坏, 而它在页面上肉眼看不出来。
// 只有做成纯函数, pace_check.mjs 才能直接拿它对数字(本页没有任何无头仿真门禁跑得进来, 见文件头 ⚠)。
// 纯读: 不写 loop 状态, 不掷随机数。
export function paceText(l) {
  const ts = l.timeScale;
  if (!(ts > 1)) return '';                        // 1× 与暂停不显示 —— 那时每帧都画, 没有降频可报
  const equiv = l.tps * l.step;                    // 等效倍速 = 一秒墙钟推进了多少秒仿真时间
  const need = l.demandTps();                      // 配得上当前倍速所需的步/秒 = 倍速 / step
  const pct = Math.round(100 * Math.min(1, l.tps / need));
  let s = `仿真 ${l.tps.toFixed(0)} 步/秒=${equiv.toFixed(2)}× (需 ${need.toFixed(0)} 步/秒≈${ts}×, 达成 ${pct}%)`;
  // 上限(P2.4d): 「达成 8%」只说了问题的一半, 另一半是【这台机器到底能跑几倍】—— 没有后一句,
  // 用户无法区分「代码写得慢」与「物理上就这么多 CPU」。一个 tick = 仿真 + 出画,
  // 所以把出画压到 0 能到的步率 = 步/秒 × tick/sim, 再乘 step 换成倍速。
  // ⚠ tickMs 量的是【JS 的一个 tick】, 浏览器的绘制与合成发生在 tick 之外 ⇒ 「出画占」只是 JS 那一份,
  //   它不含 GPU 填充率/合成。这正是为什么 blur 与 renderScale 只能靠浏览器 A/B 定案, 这里报不了它们。
  // 门槛 sim>0.5 ms: 没跑满预算的档位(例如 4× 在够快的机器上)simMs 会趋近 0, 那个比值没有意义。
  const sim = l.simMs || 0, tick = l.tickMs || 0;
  if (sim > 0.5 && tick >= sim) {
    const ceil = Math.max(equiv, l.tps * (tick / sim) * l.step);
    s += ` · 出画JS占 ${Math.round(100 * (1 - sim / tick))}% ⇒ 本机上限 ${ceil.toFixed(1)}×`;
  }
  return s;
}