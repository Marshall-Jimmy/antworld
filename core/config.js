// 唯一参数源。UI 面板、存档、URL 分享全部从这里生成。
// schema 每项: { key, default, min, max, desc, step? }
// 描述要"人话"——面向观察者而非实现者。

export const SCHEMA = [
  // ---- 世界 ----
  { key: 'worldW',    default: 2000, min: 400,  max: 6000, step: 50,  desc: '世界宽度' },
  { key: 'worldH',    default: 1300, min: 300,  max: 4000, step: 50,  desc: '世界高度' },
  { key: 'gridCell',  default: 8,    min: 2,    max: 24,   step: 1,   desc: '信息素场分辨率(每个格子多少世界单位)' },
  { key: 'antCount',  default: 5000, min: 10,   max: 20000,step: 100, desc: '蚂蚁数量' },

  // ---- 感知 ----
  { key: 'sensorAngle', default: 0.79, min: 0.05, max: 1.5, step: 0.01, desc: '两根触角的夹角(rad),越大感知越开阔' },
  { key: 'sensorDist',  default: 26,   min: 2,    max: 80,  step: 1,    desc: '触角长度(世界单位),尝得越远梯度越平滑' },
  { key: 'sensorMode',  default: 'physarum', options: ['diff', 'physarum'],
    desc: '感知模式: diff=双触角梯度差分(P1.x) / physarum=三触角转向最强者(Jones 2010, P1.8, 默认—index 0.72 vs 0.33 见 METRICS)' },
  { key: 'K_steer',     default: 1.5,  min: 0, max: 10, step: 0.05, desc: 'physarum 模式转向速率(rad/s): 朝三触角中最强一侧的固定转速' },
  { key: 'saturationMode', default: 'log', options: ['off','mm','log'],
    desc: '感知饱和方式: off=原始浓度, mm=Michaelis-Menten, log=对数(Weber定律)' },
  { key: 'K_sat',       default: 0.05, min: 0.001, max: 1,  step: 0.005, desc: '感知饱和常数: 越小对低浓度越敏感,热点越被压平' },
  { key: 'alarmSens',   default: 0.02, min: 0,    max: 0.5, step: 0.005, desc: '报警感知阈值:触角尝到超过该浓度的报警信息素就惊逃(P2.2)' },

  // ---- 转向 ----
  { key: 'K_chem',     default: 1.6, min: 0, max: 10, step: 0.05, desc: '沿信息素梯度转向的增益(空手时)' },
  { key: 'K_home',     default: 3.4, min: 0, max: 10, step: 0.05, desc: '沿回家向量转向的增益(负重时)' },
  { key: 'K_out',      default: 0,   min: 0, max: 10, step: 0.05, desc: '出巢极性:空手蚂蚁被推着向外走(K_home的反向项)' },
  { key: 'K_wall',     default: 4.0, min: 0, max: 10, step: 0.1,  desc: '避墙转向速率(rad/s):触角碰到障碍墙就转开,0=不避让(仍会被墙挡住)' },
  { key: 'K_alarm',    default: 3.0, min: 0, max: 10, step: 0.1,  desc: '避险转向速率(rad/s):触角闻到报警信息素就背对浓度转开,0=不避险(仍会被捕)' },
  { key: 'sigma',      default: 0.30,min: 0, max: 3,  step: 0.01, desc: '底层混沌:叠加在转向上,积分出方向惯性' },
  { key: 'tumbleAmp',  default: 2.4, min: 0, max: 8,  step: 0.1,  desc: '翻滚时的一次性大转向幅度' },
  { key: 'alpha',      default: 1.7, min: 0.9, max: 3, step: 0.02, desc: 'Lévy 重尾指数:越小尾巴越重,偶发大转向越多' },

  // ---- 置信度 (P1.7): 把被扔掉的 (FL+FR) 捡回来 ----
  { key: 'K_conf',      default: 3.0, min: 0.01, max: 20, step: 0.1, desc: '置信度睫毛:sensed 总浓度 sum 达到该值即 conf→1, 0=关' },
  { key: 'sigma_lost',  default: 1.0, min: 0.01, max: 4,  step: 0.05, desc: '丢路(conf=0)时的搜索噪声, 应 > sigma_road' },
  { key: 'sigma_road',  default: 0.15,min: 0,    max: 2,  step: 0.01, desc: '稳在路上(conf=1)的噪声, 低=动量带我走' },
  { key: 'cautionSpeed',default: 0.4, min: 0.1,  max: 1,  step: 0.05, desc: '离路(conf=0)时速度缩放倍率, 1=不减速' },
  { key: 'K_return',    default: 2.0, min: 0,    max: 8,  step: 0.1,  desc: '丢路回环搜索增益(朝最后闻到的路侧转弯)' },

  // ---- 运动 / 记忆 ----
  { key: 'speed',      default: 46,  min: 5,  max: 200, step: 1, desc: '移动速度(世界单位/秒)' },
  { key: 'leak',       default: 0,   min: 0,  max: 0.6,step: 0.005, desc: '航位推算遗忘率(比例/秒): 默认0=永不遗忘。真实路径积分是累积误差而非指数遗忘; 遗忘>0 会让蚂蚁在返程途中提前丢失回家方向(负重路径越长越致命, P2.2 发现), 仅作实验用' },
  { key: 'carryTimeout',default: 40, min: 1,  max: 120, step: 1, desc: '负重最久时长(秒),超时弃货防死循环' },
  { key: 'forageTimeout',default: 30,min: 0,  max: 120, step: 1, desc: '空手觅食超时(秒):太久没收获就放弃觅食、凭路径积分直接回家休整再出发(P1.9), 0=关闭' },
  { key: 'missRecover',  default: 0.02,min: 0,  max: 0.2, step: 0.005, desc: '觅食失败后的信任恢复速率(次/秒):失败越多越不信信息素路,成功采食立即回满' },
  { key: 'nestRadius', default: 30,  min: 5,  max: 300, step: 1, desc: '巢半径:回家向量小于它就算到家' },
  // ---- 个体路线记忆 (P2.4): K_mem=0 时 colony 侧整块短路, 不写不读不掷随机数, 旧行为 bit 级不变 ----
  // 出厂值为什么是 2 而不是 0(验收 ③ 的结论逼出来的, 不是猜的):
  // 真实蚁(Lasioius niger 等)本来就有个体路线记忆, 默认关掉它等于默认"这一窝蚂蚁没有记忆",
  // 与 ANT_BIOLOGY §二 相悖。而三种子实测: 正常昼夜玩法下它的吞吐增益(+1.0%)落在基线组自身
  // 跨种子极差(1.9%)之内——**开它不赚钱**; 但一旦集体走廊被冲干净, 同一个窗口记忆组是基线的
  // 2 倍以上(memory_check ⑤B/③g)。所以它的定位是"备份通道/保险", 平时沉默、断线时救命,
  // 这恰恰是真实蚂蚁的分工: 群体信息素是主通道, 个体记忆是兜底。取 2 不取 3 是因为 K 越大
  // 越"固执": ④ 的撤源废弃在 K=2 已经贴着阈值(覆盖率 300s 后 44%), K=3 会让路线更难废弃。
  { key: 'K_mem',      default: 2,   min: 0,  max: 3,   step: 0.05, desc: '个体路线记忆权重: 老练觅食者走自己记住的航点链, 集体走廊淡/断时才接管(双通道, 0=纯信息素)' },
  { key: 'memStep',    default: 24,  min: 6,  max: 120, step: 2,    desc: '路线航点间隔(世界单位): 越小记得越细, 越大路线越概括' },
  { key: 'memForget',  default: 2,   min: 1,  max: 8,   step: 1,    desc: '连续扑空几次后废弃这条路线(真实蚁: 食物被搬走/路被切断就不再走), 权重按次线性衰减' },
  // 成熟度门槛(P2.3.3, 出厂 2): 把扩散长度压回触角尺度之后(dw 0.06→0.02), 验收 ⑤d 判红——
  // 400 蚁小群的**建成期**(集体通道还在)记忆组吞吐只有基线 73.4%(三种子里的最坏种子)。根因不是记忆
  // 变差, 而是份额公式 rel = K_mem*forget*onRoute 里的 conf 是**绝对浓度**: 场一变薄, 蚂蚁闻不到路的
  // 时长就变长, 记忆于是自动继承更大的转向份额——一条从没被走通验证过的线, 一提交就拿满权威。
  // 真实蚁的权威是逐趟走出来的(ANT_BIOLOGY §二: 纯信息素仿真对**熟悉路径**的蚂蚁是过度简化; 跟随者对
  // 信息素**位置**的记忆可覆盖场信息; L. niger 沿线保真 87.4% 来自反复走同一根线; 而 Y 迷宫的跟随准确性
  // 不随访食经验调制=硬连线 ⇒ 该动的是**经验次数**, 不是把权重常数按 dw 重标)。
  // 于是: 同一根线连续被走通 K_route 次才拿满份额, 没走够按比例给。判据用比例(memIA ≥ memNA*0.6,
  // 与 P2.4 扑空归因同一个阈值)而不是绝对剂量 ⇒ 换场尺度不必重标 = HANDOVER §7 第二条要的尺度不变。
  // 取 2 不取 3(与 K_mem 同一条纪律): 2 已经让 ⑤d 三种子全过(最坏 102.5%), 而 3 还要多削掉一截真正
  // 的红利(⑤a 最坏 2.48×→2.10×, ⑤b 46.1%→30.3%)。1 是**空操作**(线一提交 memTrips 就 ≥1)⇒ 最小粒度就是 2。
  // 门也不能太紧: K_route=5 实测比不加门还差(35.2%)——权威拿不到⇒蚂蚁不贴自己的线⇒验证次数永远攒不够(自锁)。
  // 回退: URL 加 ?K_route=0 即逐位退回 P2.3.2(memory_check ①b2 与 weather 恒等(e) 两头都钉着)。
  { key: 'K_route',    default: 2,   min: 0,  max: 6,   step: 1,    desc: '路线成熟度门槛: 同一根线被连续走通几次才拿满记忆份额(1=空操作; 0=逐位退回 P2.3.2)' },
  { key: 'foodLoadRate',default: 0.5,min: 0.05,max: 5,  step: 0.05, desc: '采食速率(载货量/秒),连续上升不是秒满' },
  { key: 'depositRate',default: 0.45,min: 0.001,max: 2, step: 0.005, desc: '负重蚂蚁每秒沉积的信息素量' },

  // ---- 真实感 (个体差异与停顿; 全 0 = 回到整齐划一的旧机制) ----
  { key: 'speedVar',   default: 0.2, min: 0, max: 0.6, step: 0.05, desc: '个体速度差异(±比例):有的蚁快有的蚁慢' },
  { key: 'turnVar',    default: 0.3, min: 0, max: 1,   step: 0.05, desc: '个体转向性格(±比例):有的蚁走直线有的蚁爱扭' },
  { key: 'depositVar', default: 0.35,min: 0, max: 1,   step: 0.05, desc: '个体沉积差异(±比例):信息素路有浓有淡有纹理' },
  { key: 'pauseRate',  default: 0.8, min: 0, max: 5,   step: 0.05, desc: '觅食蚁每秒停下触角扫描的概率(次/秒)' },
  { key: 'pauseTime',  default: 0.4, min: 0, max: 3,   step: 0.05, desc: '触角扫描停顿时长基准(秒),停下时原地转头不移动' },
  { key: 'nestDwell',  default: 1.2, min: 0, max: 10,  step: 0.1,  desc: '卸货后在巢里磨蹭多久再出门(秒)' },

  // ---- 昼夜与天气 (P2.3): dayNight=0 且 weather=0 时调用方连 env 都不构造, 旧行为 bit 级不变 ----
  { key: 'dayNight',   default: 0,    min: 0,    max: 1,    step: 0.05, desc: '昼夜节律强度: 0=行为不看体内钟(永远像正午) / 1=夜半几乎不出巢' },
  { key: 'dayLength',  default: 240,  min: 20,   max: 1200, step: 20,   desc: '一个昼夜多少模拟秒(真实蚁群约24小时, 这里压缩到4分钟便于观察)' },
  { key: 'dayCurve',   default: 3,    min: 1,    max: 6,    step: 0.5,  desc: '内源钟响应锐度: 1=活动随钟线性渐弱 / 3=突然开张收档(真实蚁群觅食列的样子)' },
  { key: 'dayPhase',   default: 0,    min: 0,    max: 0.5,  step: 0.05, desc: '内源钟相位: 0=昼行(跟着太阳走) / 0.5=夜行(和太阳反着来, 许多热带蚁如此)' },
  { key: 'tempBase',   default: 26,   min: -10,  max: 50,   step: 0.5,  desc: '平均气温(°C): 26 在热带蚁最适区, 变温动物的活动力天花板' },
  { key: 'tempSwing',  default: 6,    min: 0,    max: 20,   step: 0.5,  desc: '昼夜温差幅度(°C): 正午=base+swing, 午夜=base-swing' },
  { key: 'tempMin',    default: 10,   min: 0,    max: 30,   step: 0.5,  desc: '活动温度下限(°C): 低于此温度冷麻痹, 出不了巢' },
  { key: 'tempMax',    default: 45,   min: 30,   max: 60,   step: 0.5,  desc: '活动温度上限(°C): 高于此温度热失活' },
  { key: 'weather',    default: 0,    min: 0,    max: 1,    step: 0.05, desc: '天气强度: 0=永远晴天 / 1=满强度风暴(雨前低压→降雨→雨后恢复)' },
  { key: 'stormEvery', default: 300,  min: 60,   max: 1800, step: 30,   desc: '风暴平均间隔(秒): 实际每次在 ±40% 内随机抽取' },
  { key: 'stormLen',   default: 45,   min: 5,    max: 300,  step: 5,    desc: '降雨平均时长(秒): 实际在 ±30% 内随机抽取' },
  { key: 'preStormRush',default: 2.8, min: 1,    max: 6,    step: 0.1,  desc: '雨前低压抢收倍率: 起雨前出巢率最多×2.8且个体提速(切叶蚁抢收, 不是躲是抢)' },
  { key: 'rainUrge',   default: 1.5,  min: 0,    max: 6,    step: 0.1,  desc: '雨中催回: 空手觅食计时快×(1+该值×雨量), 提前放弃回家避雨' },
  { key: 'rainWash',   default: 6,    min: 0,    max: 40,   step: 0.5,  desc: '雨水冲刷: 信息素衰减速率×(1+该值×雨量), 是时间加速器不是一步抹平' },
  { key: 'windWash',   default: 2,    min: 0,    max: 40,   step: 0.5,  desc: '风冲刷: 同上, 按风力计' },
  { key: 'rainCooling',default: 4,    min: 0,    max: 20,   step: 0.5,  desc: '降雨降温幅度(°C): 雨点本身带走的热量' },
  { key: 'rainShelter', default: 0.95, min: 0,   max: 0.99, step: 0.01, desc: '雨中蛰巢: 满雨时出巢驱动只剩×(1-该值)=5%, 换算成巢内滞留约×20(雨不停就不出门)' },

  // ---- 场 ----
  { key: 'diffuseWeight', default: 0.02, min: 0.001, max: 0.25, step: 0.001, desc: '3x3 扩散权重(越大越糊越快): 0.02 是推导值不是手感值——云的衰减长度 ℓ=sqrt(D/λ) 必须 ≤ 触角长度, 否则场里存着没有蚂蚁能读的信息, 而且会把蚂蚁带偏(P2.3.2 实测吞吐 +7%、失败 −18%)' },
  { key: 'decayRate',     default: 0.97, min: 0.2,   max: 0.999,step: 0.005, desc: '信息素每秒衰减系数,1=永不消失' },
  { key: 'peak',          default: 0.35, min: 0.01,  max: 24,   step: 0.05, desc: '色阶参考浓度(半亮点): 该浓度=亮蓝, 其上每翻倍亮一档, 256× 才到白热上限' },
  { key: 'toneMap',       default: 1,    min: 0,    max: 1,    step: 1,    desc: '色阶曲线: 0=旧线性+硬钳制(peak 以上整片烧成白, 走廊结构全丢) / 1=软压缩+有界色阶(光污染治理)' },
  { key: 'autoPeak',      default: 1,    min: 0,    max: 1,    step: 1,    desc: '自适应曝光: 1=色阶参考浓度跟着蚂蚁脚下实际闻到的剂量走(只收光不加光, 没过曝的场景画面逐位不变) / 0=钉死在 peak 滑杆(旧行为)' },
  // ---- P2.3.4 光污染 III：侧抑制背景减除（纯渲染层，出厂 lateralK=0.5） ----
  // 病根换了：残留的雾不是「太亮」而是**空间上的共模**——缓变的一大片，蚂蚁从里面读不出方向，
  // 却和走廊一样占亮度预算。实测靠曝光压它：乘数 ×1→×4 死光只 5.4%→4.4%，走廊级数却 85→25，
  // 越压越糊 ⇒ 曝光这条路已到天花板，得换「减局部平均」这条路。
  // 生物学依据(2026-09-05 逐条对 NCBI PubMed 核实过作者/卷期页/PMID, 上一轮的错引已作废, 见 METRICS P2.3.4 §2)：
  //   ①果蝇触角叶的突触前侧抑制做增益控制(Olsen & Wilson 2008, Nature 452(7190):956-960, PMID 18344978)——邻居都在响
  //     的共模被压掉，只有相对差往下传；②侧抑制带来**浓度不变性**(Kim & Wang 2009, J Biol 8(1):4, PMID 19216732)，
  //     感知的本来就不是绝对量；③弓背蚁循迹靠两根触角**跨轨迹边缘**采样来决定转向(Draft, McGill, Kapoor &
  //     Murthy 2018, J Exp Biol 221:jeb185124, PMID 30266788)——所以这张图改显示「反差」而不是「分子数」。
  // 环半径不新增旋钮：由触角长度派生 round(sensorDist/gridCell)=3 格，且与 dw=0.02 的云衰减长度
  // ℓ=3.14 格撞在同一个数上(两条独立推导指向同一个尺度：比触角更宽的均匀场没有方向信息)。
  // 减法做在线性浓度域(tone 之前)：真实侧抑制发生在感受器饱和之前；log 域减法=线性域除法，
  // 会和 tone 的对数重复补偿同一个东西，K 就没法解释了。
  // 代价如实记：大范围缓变的积累(探索网、巢周老堆、雨后均匀场)会变暗甚至消失 ⇒ 出图肉眼裁决。
  // 回退：0=perceivedField() 原样返回 field.buf(同一个数组)，三条渲染路径逐字节不变。
  // 出厂 0.5 是测出来的（三种子均值、rich dw=0.02，对照=同场景同曝光无侧抑制，见 lateral_probe v2）：
  //   死光 0.38×（主目标 L1 ≤ 0.60× 过）、路格八度跨度 1.45×、相对反差 1.23×、雾亮比 0.65×、
  //   路格存活 100%（原来发光的路格减完背景之后还在发光——走廊本体一根没断）。
  //   再往上 K=0.75 / 1 时路格存活跌到 62% / 41%，八度跨度与反差同时反转（抑制自己开始吃东西）
  //   ⇒ 约束出厂值的是“别吃掉走廊本体”，不是那条已被否证的 8 位级数判据（两条更正见 METRICS P2.3.4 §5）。
  //   代价如实记：常规玩法（玩家一进来看见的那块饿死的场地）均亮 0.65×，glow 的 G6 会红——G6 原意是
  //   “曝光模块别把主画面做暗”，而本机制的目的正是拿掉主画面那层共模辉光，出图肉眼裁决已过。
  //   薄场↔厚场稳健性：dw=0.06 下 K=0.5 仍是死光 0.76×、八度 1.33×、路格存活 100% ⇒ 换场不必重标。
  { key: 'lateralK',      default: 0.5,  min: 0,    max: 2,   step: 0.01,  desc: '侧抑制(出厂 0.5): 显示量=浓度−「触角半径那一圈」的均值×该值(0=关,画面逐字节不变 / 1=纯共模抑制,只留反差)' },
  { key: 'alarmDecay',    default: 0.95, min: 0.2,   max: 0.999,step: 0.005, desc: '报警信息素每秒衰减系数:比轨迹(0.97)挥发快,半衰期约13秒(P2.2)' },
  { key: 'alarmSplash',   default: 8,    min: 0,     max: 30,   step: 0.5,   desc: '每次捕杀原地喷溅的报警信息素量(死者是唯一的报警源,惊逃蚁只响应不释放)' },
  { key: 'alarmPeak',     default: 1.2,  min: 0.05,  max: 8,    step: 0.05,  desc: '报警渲染色阶:报警浓度达到该值视为最红' },
  { key: 'emptyDeposit',  default: false, options: [false, true],
    desc: '诊断:空手蚂蚁是否也沉积信息素(定位 0.34 高地上限的是否来自食物打转)' },

  // ---- 置信度调制开关 (P1.7) ----
  { key: 'confA',   default: true,  options: [false, true], desc: 'P1.7-A: 横向锁定×(conf) 没路时不该锁空气' },
  { key: 'confB',   default: true,  options: [false, true], desc: 'P1.7-B: 搜索噪声=lerp(sigma_lost,sigma_road,conf)' },
  { key: 'confC',   default: true,  options: [false, true], desc: 'P1.7-C: 速度×lerp(cautionSpeed,1,conf) 离路变慢' },
  { key: 'confD',   default: false, options: [false, true], desc: 'P1.7-D: 丢路回环搜索(朝最后闻到的路侧)' },
];

