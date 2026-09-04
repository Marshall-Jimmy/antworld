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
    this._persInit = false;
    this.deliveries = 0;   // 累加:成功回巢卸货次数
    this.timeouts = 0;     // 累加:迷路弃货次数
    this.aborts = 0;       // 累加:空手觅食超时返巢次数(P1.9)
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
    this._st = { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, pauseT: 0, speedMul: 1, turnMul: 1, depMul: 1, forageT: 0, misses: 0 };
    this._out = { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, deposit: 0, pauseT: 0, forageT: 0 };

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

  // 单步推进整群。field: 信息素场; world: 食物/巢; params: 参数表; dt: 步长。
  step(field, world, params, dt) {
    const n = this.count;
    const {
      sensorAngle, sensorDist, speed,
      foodLoadRate, carryTimeout, nestRadius, nestDwell, forageTimeout, missRecover,
    } = params;

    let firstFoodAt = -1; // 本步首次吃到食物的蚂蚁索引
    const st = this._st, out = this._out, u = this._u, gauss = this._gauss;
    const physarum = params.sensorMode === 'physarum'; // P1.8: 三触角模式需额外采样前触角

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
      const pxi = this.px[i], pyi = this.py[i];
      const theta = this.theta[i];
      const left = theta + sensorAngle, right = theta - sensorAngle;
      const fl = field.sample(pxi + Math.cos(left) * sensorDist, pyi + Math.sin(left) * sensorDist);
      const fr = field.sample(pxi + Math.cos(right) * sensorDist, pyi + Math.sin(right) * sensorDist);
      // 前触角: 仅 physarum 模式采样(diff 模式零开销)
      const fm = physarum
        ? field.sample(pxi + Math.cos(theta) * sensorDist, pyi + Math.sin(theta) * sensorDist)
        : 0;

      // ---- ant.step 纯函数推进(复用 state/out 槽) ----
      st.px = pxi; st.py = pyi; st.theta = theta;
      st.hx = this.hx[i]; st.hy = this.hy[i];
      st.load = this.load[i]; st.tumble = this.tumble[i];
      st.lastAsym = this.lastAsym[i];
      st.pauseT = this.pauseT[i];
      st.speedMul = this.speedMul[i]; st.turnMul = this.turnMul[i]; st.depMul = this.depMul[i];
      st.forageT = this.forageT[i];
      st.misses = this.misses[i];
      antStep(st, fl, fr, fm, dt, params, gauss, u, out);

      // 写回 + toroidal 边界
      this.px[i] = (out.px + world.w) % world.w;
      this.py[i] = (out.py + world.h) % world.h;
      this.theta[i] = out.theta;
      this.hx[i] = out.hx;
      this.hy[i] = out.hy;
      this.load[i] = out.load;
      this.tumble[i] = out.tumble;
      this.lastAsym[i] = out.lastAsym;
      this.pauseT[i] = out.pauseT;
      this.forageT[i] = out.forageT;
      this.seedNoise[i] = this._s;
      // 失败信任缓慢回复(每秒恢复 missRecover 次); 全零时零开销
      if (this.misses[i] > 0) {
        const m = this.misses[i] - dt * (missRecover || 0);
        this.misses[i] = m > 0 ? m : 0;
      }

      // ---- 6.沉积(load>0 才沉积) ----
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

      // 到家卸货：|h| < nestRadius
      if (Math.hypot(this.hx[i], this.hy[i]) < nestRadius && this.load[i] > 0) {
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
          this.seedNoise[i] = this._s;
        }
      }

      // 迷路弃货泄压阀：负重超过 carryTimeout 秒
      if (this.carryT[i] > carryTimeout && this.load[i] > 0) {
        this.load[i] = 0;
        this.hx[i] = 0;
        this.hy[i] = 0;
        this.carryT[i] = 0;
        this.forageT[i] = 0;
        this._loaded--;
        this.timeouts++;
      }

      // 觅食超时返巢(P1.9): returning 模式由 ant.step 导航(不跟信息素, 凭路径积分);
      // 到巢清空航位推算, 歇一会儿再出门。失败同时记一次 miss, 折扣下轮的跟路信任。
      // forageTimeout=0 时永不触发(旧行为)。
      if (this.load[i] === 0 && forageTimeout > 0 && this.forageT[i] > forageTimeout
          && Math.hypot(this.hx[i], this.hy[i]) < nestRadius) {
        this.hx[i] = 0;
        this.hy[i] = 0;
        this.forageT[i] = 0;
        this.misses[i] = Math.min(3, this.misses[i] + 1);
        this.aborts++;
        if (nestDwell > 0) {
          this.pauseT[i] = nestDwell * (0.5 + u());
          this.seedNoise[i] = this._s;
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
