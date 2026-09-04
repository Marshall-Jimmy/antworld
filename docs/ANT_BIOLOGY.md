# 蚂蚁生物学参考（Antworld 仿真对照手册）

> 用途：为"有机真实"标准提供真实生物学对照。每个机制问一句：真蚂蚁是这样吗？
> 读法：数字是**物种特定**的代表性值，不是普适常数；标注"量级"的是二手转述或科普数字，
> 标注"存疑"的是未获一手文献确认的说法。已抽查关键数字与一手来源的一致性（见文末可信度说明）。
> 整理日期：2026-09-04（P2.2 之后、P2.3 之前）。

---

## 一、现有仿真机制 ↔ 真实生物学对照总表

| # | 仿真机制 | 真实对应 | 评估 |
|---|---|---|---|
| 1 | physarum 三触角"转向最浓" | 阿根廷蚁转向角 ∝(左−右)/(左+右)（Weber 律），上限约 35°，低于阈值回随机游走 | ✅ 吻合度高——三触角本质就是 Weber 律的离散化 |
| 2 | trail 场衰减 0.97/s（半衰期 ~23s） | 真实跨度 **1 min – 数天**（物种/成分而异）；建模常用特征衰减 ~5 min；长角狂蚁正十一烷行为寿命 ~1 min；阿根廷蚁合成轨迹活性仅 1h | ⚠️ 偏快，但落在短命易挥发组分的范围内 |
| 3 | 场扩散核（每步横向扩散） | 真实分子扩散极弱（D≈0.01 cm²/s），信息素轨迹几乎不横向铺开 | ⚠️ 简化（physarum 遗产），服务可视化与感知鲁棒性 |
| 4 | 负重才沉积 + 个体沉积差异 depMul | L. niger 近食源沉积更多、犯错后上调沉积；法老蚁在无食分支沉积"no entry"负信息素 | ✅ 框架正确；**位置相关沉积**是可选增强 |
| 5 | 路径积分 h（leak=0，累积误差不遗忘） | Cataglyphis 纯路径积分觅食（无轨迹信息素）；真实 PI 是累积误差非指数遗忘 | ✅ P2.2 修正后语义正确 |
| 6 | 导航 = 纯信息素跟随 | 真实是**信息素 × 个体路线记忆双通道**（L. niger 开放场沿线保真 87%，且能凭记忆走单向路线） | ❌ 当前纯信息素——**最大的真实性差距** |
| 7 | 个体性格 speedVar/turnVar/depositVar | 真实个体差异显著（老工蚁响应更快、侦察兵/跟随者分化） | ✅ |
| 8 | carryTimeout 弃货 / forageTimeout 返巢 | 觅食失败、放弃与"空手回巢"真实存在 | ✅ |
| 9 | 报警：死者喷溅（捕杀原地释放），惊逃蚁背浓转向，半衰期 ~13.5s | 克隆掠夺蚁压碎**头部**才有效（上颚腺在头部）；高浓度=panic 逃散；行为 1.5–3 min 回落 | ✅ 机制吻合；衰减偏快但在秒–分钟量级；缺**剂量分级**（真实低浓度=聚集查看） |
| 10 | 惊逃蚁只响应不释放（防正反馈恐慌云） | 活体受惊释放物**无吸引性**（O. biroi）——报警素确由伤/亡个体释放 | ✅ 意外吻合 |
| 11 | 沿墙惯用手（个体定侧） | 蚂蚁**无强贴墙证据**（蟑螂贴墙 54–72%，蚂蚁未量化）；仅弱边界倾向 | ⚠️ 工程需要压过真实性，保持弱权重、文档标注 |
| 12 | 被捕杀后即时重生=新蚁 | 卵→工 34–53 天（S. invicta 均值 43 天），旺期 ~800 卵/天 | ⚠️ 即时重生是简化，归 P2.5 数量动态 |
| 13 | 卸货=物理进巢盘（环面距离） | 巢内交哺/库房分配，食物真实入库 | ✅ |

---

## 二、觅食与信息素

**召集谱系**（物种→方式）：大规模召集（轨迹信息素+定量放大）——L. niger 黑毛蚁、阿根廷蚁、红火蚁（回巢后约 30 min 群体反应达峰）、切叶蚁、法老蚁；组召集/串联跑——Camponotus socius、Formica schaufussi、Temnothorax；**纯单独觅食（无轨迹信息素，靠路径积分）**——Cataglyphis 沙漠蚁、收获蚁。我们的默认形态（干道+大规模召集）对应最常见的一支。

