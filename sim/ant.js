// ★单只蚂蚁算法，必须纯函数。输入→输出，不访问外部。
// 输入：自身状态 + 左右传感器采样值 + 给蚂蚁的随机函数和参数。
// 输出：新状态 + 沉积量（信息素）。

// 输入状态：{ px, py, theta, hx, hy, load, tumble, seedNoise,
//             pauseT = 0, speedMul = 1, turnMul = 1, depMul = 1, forageT = 0, misses = 0,
//             wfl/wfm/wfr = 0 (三触角撞墙标志, P2.1),
//             wallSide = 0 (沿墙侧偏好 ±1/0, 贴墙期间保持, P2.2),
//             afl/afm/afr = 0 (三触角报警信息素浓度, P2.2) }
// 参数：{ sensorAngle, sensorDist, K_chem, K_home, K_out, sigma, tumbleAmp, alpha,
//         speed, leak, depositRate, saturationMode, K_sat, emptyDeposit,
//         sensorMode, K_steer, K_conf...(P1.7), K_wall(P2.1),
//         K_alarm, alarmSens(P2.2),
//         pauseRate, pauseTime, forageTimeout(P1.9) }
// gauss() → 标准正态分布采样
// uniform() → [0,1)均匀分布
// 关于 Lévy 幂律抽样：tumble ~ U^(-1/α)，重尾当 α < 2

// ---- 感知饱和（Weber 定律）：把绝对浓度 F 换成蚂蚁实际"尝到"的相对量 ----
// off: 原样   mm: F/(F+K)   log: ln(1 + F/K)
// 三种都单调递增，所以不改变梯度符号（该往哪拐仍往哪拐），只压掉热点支配。
export function sense(F, mode, K) {
  if (mode === 'mm')  return F / (F + K);
  if (mode === 'log') return Math.log(1 + F / K);
  return F; // off / 未定义
}

// ---- P1.7 置信度: 把被扔掉的 (FL+FR) 捡回来 ----
// conf = smoothstep(0, K_conf, sl+sr)。K_conf≤0 时恒为 1(关掉,退化回原始行为)。
export function confOf(sl, sr, K_conf) {
  if (K_conf <= 0) return 1;
  const t = Math.max(0, Math.min(1, (sl + sr) / K_conf));
  return t * t * (3 - 2 * t);
}

