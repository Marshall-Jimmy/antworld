// SoA 类型化数组存储整群蚂蚁 + 单步推进编排。
// 本模块不 import 任何渲染/DOM 代码，可 headless（node）运行。
//
// 性能注记：本文件是热路径（每步 N 只蚂蚁）。所有临时对象（RNG 闭包、
// ant.js 的 state/out 槽、传感器坐标）都在构造时预分配复用，步进循环零 GC 分配。
// 数值行为与旧版 bit 级一致（同样的表达式顺序），可用固定 seed 校验和复现。

import { step as antStep } from './ant.js';

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
    this._st = { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, pauseT: 0, speedMul: 1, turnMul: 1, depMul: 1, forageT: 0, misses: 0, wfl: 0, wfm: 0, wfr: 0, afl: 0, afm: 0, afr: 0, wallSide: 0 };
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
    const n = this.count;
    this.stepCount++;
    const {
      sensorAngle, sensorDist, speed,
      foodLoadRate, carryTimeout, nestRadius, nestDwell, forageTimeout, missRecover,
    } = params;

    let firstFoodAt = -1; // 本步首次吃到食物的蚂蚁索引
    const st = this._st, out = this._out, u = this._u, gauss = this._gauss;
    const physarum = params.sensorMode === 'physarum'; // P1.8: 三触角模式需额外采样前触角
    const wallOn = world.wallCount > 0;                // P2.1: 有墙才启用墙感知/阻挡(零开销门控)
    // 巢内滞留走生物钟表(P2.3): 只有"环境钟真的走别的速率"时才付这个判定的代价。
    // pauseRate === 1(两开关全关 → env 为 null; 开着的正午晴天恒等于 1)时整块短路, 逐位不变。
    const dwellClock = !!env && env.pauseRate !== 1;

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
      st.pauseT = pauseSet;
      st.speedMul = this.speedMul[i]; st.turnMul = this.turnMul[i]; st.depMul = this.depMul[i];
      st.forageT = this.forageT[i];
      st.misses = this.misses[i];
      st.wfl = wfl; st.wfm = wfm; st.wfr = wfr;
      st.afl = afl; st.afm = afm; st.afr = afr;
      st.wallSide = this.wallSide[i];
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
        if (this.load[i] > 0) this._loaded--;
        const ka = u() * Math.PI * 2;
        const kr = nestRadius * Math.sqrt(u());
        this.px[i] = (world.nestX + Math.cos(ka) * kr + world.w) % world.w;
        this.py[i] = (world.nestY + Math.sin(ka) * kr + world.h) % world.h;
        this.hx[i] = 0; this.hy[i] = 0;
        this.load[i] = 0; this.carryT[i] = 0;
        this.forageT[i] = 0; this.misses[i] = 0;
        this.wallSide[i] = 0;   // 重生即新蚁: 沿墙偏好重新定侧
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
          this.load[i] = 0;
          this.hx[i] = 0;
          this.hy[i] = 0;
          this.carryT[i] = 0;
          this.forageT[i] = 0;  // 新的一轮觅食计时(P1.9)
          this._loaded--;
          this.deliveries++;
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
          if (nestDwell > 0) {
            this.pauseT[i] = nestDwell * (0.5 + u());
            // 时长只给基准: "夜里/雨中宅巢、雨前抢收涌出"改由上面的走表速率实现。旧写法在这
            // 里乘 dwellMul, 把乘数冻结在卸货那一刻, 而钟是连续余弦、一整趟行程 ≈15s 与滞留
            // 同量级 → 钟变了滞留没变, 深夜压不住(验收③实测仅 1.5×)。
            this.seedNoise[i] = this._s;
          }
        }
      }
    }

    this.firstFoodAnt = firstFoodAt;
  }

  // 统计有多少蚂蚁在“觅食”(load>0)。增量维护,O(1)。
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
    };
  }
}
