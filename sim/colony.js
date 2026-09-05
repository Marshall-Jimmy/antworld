// SoA 类型化数组存储整群蚂蚁 + 单步推进编排。
// 本模块不 import 任何渲染/DOM 代码，可 headless（node）运行。
//
// 性能注记：本文件是热路径（每步 N 只蚂蚁）。所有临时对象（RNG 闭包、
// ant.js 的 state/out 槽、传感器坐标）都在构造时预分配复用，步进循环零 GC 分配。
// 数值行为与旧版 bit 级一致（同样的表达式顺序），可用固定 seed 校验和复现。
//
// P2.5 · 能量与生死(survivalMode)。这一页的全部新增都受同一个开关门控, 关着的时候
// 一个数组都不读、一个随机数都不掷 ⇒ 四钉逐位不变(铁律 2/4)。三条结构性决定写在这里, 别翻代码猜:
//
// ① **种群只在 [0, capacity] 之间振荡, 数组容量永不扩大**。capacity = 构造时的 antCount,
//    语义就是「这只巢的容纳上限」。工程理由(不是生物学): memA/memB 在 5000 蚁已经是 2.6 MB,
//    按 1.6x 预留扩容会直接爆内存预算。
// ② **不用 alive[] 标志位**: 死亡在主循环**结束之后**的收尾 pass 里做 swap-remove 压缩,
//    于是「活蚁恒占据 [0, population)」是硬不变量。收益: 渲染/空间哈希/HUD 只把 count 换成
//    population, 尸体天然不画, 主循环里也不必每步走一遍 alive 分支; 而且因为压缩发生在循环
//    之外, **没有任何一只蚁会因为搬动而少走一步**(这点比当场删元素干净得多)。
// ③ **能量在 colony 侧结算, sim/ant.js 一个字不改**。ant.js 管「怎么动」(纯函数+随机流),
//    colony 管「还动不动得了」。用当步**实际位移**计费: 被墙挡掉的路不该收钱。


import { step as antStep } from './ant.js';
import { ENERGY_FULL, WEAR_ROLL_EVERY, wearRollP, lifeScale } from './energy.js';

const BIRTH_ACC_CAP = 200;   // 产卵倾向最多攒 200 只: 攒三天不可能瞬间爆窝

// 个体路线记忆(P2.4): 每只蚁的个人路线 = 一串航点。32 段 × memStep(默认 24) ≈ 768 世界单位,
// 覆盖本项目的典型巢–源距离(~290)两倍有余; 记满后丢最旧的半段(靠巢那截最不值钱)。
export const MEM_WPTS = 32;
const MEM_DROP = MEM_WPTS >> 1;