export const KEYS = SCHEMA.map(s => s.key);

const DEFAULTS = {};
for (const s of SCHEMA) DEFAULTS[s.key] = s.default;

// 运行时参数表:values[key] → 当前值。UI 和模拟都读这里。
export const values = { ...DEFAULTS };

export function get(k) { return values[k]; }
export function set(k, v) {
  values[k] = clamp(k, v);
  return values[k];
}

export function clamp(key, v) {
  const s = SCHEMA.find(x => x.key === key);
  if (!s) return v;
  if (s.options) return s.options.includes(v) ? v : s.default;
  return Math.min(s.max, Math.max(s.min, v));
}

export function schemaOf(key) { return SCHEMA.find(x => x.key === key); }

// ---------- URL 分享 ----------
export function toQuery(params) {
  const p = new URLSearchParams();
  for (const k of KEYS) {
    if (values[k] !== DEFAULTS[k]) p.set(k, String(values[k]));
  }
  return p.toString();
}

// 从 URL 覆盖参数值。返回是否发生了覆盖。
export function applyQuery(params) {
  let touched = false;
  for (const k of KEYS) {
    const raw = params.get(k);
    if (raw === null) continue;
    const s = SCHEMA.find(x => x.key === k);
    let v;
    if (s && s.options) {
      // 枚举：字符串直接用,布尔型把 'true'/'false' 还原
      v = (typeof s.options[0] === 'boolean')
        ? raw === 'true'
        : (s.options.includes(raw) ? raw : null);
      if (v === null) continue;
    } else {
      v = Number(raw);
      if (!Number.isFinite(v)) continue;
    }
    set(k, v);
    touched = true;
  }
  return touched;
}

// 生成一个可复现的种子串 -> hash，供 rng 播种
export function seedFromQuery(params) {
  return params.get('seed') || undefined;
}