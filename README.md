# Antworld 蚂蚁世界

蚁群信息素(stigmergy)仿真: 数千只蚂蚁靠信息素轨迹、路径积分与个体性格涌现觅食网络。

## 跑起来

```bash
npm install
npm run dev        # http://localhost:5300
npm run build      # 产物在 dist/
```

## 玩法

- 左键: 点蚂蚁检视 / 空地放食物; 右键: 移除食物; 滚轮缩放, 拖拽平移。
- 键盘 `1/2/3/4` = 0.125/1/4/64 倍速, `0` 暂停。
- 右侧面板实时调参(感知/转向/真实感/场), 「生成新世界」换种子, 「复制分享链接」带走当前参数+种子。

## 观察什么

- 蚂蚁从乱走到成路: physarum 三触角寻路(Jones 2010)如何把噪声刻成走廊。
- 食物耗尽后的行为: 觅食超时返巢 + 路径信任(P1.9), 死点自动消散。
- 「真实感」组拉 0: 回到整齐划一的程序化蚁群, 对比极明显。

## 开发

- `node smoke.mjs` 冒烟; `node perf_check.mjs` 性能+校验和基线; `node bench.mjs` stigmergy 指标;
  `node dead_site_check.mjs` 死点行为 A/B; `render_png.mjs`(RENDER_SECS/RENDER_OUT/PARAMS env) 出验收图。
- 指标与实验记录见 **METRICS.md**, 规划见 **ROADMAP.md**。
- 红线: 新机制参数门控(0=旧行为 bit 级); 改热路径必须过校验和; 指标跨机制不可直比。