export function step(
  state,
  fl, fr, fm,        // 左、右、前传感器场采样(fm 仅 physarum 模式使用,diff 模式传 0)
  dt,                // 步长时间
  params,
  gauss, uniform,
  out                // 可选: 复用输出槽(热路径零分配); 缺省则新建,保持纯函数语义
) {
  const {
    sensorAngle, sensorDist,
    K_chem, K_home, K_out,
    sigma, tumbleAmp, alpha,
    speed, leak, depositRate,
    sensorMode, K_steer,
    saturationMode, K_sat, emptyDeposit,
    K_conf, sigma_lost, sigma_road, cautionSpeed, K_return,
    confA, confB, confC, confD,
    pauseRate = 0, pauseTime = 0, forageTimeout = 0,
    K_wall = 0,
    K_alarm = 0, alarmSens = 0.02,
  } = params;

  let { px, py, theta, hx, hy, load, tumble, lastAsym = 0,
        pauseT = 0, speedMul = 1, turnMul = 1, depMul = 1, forageT = 0, misses = 0,
        wfl = 0, wfm = 0, wfr = 0,
        afl = 0, afm = 0, afr = 0,
        wallSide = 0 } = state;

  // 1. 感知: FL, FR 是原始浓度,先过饱和变成"尝到的量"
  const sl = sense(fl, saturationMode, K_sat);
  const sr = sense(fr, saturationMode, K_sat);
  const physarum = sensorMode === 'physarum';
  const sf = physarum ? sense(fm, saturationMode, K_sat) : 0;

  // 1b. 置信度(把 sum 捡回来): 稳在路脊上 sum 大 → conf→1; 掉进断口/路外 sum≈0 → conf→0
  // physarum 模式把前触角也计入总量(三触角都喂 conf)
  const conf = physarum ? confOf(sl + sf, sr, K_conf) : confOf(sl, sr, K_conf);
  if (confD) lastAsym += 0.1 * (Math.sign(sl - sr) - lastAsym); // 缓记"最后闻到路的一侧"

  // 1c. 觅食超时(P1.9): 空手太久就放弃觅食, 凭路径积分直接回家——不再跟随信息素。
  // 真实蚁群里不成功的觅食者会返巢休整; 死食物点上的轨迹则因无人强化而自然蒸发。
  // 这同时解掉"耗尽食物点上闭圈徘徊": 返巢模式压掉轨迹锁定, 蚂蚁按超时陆续散去。
  // forageTimeout=0 时恒为 false, 旧行为 bit 级不变。
  const returning = load === 0 && forageTimeout > 0 && forageT > forageTimeout;

  // 1d. 路径信任(P1.9): 空手失败次数越多越不信信息素路——觅食动力下降(真实蚁群行为)。
  // 没有它, 返巢休整的蚂蚁会在下一个 30s 周期被残余轨迹团再次捕获, 死点上养出常驻云团。
  // 找到食物立即恢复满信任(colony); 失败信任由 colony 按秒缓慢回复。misses=0 时 confEff=conf(旧行为)。
  const trust = 1 - 0.3 * (misses > 3 ? 3 : misses);   // 0→1, -0.3/次失败, 3 次封底 0.1
  const confEff = conf * (trust < 0.1 ? 0.1 : trust);

  // 2. 转向：各项直接加（权重是连续标量,不是状态机）
  let turn = 0;
  if (physarum) {
    // P1.8 · Jones(2010) 三触角规则: 前最强→直行; 左强→左转; 右强→右转;
    // 左右同强(且前非最强)→随机侧转。固定转速 K_steer, 与梯度大小无关
    // (对饱和高原免疫——只看排序不看差值)。
    if (!returning) {
      let steer = 0;
      if (sf >= sl && sf >= sr) steer = 0;
      else if (sl > sr) steer = K_steer;
      else if (sr > sl) steer = -K_steer;
      else steer = (uniform() < 0.5 ? K_steer : -K_steer);
      // A: 没路时不该锁(锁的是空气) —— 置信度调制同样作用于转向(含信任折扣)
      turn += confA ? steer * confEff : steer;
    }
  } else if (!returning) {
    // A: 横向锁定 —— 没路时不该锁(锁的是空气)
    const chem = K_chem * (sl - sr) * (1 - load);
    turn += confA ? chem * confEff : chem;
  }

  // bearing(h): h 本身 = 出发点 − 当前位置 = 回家方向向量，直接取其朝向
  const homeTheta = Math.atan2(hy, hx);
  // 负重回家、或觅食失败返巢(P1.9)时启用回家增益; 空手探索时不启用
  const homeW = load > 0 ? load : (returning ? 1 : 0);
  turn += K_home * Math.sin(homeTheta - theta) * homeW;
  // 出巢极性: 空手时沿 -h(离家向外) 被轻推,与 K_home 共用同一个路径积分向量;
  // 返巢模式下关掉(它和回家方向正好相反)
  if (!returning) {
    const outTheta = Math.atan2(-hy, -hx);
    turn += K_out * Math.sin(outTheta - theta) * (1 - load);
  }

  // B: 搜索强度 —— 路上压噪(动量带我走), 丢路/失宠局部搜索
  const noiseStd = confB ? (sigma_lost + (sigma_road - sigma_lost) * confEff) : sigma;
  turn += noiseStd * gauss();

  // D: 丢路时朝"最后闻到路的一侧"回环搜索(默认关)
  if (confD) turn += K_return * lastAsym * (1 - confEff);

  // 2a'. 墙避让(P2.1): 触角撞墙就转开——左墙→右转, 右墙→左转; 只有正前墙→沿墙滑行。
  // 早期版本逐步掷硬币定侧, 左右相消, 蚂蚁被钉死在墙前(对称抖动零净位移), 负重蚁
  // 到死也绕不过一道长墙(walls_check P2.2 发现)。真实蚂蚁沿墙走有个体的左右偏好
  // (惯用手), 故每只蚂蚁在本次贴墙期间保持同一侧: 首次贴墙掷硬币定侧(个体差异来自
  // 各自随机流, 群体两侧行为对称), 离墙(三触角全空)后清零, 下次贴墙重新定侧。
  // 双侧都堵(窄缝/夹道)时不干预, 让蚂蚁直线过缝(运动阻挡兜底)。
  // K_wall=0 或没墙(三标志全 0, colony 侧短路)时本块不触发、不消耗随机数——
  // no-wall 行为 bit 级不变。
  let wallSideOut = wallSide;
  if (K_wall > 0 && (wfl || wfm || wfr)) {
    let ws = 0;
    if (wfl && !wfr) ws = -K_wall;
    else if (wfr && !wfl) ws = K_wall;
    else if (wfm) {
      if (wallSideOut === 0) wallSideOut = uniform() < 0.5 ? 1 : -1;
      ws = wallSideOut * K_wall;
    }
    if (ws) turn += ws;
  } else {
    wallSideOut = 0;
  }

  // 2a''. 报警信息素规避(P2.2): 触角尝到 alarm(超过 alarmSens)即惊逃——哪侧浓就背对
  // 那侧拐, 两侧相近(迎面撞上)→掷硬币。惊逃蚁照常沉积轨迹(逃逸曲线正是改道 skirt,
  // 见沉积块注释); 报警信息素的释放只在捕杀喷溅(colony 侧), 惊逃蚁只响应不释放。
  // 无 alarm(三值全 0, colony 侧短路)时本块不触发、
  // 不消耗随机数——no-predator 行为 bit 级不变。
  const scared = K_alarm > 0 && (afl > alarmSens || afr > alarmSens || afm > alarmSens);
  if (scared) {
    if (afl - afr > alarmSens) turn -= K_alarm;
    else if (afr - afl > alarmSens) turn += K_alarm;
    else turn += (uniform() < 0.5 ? K_alarm : -K_alarm);
  }

  // 2b. 个体性格: 固定的转向倍率(大胆的走直线, 谨慎的多抖动)
  turn *= turnMul;

  // 2c. 微停顿(触角扫描): 空手觅食蚁偶尔停下原地扫视——转向照常积分,
  // 不平移不沉积(负重赶路的蚁从不停; 返巢中的蚁也不停, straight回家)。
  // pauseRate=0 时不掷随机数, 旧行为 bit 级不变。
  const paused = pauseT > 0;
  let pauseOut = paused ? pauseT - dt : 0;
  if (!paused && load === 0 && !returning && pauseRate > 0 && uniform() < pauseRate * dt) {
    pauseOut = pauseTime * (0.5 + uniform()); // 时长个体随机 0.5~1.5×
  }

  // 2d. 觅食计时(P1.9): 只在清醒觅食时累积(停顿不走表, 负重时由 colony 清零);
  // 超过 forageTimeout 触发上面的返巢模式, 到巢由 colony 结算。
  let forageOut = forageT;
  if (!paused && load === 0 && forageTimeout > 0) forageOut = forageT + dt;

  // 3. 翻滚：幂律抽样，重尾特征
  let tumbleOut = tumble - 1;
  if (tumbleOut <= 0) {
    turn += tumbleAmp * gauss();
    // 幂律: x = uniform^(-1/alpha)
    tumbleOut = Math.pow(Math.max(uniform(), 1e-6), -1 / alpha);
  }

  // 4. 积分位置和朝向（C: 速度谨慎 —— 主要加在负重蚂蚁上, 离路变慢, 直接打在吞吐指标上）
  theta += turn * dt;
  let effSpeed = speed * speedMul;
  if (paused) effSpeed = 0;
  else if (confC && load > 0) effSpeed *= (cautionSpeed + (1 - cautionSpeed) * confEff);
  const dx = Math.cos(theta) * effSpeed * dt;
  const dy = Math.sin(theta) * effSpeed * dt;
  px += dx;
  py += dy;

  // 5. 记忆：航位推算，每次减去自己刚走的一步；再缓慢遗忘
  hx -= dx;
  hy -= dy;
  hx *= (1 - leak * dt);
  hy *= (1 - leak * dt);

  // 6. 沉积：正常只负重时沉积; emptyDeposit 打开时空手也沉积(诊断用);
  // 停顿中的蚂蚁不沉积(原地不动不画路); depMul 给路加浓淡纹理。
  // 惊逃蚁(P2.2)照常沉积: 它活着且成功避开了危险, 逃逸曲线铺出的正是绕开
  // 危险源的改道 skirt——禁了沉积, 改道永远成不了形(predator_check 已证)。
  // 报警信息素的唯一来源是捕杀喷溅(colony 侧): 惊逃蚁若也喷洒, "闻到→惊逃→喷洒"
  // 会正反馈自持, 撤离捕食者后恐慌云永不消散( predator_check 已复现), 故只响应不释放。
  let deposit;
  if (paused) deposit = 0;
  else if (load > 0) deposit = depositRate * load * dt * depMul;
  else deposit = emptyDeposit ? depositRate * 0.3 * dt * depMul : 0;

  const o = out || { px: 0, py: 0, theta: 0, hx: 0, hy: 0, load: 0, tumble: 0, lastAsym: 0, deposit: 0, pauseT: 0, forageT: 0, dx: 0, dy: 0, wallSide: 0 };
  o.px = px; o.py = py; o.theta = theta;
  o.hx = hx; o.hy = hy;
  o.load = load; o.tumble = tumbleOut; o.lastAsym = lastAsym;
  o.deposit = deposit; o.pauseT = pauseOut; o.forageT = forageOut;
  o.dx = dx; o.dy = dy;   // 意图位移, 供 colony 做墙阻挡后的航位推算校正(P2.1)
  o.wallSide = wallSideOut;   // 沿墙侧偏好(±1/0), colony 写回供下一步沿用(P2.2)
  return o;
}

// ---- 辅助函数供调用者使用（不影响纯函数约束）----
// 计算感知点
export function sensorPoints(px, py, theta, sensorAngle, sensorDist) {
  const left = theta + sensorAngle;
  const right = theta - sensorAngle;
  return {
    flx: px + Math.cos(left) * sensorDist,
    fly: py + Math.sin(left) * sensorDist,
    frx: px + Math.cos(right) * sensorDist,
    fry: py + Math.sin(right) * sensorDist
  };
}