**信息素化学与寿命**：阿根廷蚁=(Z)-9-hexadecenal（注意：这是阿根廷蚁的成分，黑毛蚁主成分至今未定论）；红火蚁=(Z,E)-α-farnesene；切叶蚁=甲基-4-甲基吡咯-2-甲酸酯，活性阈值约 0.1 pg/cm；法老蚁=monomorine I（低挥发，轨迹可活小时–天）。建模文献常用特征衰减 ~5 min（γ=1/300 s⁻¹）；阿根廷蚁结论对 30 min 半衰期稳健。**扩散极弱**（D≈0.01 cm²/s）。

**跟随规则（对仿真最有用的一条）**：阿根廷蚁不是"朝最浓转"，而是转向角∝(左−右)/(左+右)（Weber 律），最大 ~35°，低于阈值回随机游走；均匀浓场**无方向信息**。我们的三触角比较采样天然满足 Weber 形式——这是 P1.8 选型对了的定量印证。

**个体记忆（当前最大差距）**：L. niger 开放场沿线保真 87.4%；Y 迷宫跟随准确性不随访食经验调制（跟随是硬连线），但同种能凭个体记忆学**单向**路线——真实系统是"信息素×记忆"双通道，纯信息素仿真对熟悉路径的蚂蚁是过度简化。近期证据还显示跟随者对**信息素位置记忆**可覆盖场信息。

**负反馈与细节**：法老蚁在确认无食的分支沉积"no entry"负信息素（Nature 2005）；L. niger 近食源沉积更多、犯错后上调沉积（2024）——沉积率是**情境调制**的，不是常数。离开足迹后 U 形折返率上升；"局部炽燃"式短段标记（不全程铺路）也可成路（eLife 2016）。车道：切叶蚁可学出/回单向道，行军蚁多车道自发分离（Couzin & Franks 2003），拥挤时避开拥挤源（Wendt 2020）。

**病理对应**：信息素正反馈的病理极端=**蚂蚁死亡漩涡**（ant mill，行军蚁圈径可达数百米、持续约 2 天累死，量级转述）——我们修掉的恐慌云正反馈与它是同族问题。

**标度数据**：L. niger 2.3–2.6 cm/s（信息素不提速）；阿根廷蚁均值 ~2、峰值 ~6 cm/s；Cataglyphis 可达 ~50 cm/s。负载：Messor barbarus 野外达 13× 自重（实验 1.2–7×），切叶蚁常驮 0.5–2× 自重；"50 倍"是科普夸张。觅食半径：L. niger 数米–数十米，红火蚁 ~100 m，切叶蚁主干道 100–250 m。

**对本项目的启示**：①可加"个体记忆跟随权重"参数（已走过的路线优先于场）——与已有 trust/misses 机制同构；②沉积率情境化（近食源↑）成本低、真实感收益高；③衰减 0.97/s 可整体再校准（真实 1 min–数天，5 min 是建模惯例）。