export class Colony {
  constructor(count, opts) {
    const { rng, world, nestRadius } = opts;
    this.count = count;

    // SoA：每个属性一个 Float32Array
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.theta = new Float32Array(count);
    this.hx = new Float32Array(count);   // 回家向量（航位推算）
    this.hy = new Float32Array(count);
    this.load = new Float32Array(count); // [0,1]
    this.tumble = new Float32Array(count);
    this.lastAsym = new Float32Array(count); // P1.7-D: 最后闻到路的一侧(回环搜索记忆)
    this.seedNoise = new Uint32Array(count); // 每只蚂蚁独立的随机流状态
    this.carryT = new Float32Array(count);   // 已负重时长(秒),内部标量
    this.pauseT = new Float32Array(count);   // >0 = 停顿/巢内滞留倒计时(秒)
    this.forageT = new Float32Array(count);  // 空手觅食计时(秒): 超时触发返巢休整(P1.9)
    this.misses = new Float32Array(count);   // 空手觅食失败计数(float): 折扣轨迹信任, 随时间恢复(P1.9)
    this.speedMul = new Float32Array(count); // 个体性格: 速度/转向/沉积倍率(惰性初始化,依赖 params)
    this.turnMul = new Float32Array(count);
    this.depMul = new Float32Array(count);
    this.wallSide = new Float32Array(count); // P2.2: 个体沿墙侧偏好(±1), 0=未定(见 ant.js 墙避让)
    // ---- 个体路线记忆(P2.4) SoA: A=已证实的路线(重放用), B=这一趟正在记的(咬到食物才提交成 A) ----
    // 双缓冲是必需的: 重放 A 的同时必须在记新路线 B, 单缓冲会自我覆盖。5000 蚁 × 32 点 × 2 坐标
    // × 2 缓冲 = 2.6 MB, 且 K_mem=0 时这些数组根本不读不写(只有构造期分配)。
    this.memA = new Float32Array(count * MEM_WPTS * 2);
    this.memB = new Float32Array(count * MEM_WPTS * 2);
    this.memNA = new Uint8Array(count);   // A 里有效点数
    this.memNB = new Uint8Array(count);   // B 里有效点数
    this.memIA = new Uint8Array(count);   // A 的重放指针(走到第几个点)
    this.memLX = new Float32Array(count); // B 上一个记点的位置(判断"走开一个 memStep 了没")
    this.memLY = new Float32Array(count);
    this.memFail = new Float32Array(count); // 这条 A 连续扑空几次(→ 权重线性衰减到废弃)
    this.memTrips = new Uint8Array(count); // 这根线连续被走通验证几次(P2.3.3 成熟度门, K_route=0 时不读不写)
    // 路线长度(世界单位): 提交时只认"不比现有路线长"的新路线(P2.4)——真实蚁逐趟把路走短,
    // 而第一趟找到食物靠的往往是乱走, 不筛就会把弯路焊死成永久路线(实测吞吐反而 −5~9%)。
    this.memLA = new Float32Array(count);
    this.memLB = new Float32Array(count);
    // ---- P2.5 能量与生死(survivalMode=0 时下面每一行都只是"分配过", 从不被读) ----
    // 活蚁恒占据 [0, population): 见文件头 ①②
    this.capacity = count;
    this.population = count;
    this.uid = new Uint32Array(count);   // 个体身份:跟拍靠它判断「我跟的那只还在不在这一格里」
    for (let i = 0; i < count; i++) this.uid[i] = i;
    this._nextUid = count;
    this.energy = new Float32Array(count); this.energy.fill(ENERGY_FULL);  // 满胃=1 能量
    this.workT = new Float32Array(count);   // 累计**外勤**秒(巢内不折旧, ANT_BIOLOGY §四)
    this.broodT = new Float32Array(count);  // 新蚁巢内服务期剩余秒
    this._dead = new Int32Array(count); this._deadN = 0;
    // 生育用**独立随机流**: 借循环里某只蚁的流, 会让它下游的序列被"别人家生了个孩子"污染。
    this._suS = (this.seedNoise[0] ^ 0x51ed21c3) >>> 0;
    this._su = () => {
      self._suS = (self._suS + 0x6d2b79f5) | 0;
      let t = Math.imul(self._suS ^ (self._suS >>> 15), 1 | self._suS);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // 储备账(质量守恒, survival_check T2 钉这条): reserve = inflow − foodEaten − birthFood − overflow
    this.reserve = 0;
    this.inflow = 0; this.foodEaten = 0; this.birthFood = 0; this.overflow = 0;
    this.births = 0; this.starved = 0; this.wornOut = 0; this.deaths = 0;
    this._birthAcc = 0;
    this.eMin = ENERGY_FULL;

    this._persInit = false;
    this.deliveries = 0;   // 累加:成功回巢卸货次数
    this.timeouts = 0;     // 累加:迷路弃货次数
    this.aborts = 0;       // 累加:空手觅食超时返巢次数(P1.9)
    this.kills = 0;        // 累加:被捕食者捕杀次数(P2.2)
    this.stepCount = 0;        // 已推进步数(P2.2, alarm 活动门控用)
    this.lastAlarmStep = -1e9; // 最近一次 alarm 落笔/喷溅的步号(P2.2)
    this._loaded = 0;      // 增量维护的 load>0 计数(loadedCount O(1))

    // ---- 热路径预分配 ----
    // 每蚂蚁随机流状态暂存在实例上，闭包只建一次（旧版每蚂蚁每步建 2 个闭包）
    this._s = 0;
    const self = this;
    this._u = () => {                    // mulberry32 单步, 状态 = self._s
      self._s = (self._s + 0x6D2B79F5) | 0;
      let t = Math.imul(self._s ^ (self._s >>> 15), 1 | self._s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this._gauss = () => {                // Box-Muller, 消耗 2 次均匀采样(与旧版一致)
      const a = Math.max(self._u(), 1e-12);
      return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * self._u());
    };
    this._st = { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, pauseT: 0, speedMul: 1, turnMul: 1, depMul: 1, forageT: 0, misses: 0, wfl: 0, wfm: 0, wfr: 0, afl: 0, afm: 0, afr: 0, wallSide: 0, memTurn: 0, memDamp: 1 };
    this._out = { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, deposit: 0, pauseT: 0, forageT: 0, dx: 0, dy: 0, wallSide: 0 };

    // 初始化：从巢口随机出生(带 0~2s 错峰停顿——蚁群陆续出门, 不是齐步走的圆环)
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = nestRadius * Math.sqrt(rng()); // sqrt → 均匀分布在圆盘内
      this.px[i] = (world.nestX + Math.cos(a) * r + world.w) % world.w;
      this.py[i] = (world.nestY + Math.sin(a) * r + world.h) % world.h;
      this.theta[i] = rng() * Math.PI * 2;
      this.seedNoise[i] = (rng() * 0xffffffff) | 0;
      this.tumble[i] = 1 + rng() * 20;
      this.pauseT[i] = rng() * 2;
    }
  }

  // 单步推进整群。field: 信息素场; world: 食物/巢/墙/捕食者; params: 参数表; dt: 步长;
  // alarmField(P2.2): 报警信息素场(可空——空表示本步不启用 alarm, 零开销且行为不变)。
  // env(P2.3): 昼夜/天气调制槽(可空)。只影响行动力/觅食计时/巢内滞留走表速率, 不掷额外随机数。
  step(field, world, params, dt, alarmField, env) {
    // 上界是**活蚁数**而不是容量: 尸体在收尾 pass 里已被搬出这个区间(文件头 ②)。
    // survivalMode=0 时 population 恒等于 count ⇒ 旧路径一个分支都不多。
    const n = this.population;
    this.stepCount++;
    const {
      sensorAngle, sensorDist, speed,
      foodLoadRate, carryTimeout, nestRadius, nestDwell, forageTimeout, missRecover,
      K_mem = 0, memStep = 24, memForget = 2, K_route = 0,
      // P2.5: 用默认值解构而不是直接取, 是为了让 headless 的老 harness(不传这些键)照样跑。
      survivalMode = 0, metBasal = 0, metWalk = 0, metLoad = 0, cropFood = 1,
      storageCap = 0, birthFill = 0, birthCost = 1, birthRate = 0, broodT = 0,
      workLife = 0, corpseAlarm = 0,
    } = params;
    // 生死总开关(P2.5): 关着就整块短路——不读 energy/workT/uid、不动 reserve、不掷随机数(铁律 4)。
    const survOn = survivalMode > 0;
    // 全群最低能量(HUD 那一行「能量最低」)。每步起点重置、在结算里取小 ⇒ 循环结束时它
    // 就是活蚁的最小值, 不需要 HUD 每帧再扫一遍 5000 个 Float32(倍速下那是白烧的)。
    if (survOn) this.eMin = ENERGY_FULL;

    let firstFoodAt = -1; // 本步首次吃到食物的蚂蚁索引
    const st = this._st, out = this._out, u = this._u, gauss = this._gauss;
    const physarum = params.sensorMode === 'physarum'; // P1.8: 三触角模式需额外采样前触角
    const wallOn = world.wallCount > 0;                // P2.1: 有墙才启用墙感知/阻挡(零开销门控)
    // 巢内滞留走生物钟表(P2.3): 只有"环境钟真的走别的速率"时才付这个判定的代价。
    // pauseRate === 1(两开关全关 → env 为 null; 开着的正午晴天恒等于 1)时整块短路, 逐位不变。
    const dwellClock = !!env && env.pauseRate !== 1;
    // 路线记忆总开关(P2.4): 关掉时下面每一块都短路——不读数组、不写数组、更不掷随机数,
    // 所以旧行为 bit 级不变(铁律 2/4)。半宽高环面距离用, 提到循环外只算一次。
    const memOn = K_mem > 0;
    const hw = world.w / 2, hh = world.h / 2;

    // ---- 个体性格惰性初始化(首步时 params 才可用): 从各自 seedNoise 的不相交位段
    // 提取倍率——确定性、且完全不干扰行为随机流; speedVar 等为 0 时恒等于 1(旧行为)。
    if (!this._persInit) {
      this._persInit = true;
      const sv = params.speedVar || 0, tv = params.turnVar || 0, dv = params.depositVar || 0;
      for (let j = 0; j < n; j++) {
        const s = this.seedNoise[j] >>> 0;
        this.speedMul[j] = 1 - sv + (s & 2047) / 2047 * 2 * sv;
        this.turnMul[j] = 1 - tv + ((s >>> 11) & 2047) / 2047 * 2 * tv;
        this.depMul[j] = 1 - dv + ((s >>> 22) & 1023) / 1023 * 2 * dv;
      }
    }

    for (let i = 0; i < n; i++) {
      // ---- 每只蚂蚁自己的随机流(闭包复用,状态挂实例) ----
      this._s = this.seedNoise[i] | 0;

      // ---- 1.感知(内联 sensorPoints,避免临时对象) ----
      // 坐标先落变量(表达式与旧版逐字一致, 值不变)——墙感知(P2.1)复用同三个触角点
      const pxi = this.px[i], pyi = this.py[i];
      const theta = this.theta[i];
      const left = theta + sensorAngle, right = theta - sensorAngle;
      const flx = pxi + Math.cos(left) * sensorDist, fly = pyi + Math.sin(left) * sensorDist;
      const fl = field.sample(flx, fly);
      const frx = pxi + Math.cos(right) * sensorDist, fry = pyi + Math.sin(right) * sensorDist;
      const fr = field.sample(frx, fry);
      // 前触角: 仅 physarum 模式采样轨迹场(diff 模式零开销); alarm 启用时前点两者都要用
      let fm = 0, fmx = 0, fmy = 0;
      if (physarum || alarmField) {
        fmx = pxi + Math.cos(theta) * sensorDist;
        fmy = pyi + Math.sin(theta) * sensorDist;
        if (physarum) fm = field.sample(fmx, fmy);
      }
      // 墙感知(P2.1): 三触角各查一次墙格(有墙才查, 无墙 wfl/wfm/wfr 恒 0)
      let wfl = 0, wfm = 0, wfr = 0;
      if (wallOn) {
        wfl = world.wallAt(flx, fly);
        wfr = world.wallAt(frx, fry);
        if (physarum) wfm = world.wallAt(fmx, fmy);
      }
      // 报警信息素感知(P2.2): 同三触角点采样 alarm 场(alarmField 为空 = 未启用, 恒 0)
      let afl = 0, afm = 0, afr = 0;
      if (alarmField) {
        afl = alarmField.sample(flx, fly);
        afr = alarmField.sample(frx, fry);
        afm = alarmField.sample(fmx, fmy);
      }

      // ---- ant.step 纯函数推进(复用 state/out 槽) ----
      st.px = pxi; st.py = pyi; st.theta = theta;
      st.hx = this.hx[i]; st.hy = this.hy[i];
      st.load = this.load[i]; st.tumble = this.tumble[i];
      st.lastAsym = this.lastAsym[i];
      let pauseSet = this.pauseT[i];
      if (dwellClock && pauseSet > 0) {
        // 滞留中的蚁当步不移动(effSpeed=0), 所以用本步起点判"在不在巢盘里"就够。
        // 只给**巢内滞留**换钟表: 触角扫描微停顿是外勤行为, 照旧走墙钟——夜里让外勤蚁
        // 原地冻住反而永远走不回巢(验收③原先卡住的就是这种假滞留)。
        const hw2 = world.w / 2, hh2 = world.h / 2;
        let wdx = pxi - world.nestX, wdy = pyi - world.nestY;
        if (wdx > hw2) wdx -= world.w; else if (wdx < -hw2) wdx += world.w;
        if (wdy > hh2) wdy -= world.h; else if (wdy < -hh2) wdy += world.h;
        // ant.js 每步固定扣 dt, 这里补回差额 → 净扣 dt·pauseRate(速率 1 时补的是 +0, 逐位不变)
        if (wdx * wdx + wdy * wdy <= nestRadius * nestRadius) pauseSet += dt * (1 - env.pauseRate);
      }
      // 巢内服务期(P2.5, 年龄多态 lite): 真实 Atta 羽化后先做 3–4 周内勤才转外勤
      // (ANT_BIOLOGY §四)。这里不改 ant.js, 只每一步把它的滞留计时"续"上一步的量,
      // 于是它始终处于 ant.js 已有的 paused 分支里(原地不动) —— 零改动的实现方式。
      if (survOn && this.broodT[i] > 0) {
        this.broodT[i] -= dt;
        if (pauseSet < dt * 1.5) pauseSet = dt * 1.5;
      }
      st.pauseT = pauseSet;
      st.speedMul = this.speedMul[i]; st.turnMul = this.turnMul[i]; st.depMul = this.depMul[i];
      st.forageT = this.forageT[i];
      st.misses = this.misses[i];
      st.wfl = wfl; st.wfm = wfm; st.wfr = wfr;
      st.afl = afl; st.afm = afm; st.afr = afr;
      st.wallSide = this.wallSide[i];
      // ---- 个体路线记忆 · 重放(P2.4) ----
      // 真实蚁群靠"信息素 × 个体路线记忆"双通道导航(ANT_BIOLOGY §二: L. niger 开放场沿线保真
      // 87.4%; 近期证据: 跟随者对信息素**位置**的记忆能覆盖当下尝到的场强度)。纯信息素模型对
      // 熟路蚁是过度简化——而且信息素半衰期只有 23s, 一夜蒸发后整张网要靠群体重新踩出来
      // (HANDOVER §7)。这里给每只蚁一条自己的航点链 A, 空手出门就沿它走。
      // 数组索引、环面距离、航点推进全在这里算完, ant.js 只收两个标量: memTurn(加进转向)、
      // memDamp(贴线时把信息素通道压下去)。整块不掷随机数 → 每蚁随机流一个数都不碰。
      // 负重蚁不重放(它凭航位推算回家, 那才是真实蚁的返程通道); 超时返巢中也不重放。
      st.memTurn = 0; st.memShare = 0;
      if (memOn && this.load[i] === 0 && this.memNA[i] > 0 &&
          !(forageTimeout > 0 && this.forageT[i] > forageTimeout)) {
        const mbase = i * MEM_WPTS * 2;
        const mna = this.memNA[i];
        let mi = this.memIA[i];
        // 人回到家 = 这根线该从起点重走, 指针必须归零。这一条和上面两条归零(卸货/超时结算)
        // 不重复: 被内源钟赶回巢里磨蹭的蚁两样结算都不触发, 却带着上一趟停在路线中段的指针
        // 出门。实测黎明时全群 replay%=99 而 dWp 46→107 —— 蚁在巢里, 目标却在 100 多单位外的
        // 半路上, onRoute=1−md/reachR 直接归零 ⇒ **记忆在最需要它的时刻是哑的**, 于是黎明群体
        // 集体空跑 30s 到点弃航(实测一窗弃航 4538 次)、路线被自己扑空计数误删(覆盖率 100→91%)。
        // 归零必须在"人进巢盘"这一刻做, 不能等结算: 路线是以巢为锚的, 锚点变了整根线就得重数。
        // 放在归因判定之前不冲突: 弃航结算读的是上一步留下的 memIA, 而返巢途中的蚁根本进不到
        // 这个分支(forageT 超时的蚁上面已短路), 所以账还是算在正确的趟次上。
        if (mi > 0) {
          let ndx = pxi - world.nestX, ndy = pyi - world.nestY;
          if (ndx > hw) ndx -= world.w; else if (ndx < -hw) ndx += world.w;
          if (ndy > hh) ndy -= world.h; else if (ndy < -hh) ndy += world.h;
          if (ndx * ndx + ndy * ndy < nestRadius * nestRadius) { mi = 0; this.memIA[i] = 0; }
        }
        const matchR = memStep * 0.75;   // 贴到这么近就算"走完这一点"
        // 采集半径(贴线判据)——**四倍航点间距**, 不是一倍多。第一版这里是 2×memStep(48 单位),
        // 后果致命且只在黎明暴露: 一夜蒸发后集体通道没了, 全群本该靠记忆出门, 可蚁一站在巢口
        // 就发现自己离"下一个航点"有 46~107 单位(巢盘直径 60 > 采集半径 48, 再加上夜里散开的
        // 位置), onRoute 直接归零 ⇒ 记忆在最需要它的时刻是哑的 ⇒ 群体集体空跑满 30s 到点弃航
        // (实测一窗弃航 4539 次)、连路线都被自己的扑空计数误删(覆盖率 100→91%), 三天总吞吐
        // 反而只有基线 0.936×。真实蚁能把自己那条熟路从几十倍体长外**找回来**——记忆的用途恰恰
        // 是"离线了才要用"。放宽到 4× 后黎明窗翻盘(见 METRICS 验收③)。
        const reachR = memStep * 4;
        let mdx = 0, mdy = 0, md = 0;
        // 向前扫: 允许"从半路重新接上自己的线"(真实蚁会从路线中段接上继续走)
        while (mi < mna) {
          mdx = this.memA[mbase + mi * 2] - pxi;
          mdy = this.memA[mbase + mi * 2 + 1] - pyi;
          if (mdx > hw) mdx -= world.w; else if (mdx < -hw) mdx += world.w;
          if (mdy > hh) mdy -= world.h; else if (mdy < -hh) mdy += world.h;
          md = Math.hypot(mdx, mdy);
          if (md < matchR) { mi++; continue; }
          break;
        }
        this.memIA[i] = mi;
        if (mi < mna) {
          // 记忆的可靠度 = 贴线程度 ×(1 − 扑空衰减)。扑空越多越不信这条线(与 P1.9 的 trust 同构),
          // 衰减到 0 由超时结算整条废弃。
          const or0 = 1 - md / reachR;
          const onRoute = or0 > 0 ? or0 : 0;
          const forget = this.memFail[i] >= memForget ? 0 : 1 - this.memFail[i] / memForget;
          // 成熟度门(P2.3.3): 真实蚁"走熟路"的权威是逐趟验证出来的, 不是"离自己画的一条线多近"。
          // K_route=0 ⇒ mature 恒等于 1, 而 IEEE754 里 x*1 是精确的 ⇒ 出厂行为逐位不变(新机制的门控)。
          const mature = K_route <= 0 ? 1 : this.memTrips[i] >= K_route ? 1 : this.memTrips[i] / K_route;
          const rel = K_mem * forget * onRoute * mature;
          st.memShare = rel > 1 ? 1 : rel;                      // 这条记忆在总转向里占多大份额
          st.memTurn = K_mem * Math.sin(Math.atan2(mdy, mdx) - theta);   // 它自己想拐的量
        }
      }
      antStep(st, fl, fr, fm, dt, params, gauss, u, out, env);

      // ---- 运动阻挡(P2.1): 目标格是墙 → 轴滑动(先保 x 再保 y, 全堵则原地不动)。
      // 起点已在墙内(玩家把墙画到蚂蚁身上)时不阻挡, 放它自己走出墙。
      // 实际位移 ≠ 意图位移时校正航位推算——路径积分只记真正走过的路。
      // 注意: 判定必须用"存储等价坐标" fx/fy ——写回是先 toroidal wrap 再存 Float32,
      // float64 的 nx 贴着格边(如 1223.99997)经舍入会跨进墙列; 判定坐标与最终
      // 存储坐标不一致就会出现"判定放行、落点在墙"的刀边穿透。
      let nx = out.px, ny = out.py;
      if (wallOn) {
        const fx = Math.fround((nx + world.w) % world.w);
        const fy = Math.fround((ny + world.h) % world.h);
        if (world.wallAt(st.px, st.py) === 0 && world.wallAt(fx, fy)) {
          if (!world.wallAt(fx, st.py)) ny = st.py;
          else if (!world.wallAt(st.px, fy)) nx = st.px;
          else { nx = st.px; ny = st.py; }
        }
      }

      // 写回 + toroidal 边界
      this.px[i] = (nx + world.w) % world.w;
      this.py[i] = (ny + world.h) % world.h;
      this.theta[i] = out.theta;
      if (nx !== out.px || ny !== out.py) {
        // 被墙挡掉了一部分位移: h = 出发点 − 实际走过的每一步(out.hx 已减意图位移)
        this.hx[i] = out.hx - (nx - st.px) + out.dx;
        this.hy[i] = out.hy - (ny - st.py) + out.dy;
      } else {
        this.hx[i] = out.hx;
        this.hy[i] = out.hy;
      }
      this.load[i] = out.load;
      this.tumble[i] = out.tumble;
      this.lastAsym[i] = out.lastAsym;
      this.wallSide[i] = out.wallSide;   // P2.2: 沿墙侧偏好沿用至下一步
      this.pauseT[i] = out.pauseT;
      this.forageT[i] = out.forageT;
      this.seedNoise[i] = this._s;
      // ---- 个体路线记忆 · 记录(P2.4): 空手出门的这一段路记进 B, 每走开一个 memStep 记一点 ----
      // 停下扫触角时没挪窝, 距离判据自然不成立, 不用特判 paused。
      if (memOn && this.load[i] === 0 &&
          !(forageTimeout > 0 && this.forageT[i] > forageTimeout)) {
        const rbase = i * MEM_WPTS * 2;
        let rn = this.memNB[i];
        const cxx = this.px[i], cyy = this.py[i];
        if (rn === 0) {
          this.memB[rbase] = cxx; this.memB[rbase + 1] = cyy;
          this.memLX[i] = cxx; this.memLY[i] = cyy;
          this.memNB[i] = 1;
          this.memLB[i] = 0;
        } else {
          let rdx = cxx - this.memLX[i], rdy = cyy - this.memLY[i];
          if (rdx > hw) rdx -= world.w; else if (rdx < -hw) rdx += world.w;
          if (rdy > hh) rdy -= world.h; else if (rdy < -hh) rdy += world.h;
          if (rdx * rdx + rdy * rdy >= memStep * memStep) {
            const rlen = Math.hypot(rdx, rdy);
            this.memLB[i] += rlen;
            if (rn >= MEM_WPTS) {
              // 记满: 丢掉最旧的半段(靠巢那截最不值钱), 保住接近食源的后半
              this.memB.copyWithin(rbase, rbase + MEM_DROP * 2, rbase + rn * 2);
              rn -= MEM_DROP;
            }
            this.memB[rbase + rn * 2] = cxx;
            this.memB[rbase + rn * 2 + 1] = cyy;
            this.memLX[i] = cxx; this.memLY[i] = cyy;
            this.memNB[i] = rn + 1;
          }
        }
      }
      // 失败信任缓慢回复(每秒恢复 missRecover 次); 全零时零开销
      if (this.misses[i] > 0) {
        const m = this.misses[i] - dt * (missRecover || 0);
        this.misses[i] = m > 0 ? m : 0;
      }

      // ---- 捕食者捕杀(P2.2): 放在沉积之前——被杀的蚂蚁当步不留轨迹(死者只留下
      // 报警喷溅; 若先铺轨迹再死, 尸体会铺出一条引同伴走进捕杀圈的"遗骸之路")。
      // 报警源只有捕杀喷溅(死者喷溅): 惊逃蚁不释放, 否则"闻到→惊逃→喷洒"正反馈
      // 自持, 撤离后恐慌云永不消散(predator_check 已复现)。
      // 用该蚁自己的随机流取重生参数(捕食者缺席时整块短路, 不耗随机数, bit 级不变);
      // 重生即"新蚁": 清空负载/记忆/信任, 带错峰停顿出门。数量动态归 P2.5。
      const pred = world.predator;
      if (pred && Math.hypot(this.px[i] - pred.x, this.py[i] - pred.y) < pred.r) {
        this.kills++;
        if (alarmField) {
          alarmField.deposit(this.px[i], this.py[i], params.alarmSplash ?? 8);
          this.lastAlarmStep = this.stepCount;
        }
        if (survOn) {
          // 有生死模型的时候被吃就是**真死**(个体身份消失), 不再原地变出一只新蚁。
          // 旧的原地重生是 HANDOVER §7 记的那条简化("即时重生=新蚁"), 它的账现在归储备与产蚁。
          // 报警已由上面的 alarmSplash 喷溅负责, 所以这里不再叠一层尸痕(corpseAlarm 传 0)。
          this._markDead(i, alarmField, 0);
          continue;
        }
        if (this.load[i] > 0) this._loaded--;
        const ka = u() * Math.PI * 2;
        const kr = nestRadius * Math.sqrt(u());
        this.px[i] = (world.nestX + Math.cos(ka) * kr + world.w) % world.w;
        this.py[i] = (world.nestY + Math.sin(ka) * kr + world.h) % world.h;
        this.hx[i] = 0; this.hy[i] = 0;
        this.load[i] = 0; this.carryT[i] = 0;
        this.forageT[i] = 0; this.misses[i] = 0;
        this.wallSide[i] = 0;   // 重生即新蚁: 沿墙偏好重新定侧
        this.memNA[i] = 0; this.memNB[i] = 0; this.memIA[i] = 0; this.memFail[i] = 0; this.memTrips[i] = 0;
        this.memLA[i] = 0; this.memLB[i] = 0;   // 新蚁没有路线(P2.4)
        this.tumble[i] = 1 + u() * 20;
        this.pauseT[i] = 1 + u();
        this.seedNoise[i] = this._s;
        continue;
      }

      // ---- 6.沉积(load>0 才沉积) ----
      // 惊逃蚁也照常沉积(P2.2): 它活着且成功避开了危险, 沿逃逸曲线铺出的正是
      // 绕开捕食者的改道 skirt——改道由群体铺出来, 不禁沉积(禁了改道永远成不了形)。
      if (out.deposit > 0) {
        field.deposit(this.px[i], this.py[i], out.deposit);
      }

      // ---- 状态转换(允许的简单逻辑) ----
      // 碰食物：load 连续上升
      const fi = world.foodAt(this.px[i], this.py[i]);
      if (fi >= 0 && this.load[i] < 1) {
        const prev = this.load[i];
        const add = Math.min(foodLoadRate * dt, 1 - prev);
        this.load[i] = prev + add;
        if (prev === 0) {
          this._loaded++;
          this.forageT[i] = 0;  // 开始搬运,觅食计时清零(P1.9)
          this.misses[i] = 0;   // 成功重置满信任(P1.9)
          // 路线被证实(P2.4): 这一趟记的 B 提交成 A, 扑空计数清零。少于 2 点不提交
          // (一步都没走就撞上食物, 那条"路线"没有信息量, 留着旧的 A 更准)。
          if (memOn) {
            const nb = this.memNB[i];
            // 走通验证(P2.3.3): 这一趟是不是**沿着 A 走到大半**才吃到食物的? 是 ⇒ 同一个结论被独立
            // 验证第二次, 成熟度 +1。阈值 0.6 与下面"扑空该不该算在路线头上"用的是同一个比例判据,
            // 不引入新的绝对尺度(薄场只改变闻不到路的时长, 不该顺手改变记忆的权威)。
            const followed = this.memNA[i] > 0 && this.memIA[i] >= this.memNA[i] * 0.6;
            if (followed && this.memTrips[i] < 255) this.memTrips[i]++;
            // 只接受"不比现有路线长"的新路线(留 5% 容差, 免得被一次绕行的噪声卡住不更新)。
            // 有了这条, 记忆通道才会逐趟收敛到走廊; 没有它, 第一趟的弯路被永久焊死。
            if (nb >= 2 && (this.memNA[i] === 0 || this.memLB[i] <= this.memLA[i] * 1.05)) {
              const cbase = i * MEM_WPTS * 2;
              // 终点钉住"咬到食物的这一刻"(P2.4): 记录只在走满一个 memStep 时才落点, 所以 B 的
              // 最后一点平均还差半个到一个 memStep 才真到食盘边上。真实蚁的路线记忆是**连着目标物
              // 位置**的(它记的是"这条路通向那堆东西"), 不补这一下等于每趟都让它"到了附近再自己找"。
              // 实测: 400 蚁小群(集体通道弱→记忆份额大)下 K_mem=2 吞吐只有基线 86%, 主要就是这段
              // 未闭合的尾差; 补上后差距收窄(见 METRICS 的验收⑤)。**记满 32 点时不补**, 那种超长
              // 路线本来就该被淘汰, 不值得为它挪一次数组。
              let na2 = nb;
              let la2 = this.memLB[i];
              if (na2 < MEM_WPTS) {
                let pdx = this.px[i] - this.memB[cbase + (na2 - 1) * 2];
                let pdy = this.py[i] - this.memB[cbase + (na2 - 1) * 2 + 1];
                if (pdx > hw) pdx -= world.w; else if (pdx < -hw) pdx += world.w;
                if (pdy > hh) pdy -= world.h; else if (pdy < -hh) pdy += world.h;
                const pd = Math.hypot(pdx, pdy);
                if (pd > 1) {
                  this.memB[cbase + na2 * 2] = this.px[i];
                  this.memB[cbase + na2 * 2 + 1] = this.py[i];
                  na2++; la2 += pd;
                }
              }
              for (let k = 0; k < na2 * 2; k++) this.memA[cbase + k] = this.memB[cbase + k];
              this.memNA[i] = na2;
              this.memLA[i] = la2;
              this.memIA[i] = 0;
              this.memFail[i] = 0;
              // 换上新线就重新验证: 没跟自己的线(followed=false) ⇒ 这条线一次都没被证实过, 从 1 开始;
              // 跟到大半才换的 ⇒ 新线就是刚走过的那条走廊的改进版, 成熟度延续上面 +1 的结果。
              if (!followed) this.memTrips[i] = 1;
            }
            this.memNB[i] = 0;   // 负重段不记路线, 下一趟出门从头记
            this.memLB[i] = 0;
          }
        }
        const f = world.foodPatches[fi];
        f.amount -= add;  // 吃食物，食物会逐渐减少
        firstFoodAt = firstFoodAt < 0 ? i : firstFoodAt;
      }

      // 负重计时
      if (this.load[i] > 0) {
        this.carryT[i] += dt;
      } else {
        this.carryT[i] = 0;
      }

      // 到家卸货：真实位置进巢盘(环面距离)。卸货是物理事件——食物真的进了巢——
      // 所以只认物理抵达, 不看路径积分 h: 旧版只查 |h|<nestRadius, 会被"h 漏损/
      // 绕圈衰减归零"的蚂蚁钻空——站在食物上每步白拿 0.008 载荷又当步卸掉,
      // 成 60 次/s 的永动卸货机(predator_check 管饱食物下复现, 单只顶整群吞吐)。
      // 附带的收益(自愈): 惊逃打乱 h 后的迷路负重蚁, 只要最终晃进巢盘就能把
      // 食物真实入库并就地清零 h, 不必等 h 自己漏光——恐慌过后的经济恢复由此加快。
      if (this.load[i] > 0) {
        let ddx = this.px[i] - world.nestX, ddy = this.py[i] - world.nestY;
        if (ddx > world.w / 2) ddx -= world.w; else if (ddx < -world.w / 2) ddx += world.w;
        if (ddy > world.h / 2) ddy -= world.h; else if (ddy < -world.h / 2) ddy += world.h;
        if (ddx * ddx + ddy * ddy < nestRadius * nestRadius) {
          const delivered = this.load[i];   // P2.5: 入库量按**实际载量**记, 不假设它总是满的 1.0
          this.load[i] = 0;
          this.hx[i] = 0;
          this.hy[i] = 0;
          this.carryT[i] = 0;
          this.forageT[i] = 0;  // 新的一轮觅食计时(P1.9)
          this._loaded--;
          this.deliveries++;
          if (survOn) {
            // 入库。超过 storageCap 的部分**溢掉**并如实记账——不是"消失":
            // 没有这条上限, 富场景下储备会以 10 单位/秒 无限涨, "饥荒"这个机制就永远测不出来。
            this.inflow += delivered;
            const space = storageCap - this.reserve;
            const put = space > 0 ? Math.min(delivered, space) : 0;
            this.reserve += put;
            this.overflow += delivered - put;
          }
          if (memOn) { this.memIA[i] = 0; this.memNB[i] = 0; this.memLB[i] = 0; }  // 下一趟从 A 的起点重放(P2.4)
          // 卸货后在巢里磨蹭一会儿再出门(交卸/整理触角); 从该蚁自己的随机流取时长,
          // 所以要把 _s 重新写回 seedNoise。nestDwell=0 时不掷随机数, 旧行为不变。
          if (nestDwell > 0) {
            this.pauseT[i] = nestDwell * (0.5 + u());
            // 时长只给基准: "夜里/雨中宅巢、雨前抢收涌出"改由上面的走表速率实现。旧写法在这
            // 里乘 dwellMul, 把乘数冻结在卸货那一刻, 而钟是连续余弦、一整趟行程 ≈15s 与滞留
            // 同量级 → 钟变了滞留没变, 深夜压不住(验收③实测仅 1.5×)。
            this.seedNoise[i] = this._s;
          }
        }
      }

      // 迷路弃货泄压阀：负重超过 carryTimeout 秒
      if (this.carryT[i] > carryTimeout && this.load[i] > 0) {
        this.load[i] = 0;
        // 只丢货, 不清航位推算: 真实蚂蚁不会因为放下叶片就忘掉家在哪个方向。旧写法在这里
        // 把 h 清零, 等于把"知道回家方向"的蚁变成真迷路, 并把它的参考点钉死在野外——那是
        // 假"巢内滞留"的第二个来源(见下方返巢结算的 P2.3 修正)。弃货后它仍凭 h 直接走回家。
        this.carryT[i] = 0;
        this.forageT[i] = 0;
        this._loaded--;
        this.timeouts++;
      }

      // 觅食超时返巢(P1.9): returning 模式由 ant.step 导航(不跟信息素, 凭路径积分);
      // 到巢清空航位推算, 歇一会儿再出门。失败同时记一次 miss, 折扣下轮的跟路信任。
      // forageTimeout=0 时永不触发(旧行为)。
      // P2.3 修正: "到家"必须**物理到家**(环面距离进巢盘), 不能只看 |h|<nestRadius。
      // |h| 判定等于允许蚂蚁在巢外最多一巢半径处领一份"巢内滞留", 而结算同时把 h 清零——
      // 航位推算的参考点就此被钉在那个假想的家上, 每判一次往外漂一点。实测(天气全关的
      // perf_check 布局跑 3700 步, 可重跑 MODE=phantom node weather_diag.mjs)已有 21.0% 的蚁
      // (1050/5000)参考点漂出巢盘、最大外漂 114;昼夜节律一开(MODE=dwell)滞留被放大到 20~70s,
      // 半数群体站在野地里"蛰巢":深夜巢外 3087 只里 2547 只挂着滞留计——内源钟怎么加压都
      // 压不动它们(验收③原先卡在 1.5× 的元凶)。修后两项读数都归 0。
      // 这与 P2.2"卸货必须纯物理判定"是同一条教训的两半: 进巢结算与 h 清零都只认物理位置。
      // 修好后 h 的参考点恒等于巢, returning 的蚁必然真的走回巢盘才结算。
      if (this.load[i] === 0 && forageTimeout > 0 && this.forageT[i] > forageTimeout) {
        let hdx = this.px[i] - world.nestX, hdy = this.py[i] - world.nestY;
        if (hdx > world.w / 2) hdx -= world.w; else if (hdx < -world.w / 2) hdx += world.w;
        if (hdy > world.h / 2) hdy -= world.h; else if (hdy < -world.h / 2) hdy += world.h;
        if (hdx * hdx + hdy * hdy < nestRadius * nestRadius) {
          this.hx[i] = 0;
          this.hy[i] = 0;
          this.forageT[i] = 0;
          this.misses[i] = Math.min(3, this.misses[i] + 1);
          this.aborts++;
          // 这趟空手而归(P2.4): 路线记一次失败, 权重按 memForget 线性衰减; 衰减到底就把 A
          // 整条丢掉, 退回纯信息素探索。真实蚁对固定路线的忠诚是有代价的——食物被搬走、
          // 路被切断时它们会改线, 而不是走到死。
          if (memOn) {
            this.memNB[i] = 0; this.memLB[i] = 0;   // 这趟失败的 excursion 不提交
            // **归因**: 只有把这根线走到大半仍然扑空, 才算路线的错。夜里/低温下蚂蚁根本没走出
            // 巢盘就被内源钟催回去, 那是身体的失败不是地图的失败。第一版无差别记账, 一个 120s
            // 长的夜晚(forageTimeout 只有 30s, 一夜能刷 4 次"扑空")把整群记忆清零,
            // 于是第三天清晨记忆组吞吐归 0(实测)——恰好把这条机制想解决的问题自己又制造了一遍。
            if (this.memIA[i] >= this.memNA[i] * 0.6) {
              const f = this.memFail[i] + 1;
              if (f >= memForget) { this.memNA[i] = 0; this.memIA[i] = 0; this.memFail[i] = 0; this.memTrips[i] = 0; }
              else this.memFail[i] = f;
            }
            // 指针归零: 这条线下一趟得从**巢这一头**重走。漏掉这一行是验收 ③b 首跑 FAIL 的真凶——
            // 夜里扑空的蚁带着停在路线尾部的 memIA 回家, 第二天出门时"向前扫"直接从末尾接上,
            // 于是目标航点在 220 单位之外 ⇒ onRoute=0 ⇒ 整个群体的记忆被**静默解除**(诊断台实测
            // dWp 40→103、exh 0%→24%), 黎明吞吐逐日崩塌 9796→3950→559。同一个指针还被上面的归因
            // 读, 所以它一旦变脏, 连"这次扑空该不该算在路线头上"都会算错(覆盖率被误砍到 87%)。
            // 到家 = 一趟走完, 与"卸货即归零"是同一条规则: 只有真的回到家才重置;半路弃货不归零,
            // 那才保留得住"从路线中段重新接上"的能力(真实蚁回找熟路就是这么走的)。
            this.memIA[i] = 0;
          }
          if (nestDwell > 0) {
            this.pauseT[i] = nestDwell * (0.5 + u());
            // 时长只给基准: "夜里/雨中宅巢、雨前抢收涌出"改由上面的走表速率实现。旧写法在这
            // 里乘 dwellMul, 把乘数冻结在卸货那一刻, 而钟是连续余弦、一整趟行程 ≈15s 与滞留
            // 同量级 → 钟变了滞留没变, 深夜压不住(验收③实测仅 1.5×)。
            this.seedNoise[i] = this._s;
          }
        }
      }

      // ---- P2.5 能量与生死: 代谢 → 进食 → 两条死亡通道 ----
      // 放在这只蚁**所有**状态转移之后: 卸货(入库)与超时返巢都已落定, 于是"到家这一步就能吃到"
      // 是同一步内的事实, 不必额外等一步——否则一趟 13s 的行程末尾会凭空多一次饿判。
      if (survOn) {
        let wdx = this.px[i] - pxi, wdy = this.py[i] - pyi;
        if (wdx > hw) wdx -= world.w; else if (wdx < -hw) wdx += world.w;
        if (wdy > hh) wdy -= world.h; else if (wdy < -hh) wdy += world.h;
        // 用**实际位移**而不是意图位移(out.dx/dy): 被墙挡掉的路不该收钱(真实蚁撞墙站着不多烧 ATP)。
        // 也不动既有的 Math.hypot 调用(铁律 5), 这里是新写的独立表达式。
        const moved = Math.sqrt(wdx * wdx + wdy * wdy);
        let e = this.energy[i] - metBasal * dt - moved * (this.load[i] > 0 ? metLoad : metWalk);
        let ndx = this.px[i] - world.nestX, ndy = this.py[i] - world.nestY;
        if (ndx > hw) ndx -= world.w; else if (ndx < -hw) ndx += world.w;
        if (ndy > hh) ndy -= world.h; else if (ndy < -hh) ndy += world.h;
        const atHome = ndx * ndx + ndy * ndy < nestRadius * nestRadius;
        if (!atHome) this.workT[i] += dt;   // 只有外勤时间折旧(巢内可活数月, ANT_BIOLOGY §四)
        if (atHome && e < ENERGY_FULL && this.reserve > 0) {
          // 到巢从储备取食。真实是口对口交哺(trophallaxis)要花时间的, 这里一步吃饱——
          // **工程需要**: 少一个 feedRate 参数, 代价是"掠过巢心的那 1/60 秒也能吃饱"这点便宜。
          const bite = Math.min((ENERGY_FULL - e) / cropFood, this.reserve);
          this.reserve -= bite; this.foodEaten += bite;
          e += bite * cropFood;
        }
        this.energy[i] = e;
        if (e < this.eMin) this.eMin = e;
        if (e <= 0) {
          this.starved++;
          this._markDead(i, alarmField, corpseAlarm);
        } else if (workLife > 0 && this.workT[i] > 0 && (this.stepCount % WEAR_ROLL_EVERY) === 0) {
          // 第二条死亡通道: 外勤折寿(Weibull 型上升风险率, 推导在 sim/energy.js)。
          // 每 WEAR_ROLL_EVERY 步才掷一次是**算力**决定不是行为决定: 5000 蚁每步一次 exp 太贵,
          // 而 hazard 在分钟尺度上才动, 0.53s 的采样间隔绰绰有余。
          const p = wearRollP(this.workT[i] * lifeScale(this.seedNoise[i]), workLife, WEAR_ROLL_EVERY * dt);
          const gone = u() < p;
          // 上面的循环前段已经写过一次 seedNoise, 那次写回发生在**本块消耗之前**, 所以这里必须再写。
          this.seedNoise[i] = this._s;
          if (gone) { this.wornOut++; this._markDead(i, alarmField, corpseAlarm); }
        }
      }
    }

    // ---- P2.5 收尾 pass: 先收尸压缩, 再结算产蚁 ----
    // 顺序不许反: 新生儿若占在刚腾出的位上, 下一次循环读到的就是它, 而它这一步什么都没走过。
    if (survOn) {
      if (this._deadN > 0) this._compactDead();
      if (birthRate > 0) this._birthsPass(world, nestRadius, broodT, birthRate, birthFill, birthCost, dt, params);
    }

    this.firstFoodAnt = firstFoodAt;
  }

  // 按身份找格子(P2.5): 收尸压缩会把活蚁搬进死位, 于是"第 7 格"这个下标不再能代表同一只蚁。
  // 一次线性扫(活蚁 ≤ capacity)——只服务于"我跟的那只还在不在", 每帧最多一次, 不进热路径。
  // 找不到 = 这一只已经死了(uid 永不复用, 所以找不回就是真没了, 不是搬到别处)。
  indexOfUid(uid) {
    if (!(uid >= 0)) return -1;
    for (let i = 0; i < this.population; i++) if (this.uid[i] === uid) return i;
    return -1;
  }

  // 统计有多少蚂蚁在“觅食”(load>0)。增量维护,O(1)。
  // 收一具尸(P2.5): 主循环里只登记下标, 真正的数组搬动在整步结束后一次做完(文件头 ②)。
  // 负载当场清零并回退 _loaded 计数——那半截食物**丢了**, 不进 inflow 账(诚实指标: 死在路上的
  // 载货不该算成入库量, 正如 P2.2 那次"站着的永动卸货机"不该算)。
  _markDead(i, alarmField, corpseAlarm) {
    this._dead[this._deadN++] = i;
    this.deaths++;
    if (this.load[i] > 0) { this.load[i] = 0; this._loaded--; }
    if (alarmField && corpseAlarm > 0) {
      // 真实的死亡化学痕迹是油酸类**尸酸**, 它触发的是搬尸/垃圾堆(本模型不做搬尸, 工程需要),
      // 这里只保留"死亡处留下一挥发的报警信号"这一层, 剂量远小于捕杀喷溅(见 config 的 corpseAlarm)。
      alarmField.deposit(this.px[i], this.py[i], corpseAlarm);
      this.lastAlarmStep = this.stepCount;
    }
  }

  // swap-remove 压缩: 每个死位用队尾的活蚁填。**必须降序处理**, 否则可能把另一具尸体搬进活蚁区。
  // 降序时 pop 恒 > d(所有比 d 大的死位已经缩掉), 且写只发生在 > d 的死位上 ⇒ d 上的尸体还没被动过。
  // 因为整块在主循环**之外**, 被搬进来的那只不会错过本步——它本步已经走完了(比当场删元素干净)。
  _moveAnt(d, s) {
    this.px[d] = this.px[s]; this.py[d] = this.py[s]; this.theta[d] = this.theta[s];
    this.hx[d] = this.hx[s]; this.hy[d] = this.hy[s]; this.load[d] = this.load[s];
    this.tumble[d] = this.tumble[s]; this.lastAsym[d] = this.lastAsym[s];
    this.seedNoise[d] = this.seedNoise[s];
    this.carryT[d] = this.carryT[s]; this.pauseT[d] = this.pauseT[s];
    this.forageT[d] = this.forageT[s]; this.misses[d] = this.misses[s];
    this.speedMul[d] = this.speedMul[s]; this.turnMul[d] = this.turnMul[s]; this.depMul[d] = this.depMul[s];
    this.wallSide[d] = this.wallSide[s];
    this.memNA[d] = this.memNA[s]; this.memNB[d] = this.memNB[s]; this.memIA[d] = this.memIA[s];
    this.memLX[d] = this.memLX[s]; this.memLY[d] = this.memLY[s];
    this.memFail[d] = this.memFail[s]; this.memTrips[d] = this.memTrips[s];
    this.memLA[d] = this.memLA[s]; this.memLB[d] = this.memLB[s];
    const m = MEM_WPTS * 2;
    this.memA.copyWithin(d * m, s * m, s * m + m);
    this.memB.copyWithin(d * m, s * m, s * m + m);
    // P2.5 的四只数组: uid 跟着搬才谈得上"个体身份"(跟拍因此能知道我跟的那只被搬去了哪一格)
    this.uid[d] = this.uid[s]; this.energy[d] = this.energy[s];
    this.workT[d] = this.workT[s]; this.broodT[d] = this.broodT[s];
  }

  _compactDead() {
    for (let k = this._deadN - 1; k >= 0; k--) {
      const d = this._dead[k];
      const last = --this.population;
      if (d !== last) this._moveAnt(d, last);
    }
    this._deadN = 0;
  }

  // 产蚁(P2.5): 储备高于 birthFill 才有资格扩军, 每只再扣 birthCost。
  // 三个门槛各管一件事: birthFill=先攒够家底再招人(真实饥荒优先保蚁后与幼虫)、
  // birthCost=招人要有代价、capacity=巢的容纳上限(见文件头 ①)。
  _birthsPass(world, nestRadius, broodT, birthRate, birthFill, birthCost, dt, params) {
    if (this.population >= this.capacity || this.reserve < birthFill) {
      this._birthAcc = 0;   // 没条件就把攒下的倾向**丢掉**: 攒三天再瞬间爆窝不是真蚁的行为
      return;
    }
    this._birthAcc += dt * birthRate * this.population;
    if (this._birthAcc > BIRTH_ACC_CAP) this._birthAcc = BIRTH_ACC_CAP;
    while (this._birthAcc >= 1 && this.population < this.capacity && this.reserve >= birthCost) {
      this._birthAcc -= 1;
      this.reserve -= birthCost;
      this.birthFood += birthCost;
      this.births++;
      this._spawn(world, nestRadius, broodT, params);
    }
  }

  // 生一只: 位置在巢盘内均匀散布, 性格倍率与老蚁同一套推导(从 seedNoise 位段), 但没有路线、没有外勤史。
  _spawn(world, nestRadius, broodT, params) {
    const i = this.population++;
    const su = this._su;
    const a = su() * Math.PI * 2;
    const r = nestRadius * Math.sqrt(su());
    this.px[i] = (world.nestX + Math.cos(a) * r + world.w) % world.w;
    this.py[i] = (world.nestY + Math.sin(a) * r + world.h) % world.h;
    this.theta[i] = su() * Math.PI * 2;
    this.hx[i] = 0; this.hy[i] = 0;
    this.load[i] = 0; this.carryT[i] = 0;
    this.tumble[i] = 1 + su() * 20;
    this.lastAsym[i] = 0; this.wallSide[i] = 0;
    this.forageT[i] = 0; this.misses[i] = 0;
    this.seedNoise[i] = (su() * 0xffffffff) | 0;
    const sv = params.speedVar || 0, tv = params.turnVar || 0, dv = params.depositVar || 0;
    const s = this.seedNoise[i] >>> 0;
    this.speedMul[i] = 1 - sv + (s & 2047) / 2047 * 2 * sv;
    this.turnMul[i] = 1 - tv + ((s >>> 11) & 2047) / 2047 * 2 * tv;
    this.depMul[i] = 1 - dv + ((s >>> 22) & 1023) / 1023 * 2 * dv;
    this.memNA[i] = 0; this.memNB[i] = 0; this.memIA[i] = 0;
    this.memFail[i] = 0; this.memTrips[i] = 0; this.memLA[i] = 0; this.memLB[i] = 0;
    this.energy[i] = ENERGY_FULL;      // 出生即满胃: birthCost 那份粮就是给它备的口粮
    this.workT[i] = 0;                 // 没有外勤史
    this.broodT[i] = broodT * (0.7 + 0.6 * su());   // 巢内服务期 ±30% 个体散布
    this.pauseT[i] = this.broodT[i];   // 一出生就停在巢里做内勤
    this.uid[i] = this._nextUid++;     // 新身份(永不复用: 老 uid 死了就是死了, 跟拍不会认错蚁)
  }
  loadedCount() {
    return this._loaded;
  }

  // 访问单只蚂蚁状态快照（inspector 用）
  snapshot(i) {
    return {
      px: this.px[i], py: this.py[i], theta: this.theta[i],
      hx: this.hx[i], hy: this.hy[i],
      load: this.load[i], tumble: this.tumble[i],
      carryT: this.carryT[i],
      uid: this.uid[i], energy: this.energy[i], workT: this.workT[i], broodT: this.broodT[i],
    };
  }
}