来源：
- [Individual Rules for Trail Pattern Formation in Argentine Ants (PLoS Comp Biol 2012)](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1002592)
- [Trail Pheromone of the Argentine Ant (PLOS ONE 2012)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0045016)
- [A locally-blazed ant trail… (eLife 2016)](https://elifesciences.org/articles/20185)
- [Walk this way: modeling foraging ant dynamics (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11392994/)
- [Trail following not modulated by previous visit (Research Square, preprint)](https://www.researchsquare.com/article/rs-7630446/latest)
- [Insect communication: 'no entry' signal (Nature 2005)](https://pubmed.ncbi.nlm.nih.gov/16306981/)
- [Ants Can Learn to Forage on One-Way Trails (PLOS ONE 2006)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0005024)
- [Dynamics of locomotion in Messor barbarus (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7849507/)
- [Lasius niger deposit more pheromone near food (Insectes Sociaux 2024)](https://link.springer.com/article/10.1007/s00040-024-00995-y)
- [Collective search: footprints & U-turns (PLOS ONE 2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11037541/)
- [Ant mill — Wikipedia](https://en.wikipedia.org/wiki/Ant_mill)

---

## 三、昼夜与天气（P2.3 设计依据）

**昼夜节律是内源的**：Camponotus rufipes 觅食蚁夜行，恒黑下节律自由运行 τ=22.4±0.4h（保育蚁 23.1±0.8h），6h 光相位延迟后立即再同步——真内源钟。**保育蚁在巢内无节律**（社会掩蔽），隔离后 80–90% 恢复夜行。出巢时点可由太阳高度角触发（嗜热蚁 Ocymyrmex）。节律型物种间分化：昼行耐热（Cataglyphis/Ocymyrmex/Melophorus 三属独立趋同）、夜行（弓背蚁属多数）、巢内全日。

**温度窗口（硬门控）**：耐热上限 LT50（3h 暴露）——Melophorus bagoti 49.8°C、Ocymyrmex 46.8°C、Cataglyphis 44.6–46°C、温带 Formica fusca 42°C、Myrmica 39.9°C；沙漠蚁**故意**在接近致死限的气温觅食（避开竞争与捕食）。低温：温带蚁过冷却点 −40~−8°C，春季冷驯化使 CTmin 降 2.1–2.9°C。巢内恒温行为：Camponotus mus 保育蚁按昼夜节律搬蛹——白天 30.8°C 处、夜间 27.5°C 处。

**雨前抢收（最反直觉、最有"有机感"的一条）**：切叶蚁 Atta sexdens 感知气压下降（实验 8 mbar 间隔，950→942 mbar）——低压下侦察蚁出巢快 **2.8×**（比高压快 3.7×），切运量 **1.5–2.0×**；招募不变，靠个体提速（Sujimoto et al., Ethology 2019, DOI 10.1111/eth.12967，已对照一手报道核实）。**雨前不是躲，是抢**。

**雨**：易挥发轨迹组分（阿根廷蚁 dolichodial/iridomyrmecin）表面 40 min 内天然消散，合成轨迹活性仅 1h——雨对信息素场是"按指数加速清洗"，不是离散清除。红火蚁洪水蚁筏：口器/跗爪互连，**不到 2 分钟成形**，可漂数天（量级），幼虫放筏心，疏水+锁气层。

**风**：破坏气味羽流+加速挥发（高挥发组分在轨迹上的损耗比例 1:2~1:14 证明挥发真实存在）；沙漠蚁大风暂不出巢（定性）。婚飞触发组合：雨后+静风+>24°C（红火蚁年 6–8 次、每次可至 4500 只有翅蚁）。

**季节**：温带种成虫巢内滞育越冬；春季恢复出巢由土温驱动（量级：土温稳定 >~10°C）。

**→ P2.3 参数启示**：
- dayNight 周期调制出巢率，**相位参数可反转**（昼行/夜行=物种预设，内源钟语义）；
- 温度窗口 10–45°C 量级做活动门控（温度本身可由昼夜+天气推出）；
- **雨前低压→出巢率 ×2–3**（抢收）——一行代码换一个"哇"时刻；
- 雨/风=信息素场衰减加速器（倍率参数，时间常数 <1h 语义），而非离散抹除；
- 彩蛋储备：洪水蚁筏、婚飞。

来源：
- [Heat-shock response in desert and temperate ants (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10500329/)
- [Daily behavioral rhythms in foragers and nurses of C. rufipes (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5242425/)
- [Pupal thermal behavioral regulation (Frontiers 2016)](https://www.frontiersin.org/journals/behavioral-neuroscience/articles/10.3389/fnbeh.2016.00073/full)
- [Leafcutter ants accelerate before storms (Sujimoto et al., Ethology 2019; Phys.org 报道)](https://phys.org/news/2019-12-leafcutter-ants-stormy-weather.html)
- [Fire ant rafts (Mlot, Tovey & Hu 2011, PNAS)](https://www.pnas.org/doi/10.1073/pnas.1016658108)
- [Solenopsis invicta (UF/IFAS EDIS)](https://edis.ifas.ufl.edu/publication/IN352)
- [Pogonomyrmex badius depth structure (PLoS ONE)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0166907)
- [Climatic constraints on temperate arboreal ants (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12134437/)

---

## 四、能量与等级分工（P2.5 设计依据）

**寿命差三个数量级**：蚁后 28–30 年（L. niger 记录 28 年；最高记录 ~45 年）；工蚁数周–数月（红火蚁 60–150 天；Temnothorax 实验室可 5 年）。**外勤折寿是关键机制**：Cataglyphis bicolor 开外勤后期望寿命仅 **6.1 天**（巢内可活数月）；P. badius 外勤后 ~1 个月 vs 实验室 ~200 天——**出巢打工=生命倒计时加速**，这是比捕食者更日常、更有机的死亡压力来源。

**搬运经济**：收获蚁成功一趟的能量收益 ≈ 路途成本 **~100 倍**（Weier & Feener 1995）——解释了为什么蚂蚁愿意走很远；实测负载 3× 自重（Atta vollenweideri 切叶工），野外上限 13×；觅食道 ≥50 m（切叶蚁单巢均 21 条道）、红火蚁 ~100 m。

**能量分配**：液食入社会胃（crop）口对口交哺（trophallaxis），火蚁工→幼虫交哺时长近常数；蜜罐蚁选最大新工喂成 replete（约占群体 1/5）倒挂储蜜数周–数月；饥荒时优先保蚁后/幼虫、削减育幼甚至食卵幼（定性）。

**等级与年龄**：326 属中 276 属单态（多态是少数派）；切叶蚁头宽 0.6–4.5 mm 分工连续（0.8–1.6 mm 育幼、>1.6 mm 外勤），存在**最优体型**（A. sexdens 2.2 mm 切割最优，更大更小都变差）。**年龄多态**：羽化后数周由巢内转外勤（Atta callow 期 3–4 周）；行为库随龄扩张，生命末段仍无任务缺陷。**弹性**：体型比例变化即触发任务重分配（Wilson 1984）；受威胁区兵蚁比例 15% vs 对照 10%（Pheidole morrisi）。

**群体规模标度**：蚁群 8 万–50 万（红火蚁成熟）、切叶蚁数百万、阿根廷蚁超级群落绵延 ~6000 km 数十亿工（量级）。规模决定招募模式：大群干道+集体运输，小群单兵（Lanan 2014 综述 402 种）。发育时间：卵→工 34–53 天（红火蚁均 43），旺期 ~800 卵/天，冬季群体可缩 ~75%。

**→ P2.5 参数启示**：
- 寿命模型：巢内低消耗/外勤高消耗两档折旧（真实比值 ~20–30×），死亡日常化后捕食者只是额外风险；
- 任务-年龄联动：年轻=巢内、年长=外勤（出巢率随"年龄"上升），与现有 forageTimeout/信任系统天然兼容；
- 重生延迟化：卵→工 ~40 天量级（仿真可压缩），替代"即时重生"；
- 负载与距离 economics：单趟收益 ~100× 说明"跑长路值得"——现有 0.65w 食物距离在真实标度内。

来源：
- [Worker senescence and sociobiology of aging in ants (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4266468/)
- [From division of labor to collective behavior (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4917577/)
- [Herbivory by Atta vollenweideri review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10926485/)
- [Developmental biomechanics & age polyethism in leaf-cutters (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10265030/)
- [Solenopsis invicta (Animal Diversity Web)](https://animaldiversity.org/accounts/Solenopsis_invicta/)
- [Lanan 2014: Spatiotemporal resource distribution & foraging strategies (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4267257/)
- [Black garden ant longevity (AnAge)](https://genomics.senescence.info/species/entry.php?species=Lasius_niger)
- [Honeypot ants (KQED Deep Look)](https://www.kqed.org/science/1978892/honeypot-ants-turn-their-biggest-sisters-into-jugs-of-nectar)

---

## 五、捕食者与防御（P2.2 现状对照与增强方向）

**报警素的化学与时间尺度**：克隆掠夺蚁 O. biroi 报警素=4-甲基-3-庚酮(80%)+4-甲基-3-庚醇(16%)，位于**头部上颚腺**——压碎头部有效、压碎无头躯干零反应（我们"死者喷溅"的解剖学依据）；气味加入后 ~1.5 min 行为回落至对照。切叶蚁 4-methyl-3-heptanone 占 70%，单头等效剂量 25–135 ng，多组分协同（单化合物只引发 60–90% 反应）。阿根廷蚁 30 秒暴露后 3 min 行为全回落。木蚁蚁酸（毒腺 58.5%）兼具防御/报警/巢材消毒。

**剂量分级（我们缺的半边）**：O. biroi 低剂量=**被吸引、出巢聚集查看**；高剂量=驱避、panic 逃散——威胁升级→更多个体释放→浓度升高→行为从"来看"切换成"快跑"。我们当前只有 panic 分支；补一个低浓度=减速+朝源靠近的分支即可获得剂量语义。

**习惯化（与 trust 系统同构！）**：阿根廷蚁重复暴露报警素 4–5 次（间隔 3–6 min）后反应消失——"狼来了"效应，无真实威胁佐证的报警会被忽略。我们的 misses/confEff 信任折扣是同一认知机制的觅食版；报警侧可复用同构参数。

**记仇（联想学习）**：连续 5 天遭遇某敌巢气味后，对该气味的攻击性显著更高（Current Biology 2025）——群体级敌我记忆。

**死亡信号与报警信号分属两条通路**：油酸=死亡信号，死后约 2 天（腐烂积累过阈）才触发**搬尸**（necrophoresis），Wilson 油酸涂活蚁被反复搬至尸堆数小时——慢积累、无恐慌；报警通路快、分钟级、panic。**两条通路时间常数差 5 个数量级**，不能合并成一个场（这解释了为什么我们"报警快速衰减"是对的：它就不是死亡信号）。

**防御谱（物种预设素材）**：喷酸（木蚁）、化学涂杀（冬季蚁分泌物使 79% 敌蚁 1h 内死亡）、自爆（Colobopsis explodens 腹部爆裂）、堵口（龟蚁头作活门 phragmosis）、整群假死（Polyrhachis femorata 2023 首次记录）。天敌：蚤蝇 <1 秒产卵攻击致断首、食蚁兽日食 ~3 万只（量级）。种间战争：阿根廷蚁超级群落边界连年混战（加州年死 ~3000 万只，量级）；波兰核掩体蚁群以 200 万具同类尸堆为食源（2016）。

**→ 对 P2.2 的对照结论**：核心机制（死者释放、panic 逃离、分钟级衰减、惊逃不释放）全部有真实对应且方向正确。增强方向按性价比排序：①**低浓度=聚集查看**的剂量分级（一个分支，语义跃升最大）；②报警**习惯化**（复用 trust 同构）；③死亡慢信号+搬尸行为（P2.5 生命周期配套，尸堆可成景观）。

来源：
- [Alarm pheromone & response of the clonal raider ant (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9941220/)
- [Alarm pheromone composition in Attini (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5371636/)
- [The Ant Who Cried Wolf? Repeated alarm exposure (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7762586/)
- [Colobopsis explodens 自爆形态 (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5919914/)
- [Wood ant formic acid 58.5% & nest disinfection (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5383563/)
- [Chemical defense by the winter ant (PLOS ONE)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0018717)
- [Fire ant decapitating flies (UF/IFAS)](https://ask.ifas.ufl.edu/publication/IN1174)
- [Kangaroo Island ants play dead (ScienceDaily 2023)](https://www.sciencedaily.com/releases/2023/05/230509122125.htm)
- [蚂蚁"记仇" (Current Biology 2025 报道)](https://m.gmw.cn/2025-01/10/content_1303944569.htm)
- [Ant supercolony 6000 km (Giraud et al. 2002, 转述)](https://spacedaily.com/m-a-single-supercolony-of-argentine-ants-is-thought-to-stretch-some-6000-km-along-the-coasts-of-southern-europe-from-italy-to-spain-billions-of-workers-across-millions-of-nests-that-trea/)

---

## 可信度说明

- 已抽查一手来源核对：雨前抢收数字（8 mbar / 2.8× / 1.5–2×，Sujimoto et al. 2019, DOI 10.1111/eth.12967）与 Phys.org 报道一致；其余条目均附来源 URL，多为 PMC/PLOS 一手文献或其摘要。
- 标注"量级"的数字（蚁筏规模、ant mill 圈径、超级群落战斗伤亡、食蚁兽食量）来自二手转述，**只可用于叙事与预设，不可作为参数标定依据**。
- 标注"存疑"的：(Z)-9-hexadecenal 归属（阿根廷蚁确认，黑毛蚁未定论）、citronellal 作为常见报警素（未获一手确认）、蚂蚁贴墙行为（无量化研究）。
- 所有"→ 启示"是设计建议，落地前照例过 bit 级回归与诚实指标。
