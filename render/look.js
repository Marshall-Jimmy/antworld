// 画面外观层（P2.3.5 · 用户点名：「太丑陋。蚂蚁全都是蓝色像素斑点，至少弄成黑色的、有触须的那种。
// 背景可以换成白色。食物弄真实一点，蚂蚁搬运后食物上面应该有缺少」）。
//
// 为什么单独成模块（与 render/palette.js 同构）：蚂蚁的形状与颜色此前在三条路径里各写一遍
// —— WebGL 的 FS_ANT 是「拉长 comet」、canvas2d 是 2px fillRect、render_png 是四点短棒，
// 常数互不相同 ⇒ 验收图不代表玩家看到的画面。本文件是唯一登记处：GLSL 由这里的表生成，
// JS 两条路径消费同一张表，漂移在结构上不可能。
//
// 为什么从「发光」改成「反射」：旧画面是黑底加光（信息素＝灯、蚂蚁＝vec3(0.35,0.65,1.0) 的冷蓝
// 光点），于是 5000 只蚁在 95% 纯黑底上叠成一层蓝雪花 —— 那不是蚁群，是电视噪点。真实蚁巢是
// **土与壳**：白纸底 + 褐色墨迹走廊 + 近黑的虫体，触角与腿一眼可读。所以新画面里
//   出射色 = 环境光 × ( 纸色 ×(1−墨覆盖) + 墨色 × 墨覆盖 )
// 三条路径都算这一式，差别只在「谁逐像素、谁一次 draw call」。
//
// 回退（铁律：新机制出厂开、关掉必须逐字节退回旧画面）：
//   inkMode=0   ⇒ 场/报警/巢/墙/食物/雨全部走旧加光原码
//   antStyle=0  ⇒ 蚂蚁走旧的拉长 comet / 2px 蓝方块
//   foodLook=0  ⇒ 食物走旧的软光斑圆盘
export const PAPER = [0.980, 0.965, 0.933];        // 暖白纸(纯白刺眼, 且夜/雨的色温乘子需要余量)

// 信息素墨色: 浅土黄 → 深褐。u 用的是 palette.tone() 的同一个量, 所以自适应曝光(P2.3.2)与
// 侧抑制(P2.3.4)在墨色模式下继续原样工作 —— 它们改的是「哪一格有多浓」, 不是颜色。
export const TRAIL_STOPS = [
  [0.00, 0.16, [0.760, 0.690, 0.570]],   // 弥散痕迹: 纸上淡淡一层土黄
  [0.16, 0.42, [0.630, 0.520, 0.360]],   // 探索网
  [0.42, 0.70, [0.470, 0.350, 0.215]],   // 成形的路
  [0.70, 1.00, [0.330, 0.230, 0.140]],   // 主廊道: 踩实的深褐土
];
// 报警信息素: 红褐墨(叠在走廊之上, 与旧加光版的「危险红」同一语义, 不再是黑底上的红光)
export const ALARM_INK_STOPS = [
  [0.00, 0.18, [0.740, 0.560, 0.500]],
  [0.18, 0.55, [0.560, 0.220, 0.150]],
  [0.55, 1.00, [0.380, 0.100, 0.070]],
];
// 墨覆盖度: u∈[0,1] → α。幂 1.6 让弥散底噪几乎不上纸(u=0.07 → 0.02)而主廊道仍然透光(u=0.5 → 0.40),
// 上限 0.94 留出「这是纸上的污渍, 不是洞」的余量。k = trailInk(浓度乘子, 出厂 1.2)。
export function inkCoverage(u, k) {
  if (!(u > 0)) return 0;
  const a = k * Math.pow(u > 1 ? 1 : u, 1.6);
  return a > 0.94 ? 0.94 : a;
}

// ---- 工蚁轮廓(局部坐标: 体长=1 沿 +x 朝前, y 为横向; 触角/腿在 lod 1/2 才画) ----
// 三段身体 + 腹柄细腰是膜翅目的读数特征(头 head / 胸 thorax / 腹 gaster), 不是装饰:
// 旧画面把蚁画成一粒光点, 所以「像不像蚂蚁」这件事从来没有被回答过。
export const ANT_BODY = [
  { x: -0.300, y: 0, rx: 0.205, ry: 0.142, tone: 0.10 },   // 腹部(最大节, 略亮: 几丁质反光)
  { x: -0.085, y: 0, rx: 0.052, ry: 0.052, tone: 0.00 },   // 腹柄 petiole(细腰)
  { x: 0.075, y: 0, rx: 0.150, ry: 0.108, tone: -0.04 },   // 胸部
  { x: 0.315, y: 0, rx: 0.132, ry: 0.117, tone: -0.10 },   // 头部(最黑)
];
// 附属器: 折线(膝状触角 = 柄节 + 鞭节, 真实蚁的触角就是这么拐的; 六足; 大颚)
export const ANT_EXTRA = [
  { lod: 1, w: 0.030, pts: [[0.345, 0.055], [0.465, 0.150], [0.610, 0.112]] },
  { lod: 1, w: 0.030, pts: [[0.345, -0.055], [0.465, -0.150], [0.610, -0.112]] },
  { lod: 2, w: 0.028, pts: [[0.150, 0.050], [0.250, 0.165], [0.330, 0.250]] },
  { lod: 2, w: 0.028, pts: [[0.150, -0.050], [0.250, -0.165], [0.330, -0.250]] },
  { lod: 2, w: 0.030, pts: [[0.060, 0.075], [0.020, 0.215], [-0.020, 0.310]] },
  { lod: 2, w: 0.030, pts: [[0.060, -0.075], [0.020, -0.215], [-0.020, -0.310]] },
  { lod: 2, w: 0.030, pts: [[-0.040, 0.060], [-0.160, 0.175], [-0.265, 0.262]] },
  { lod: 2, w: 0.030, pts: [[-0.040, -0.060], [-0.160, -0.175], [-0.265, -0.262]] },
  { lod: 2, w: 0.026, pts: [[0.400, 0.052], [0.492, 0.098]] },
  { lod: 2, w: 0.026, pts: [[0.400, -0.052], [0.492, -0.098]] },
];
// 负重的工蚁叼着一粒粮(在口器前方), 而不是整只蚁变黄 —— 旧版「负重=全身泛金」把状态做成了颜色,
// 代价是蚁群在暖色走廊上糊成一片。真实工蚁搬的是叶片/种子碎块, 看得见的是**它嘴里那块东西**。
export const ANT_CRUMB = { x: 0.505, y: 0, rx: 0.088, ry: 0.068 };
export const CRUMB_RGB = [0.870, 0.760, 0.400];
// 轮廓在局部坐标里的半宽/半高(四角映射到这里; 触角尖 x=0.61, 腿尖 y=±0.31 都必须在里面)
export const ANT_U = 0.70, ANT_V = 0.40;
// 体色: 近黑暖褐。每只蚁按 uid 哈希在 CHITIN[0..2] 之间取一档(个体差异=真实感的最低要求, P1.8.5)
export const CHITIN = [[0.085, 0.070, 0.062], [0.150, 0.115, 0.085], [0.235, 0.160, 0.100]];
// 腹部高光带(P2.4d 整改): 旧写法直接拿腹部大椭圆的 coverage 当高光, 而 coverage 在 0.74 倍半径内
// 恒等于 1 ⇒ 放大看是一整块扁平浅棕, 比虫体本身还抢眼(用户: 太丑陋)。真实工蚁的 gaster 是一颗
// 光滑的胶囊, 从上方看反光是一条**沿体轴的窄带**, 只占腹部一小半, 而且是连续衰减不是硬边。
// 位置取偏背侧(局部 -y)半格: 高光压在轮廓正中会读成「一条白线」而不是「一个圆肚子」。
export const ANT_SHEEN = { x: -0.286, y: -0.044, rx: 0.126, ry: 0.050 };
// 增益从 0.9 降到 0.42: 三档几丁质里最亮那档(0.235)加 0.9 倍中档(0.150)会得到 0.37 的浅棕,
// 那已经不是「壳的反光」而是「另一种颜色的虫子」。0.42 倍下最亮档落在 0.30, 仍比纸暗两个数量级。
export const SHEEN_GAIN = 0.42;

// ---- 参考实现(JS): PNG 路径逐像素用它, GLSL 由同一批表生成 ⇒ 两条路径不可能长成两个样子 ----
const TAU = Math.PI * 2;
function sstep(a, b, x) {
  const k = (x - a) / (b - a);
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  return k * k * (3 - 2 * k);
}
// 角向 bin 的稳定哈希(整数进 0..1 出): 缺口边缘的锯齿, 同一块食物永远同一副啃痕, 不逐帧抖
function hash1(n) {
  let h = (n * 374761393) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function covEllipse(x, y, c) {
  const dx = (x - c.x) / c.rx, dy = (y - c.y) / c.ry;
  return 1 - sstep(0.74, 1.0, Math.sqrt(dx * dx + dy * dy));
}
function covPoly(x, y, pts, w) {
  let best = 0;
  for (let k = 1; k < pts.length; k++) {
    const ax = pts[k - 1][0], ay = pts[k - 1][1], bx = pts[k][0], by = pts[k][1];
    const px = x - ax, qx = bx - ax, qy = by - ay;
    const t = Math.max(0, Math.min(1, (px * qx + (y - ay) * qy) / Math.max(qx * qx + qy * qy, 1e-9)));
    const d = Math.hypot(px - qx * t, (y - ay) - qy * t);
    const c = 1 - sstep(w * 0.28, w * 0.5, d);
    if (c > best) best = c;
  }
  return best;
}
// 一只蚁的覆盖度: body=几丁质(含触角/腿), crumb=叼着的粮, sheen=腹部高光
export function antCoverage(x, y, lod) {
  let body = 0, crumb = 0, sheen = 0;
  for (let i = 0; i < ANT_BODY.length; i++) {
    const c = covEllipse(x, y, ANT_BODY[i]);
    if (c > body) body = c;
  }
  sheen = covEllipse(x, y, ANT_SHEEN);   // 高光带是独立形状, 不再等于整节腹部的 coverage
  if (lod >= 1) {
    for (let i = 0; i < ANT_EXTRA.length; i++) {
      const e = ANT_EXTRA[i];
      if (e.lod > lod) continue;
      const c = covPoly(x, y, e.pts, e.w);
      if (c > body) body = c;
    }
  }
  const cc = covEllipse(x, y, ANT_CRUMB);
  if (cc > crumb) crumb = cc;
  return { body, crumb, sheen };
}
// 屏幕像素→轮廓细节档: 触角在 7.5 px 以下就是亚像素噪声(画了反而更像斑点), 腿要 13 px 以上;
// 蚁数一多, 高细节档的填充率会先吃掉帧预算 ⇒ 数量也参与决定 LOD(不是可选装饰, 是护栏)。
export function antLod(pxLen, n) {
  if (pxLen < 7.5) return 0;
  if (pxLen < 13 || n > 14000) return 1;
  return 2;
}
// 个体差异: 从 uid(永不复用, P2.5 的身份锚)取一个稳定的 0..1。
// 为什么不用 seedNoise: 那是随机流**状态**, 每步都变 ⇒ 拿它上色会让每只蚁逐帧换皮肤。
export function antVar(uidOrIndex) {
  return hash1((uidOrIndex | 0) + 1);
}

// ---- 被啃的食物 ----
// f = 已吃掉的比例 = 1 - amount/a0。三件事同时发生: 整体缩小(搬走的就是没了)、一个角度跨度正比于 f
// 的缺口、缺口边缘按 bins 个角向块抖动(= 啃痕)。旧画面是一圈绿色光环, 取食 90% 之后与取食 0% 长得
// 一模一样 —— 用户说的「食物上面应该有缺少」正是这条没被满足。
// 三个整形旋钮, 每一个都是被自己的截图否证之后才加上的(推导过程见 METRICS P2.3.5 §2):
//   fade   缺口两端在 fade 弧度内收到零深。硬切的扇形会留下两条笔直的半径边, 那叫切蛋糕, 不叫被啃;
//   depth  小 f 时只咬破浅浅一层, 吃到 1/depth 成才见底。否则吃掉 5% 也会挖出半个圆;
//   biteK  内瓤带的内界(bite 从切口往里 0→1, 只有 bite>0.12 的那圈是浅色 = 切口外缘 14%)。
//          远看反而像「那里多了一块东西」, 于是「缺少」又读不出来了。
export const FOOD = { bins: 14, min: 0.40, var: 0.34, ripA: 0.045, ripF: 6.7, shrink: 0.55, edge: 0.88, biteK: 0.86, fade: 0.30, depth: 2.2 };
// 剩下的半径: 搬走的就是没了(整体缩小), 与缺口一起构成「缺少」的读数
export function foodRadius(r, f) { return r * (FOOD.shrink + (1 - FOOD.shrink) * (1 - (f > 1 ? 1 : f))); }
// 某个角度上食物还剩多厚(世界单位)。缺口 = 已吃掉的那段角度里边界内缩;
// bins 个角向块(块越大越像「被啃掉一口」而不是「被齿轮刀切过」)+ 一道低频起伏。
// Canvas2D 用它描多边形, PNG 用它逐像素判覆盖, WebGL 用生成出来的同一套常数。
export function foodBoundary(r, f, seed, a) {
  const R = foodRadius(r, f);
  if (f <= 0.002) return R;
  let t = a - seed * TAU;
  t -= Math.floor(t / TAU) * TAU;
  if (t >= TAU * (f > 1 ? 1 : f)) return R;
  // 角向噪声在 bin 中心之间做 smoothstep 插值: 直接取整会得到 14 级硬台阶,
  // 吃到 f≈1 时那圈台阶在特写里读起来像贴纸锯齿, 而不是「被啃出来的口」
  const u = (t / TAU) * FOOD.bins, b0 = Math.floor(u), fr = u - b0;
  const sb = Math.floor(seed * 977);
  const nz = hash1(b0 + sb) + (hash1(b0 + 1 + sb) - hash1(b0 + sb)) * (fr * fr * (3 - 2 * fr));
  const base = FOOD.min + FOOD.var * nz + FOOD.ripA * Math.sin(t * FOOD.ripF);
  const span = TAU * (f > 1 ? 1 : f);
  // 渐深: 缺口两端收到零深(硬切的扇形边是直线, 一眼假), 整体深度随已吃比例压暗
  const fw = Math.min(span * 0.5, FOOD.fade);
  const e2 = Math.min(1, Math.min(t, span - t) / Math.max(fw, 1e-6));
  const dep = Math.min(1, f * FOOD.depth);
  return R * (1 - (1 - base) * e2 * e2 * (3 - 2 * e2) * dep);
}
export function foodCoverage(dx, dy, r, f, seed) {
  const R = foodRadius(r, f);
  const rr = Math.sqrt(dx * dx + dy * dy);
  if (rr > R) return { cov: 0, bite: 0 };
  const edge = 1 - sstep(FOOD.edge, 1.0, rr / R);
  if (f <= 0.002) return { cov: edge, bite: 0 };
  let a = Math.atan2(dy, dx) - seed * TAU;
  a -= Math.floor(a / TAU) * TAU;
  const span = TAU * (f > 1 ? 1 : f);
  if (a >= span) return { cov: edge, bite: 0 };
  const lim = foodBoundary(r, f, seed, Math.atan2(dy, dx));
  if (rr > lim) return { cov: 0, bite: 0 };
  // bite = 离切口还有多远(1 就是切面)。方向曾经写反(1 - sstep) ⇒ 整个断面都算切面,
  // 于是「被啃掉的那一块」反而被涂成一整片浅色, 看上去像多了一块东西。见 METRICS P2.3.5 教训 ㊽。
  return { cov: edge, bite: sstep(FOOD.biteK, 1.0, rr / Math.max(lim, 1e-6)) };
}
export const FOOD_HULL = [0.470, 0.330, 0.150];   // 外壳: 深褐
export const FOOD_FLESH = [0.845, 0.735, 0.500];  // 新啃口: 胚乳米黄(比纸暗一档又偏暖, 远看才读得出「这里被啃开过」)

// ---- GLSL 生成(与上面同源) ----
export function glslAnt() {
  const NL = String.fromCharCode(10);
  let s = 'float awCovE(vec2 p, vec2 c, vec2 r){ vec2 d=(p-c)/r; return 1.0-smoothstep(0.74,1.0,length(d)); }\n';
  s += 'float awCovP(vec2 p, vec2 a, vec2 b, float w){ vec2 pa=p-a, ba=b-a; ' +
       'float t=clamp(dot(pa,ba)/max(dot(ba,ba),1e-9),0.0,1.0); ' +
       'return 1.0-smoothstep(w*0.28,w*0.5,length(pa-ba*t)); }\n';
  s += 'void awAnt(vec2 p, float lod, out float body, out float crumb, out float sheen){\n';
  s += '  body=0.0; crumb=0.0; sheen=0.0;\n';
  ANT_BODY.forEach((c) => {
    s += `  { float c=awCovE(p, vec2(${c.x.toFixed(3)}, ${c.y.toFixed(3)}), vec2(${c.rx.toFixed(3)}, ${c.ry.toFixed(3)}));` +
         ` body=max(body,c); }\n`;
  });
  s += `  sheen=awCovE(p, vec2(${ANT_SHEEN.x.toFixed(3)}, ${ANT_SHEEN.y.toFixed(3)}), vec2(${ANT_SHEEN.rx.toFixed(3)}, ${ANT_SHEEN.ry.toFixed(3)}));\n`;
  for (const e of ANT_EXTRA) {
    // 逐条 fold 成 body=max(body,段) —— 每句恰好两个实参。曾想把多段拼成一行, 写成
    // seg.join(NL): 分隔符落在括号里成了「无实参」, JS 于是用默认分隔符逗号,
    // 生成 max(body,a,b,c) 这种四参调用 => GLSL 编译失败 => WebGL2 静默兜底 Canvas2D。
    // 与教训 15 同一失败模式, 这次由 _backend_probe.html 抓到(HUD 只会说「兜底」不会说为什么)。
    let inner = '';
    for (let k = 1; k < e.pts.length; k++) {
      const a = e.pts[k - 1], b = e.pts[k];
      inner += '  body=max(body, awCovP(p, vec2(' + a[0].toFixed(3) + ', ' + a[1].toFixed(3) +
               '), vec2(' + b[0].toFixed(3) + ', ' + b[1].toFixed(3) + '), ' + e.w.toFixed(3) + '));' + NL;
    }
    s += '  if (lod >= ' + e.lod + '.0) {' + NL + inner + '  }' + NL;
  }
  s += `  crumb=awCovE(p, vec2(${ANT_CRUMB.x.toFixed(3)}, ${ANT_CRUMB.y.toFixed(3)}),` +
       ` vec2(${ANT_CRUMB.rx.toFixed(3)}, ${ANT_CRUMB.ry.toFixed(3)}));\n}`;
  return s;
}
export function glslChitin() {
  const f = (v) => v.toFixed(4);
  const c = CHITIN.map((t) => `vec3(${t.map(f).join(',')})`).join(', ');
  return `const vec3 awChitin[3] = vec3[3](${c});\nconst float awSheenGain = ${SHEEN_GAIN.toFixed(3)};\nconst vec3 awCrumb = vec3(${CRUMB_RGB.map(f).join(',')});\n` +
    `const vec3 awHull = vec3(${FOOD_HULL.map(f).join(',')});\nconst vec3 awFlesh = vec3(${FOOD_FLESH.map(f).join(',')});`;
}
export function glslInkRamp(fnName, stops) {
  const f = (x) => x.toFixed(5);
  let body = `vec3 ${fnName}(float u){\n  vec3 c = vec3(${f(stops[0][2][0])}, ${f(stops[0][2][1])}, ${f(stops[0][2][2])});\n`;
  for (const [u0, u1, c] of stops) body += `  c = mix(c, vec3(${c.map(f).join(', ')}), smoothstep(${f(u0)}, ${f(u1)}, u));\n`;
  return body + '  return c;\n}';
}
export function glslInk() {
  return 'float awInk(float u, float k){ if (u <= 0.0) return 0.0; float a = k*pow(min(u,1.0), 1.6); return min(a, 0.94); }';
}
export function glslFood() {
  const F = FOOD;
  return `float awFoodR(float r, float f){ return r*(${F.shrink.toFixed(2)}+${(1 - F.shrink).toFixed(2)}*(1.0-min(f,1.0))); }
void awFood(vec2 d, float r, float f, float seed, out float cov, out float bite){
  float R = awFoodR(r, f);
  float rr = length(d);
  cov = 0.0; bite = 0.0;
  if (rr > R) return;
  float edge = 1.0 - smoothstep(${F.edge.toFixed(2)}, 1.0, rr/R);
  if (f <= 0.002) { cov = edge; return; }
  float a = atan(d.y, d.x) - seed*6.2831853;
  a = a - floor(a/6.2831853)*6.2831853;
  float span = 6.2831853*min(f,1.0);
  if (a >= span) { cov = edge; return; }
  float u = a/6.2831853*${F.bins.toFixed(1)}, b0 = floor(u), fr = u-b0, sb = floor(seed*977.0);
  float nz = mix(awHash(b0+sb), awHash(b0+1.0+sb), fr*fr*(3.0-2.0*fr));
  float base = ${F.min.toFixed(2)}+${F.var.toFixed(2)}*nz+${F.ripA.toFixed(3)}*sin(a*${F.ripF.toFixed(1)});
  float fw = min(span*0.5, ${F.fade.toFixed(2)});
  float e2 = clamp(min(a, span-a)/max(fw,1e-6), 0.0, 1.0);
  float lim = R*(1.0-(1.0-base)*e2*e2*(3.0-2.0*e2)*min(f*${F.depth.toFixed(1)},1.0));
  if (rr > lim) return;
  cov = edge;
  bite = smoothstep(${F.biteK.toFixed(2)}, 1.0, rr/max(lim,1e-6));
}`;
}
export function glslHash1() {
  return `float awHash(float n){
  uint h = uint(n) * 374761393u;
  h = ((h >> 13u) ^ h) * 1274126177u;
  h = (h >> 16u) ^ h;
  return float(h) / 4294967296.0;
}`;
}

// ---- Canvas2D: 轮廓做成 Path2D 缓存(每只蚁只做一次 setTransform + 至多 3 次 draw) ----
let _paths = null;
export function antPaths() {
  if (_paths) return _paths;
  if (typeof Path2D === 'undefined') return null;      // node 侧(render_png)用不到
  const body = new Path2D();
  for (const c of ANT_BODY) body.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, TAU);
  const mk = (lod) => {
    const p = new Path2D();
    for (const e of ANT_EXTRA) {
      if (e.lod > lod) continue;
      p.moveTo(e.pts[0][0], e.pts[0][1]);
      for (let k = 1; k < e.pts.length; k++) p.lineTo(e.pts[k][0], e.pts[k][1]);
    }
    return p;
  };
  // 腹部高光带: 与 GLSL/JS 参考实现同一张 ANT_SHEEN 表(三条路径不可能长成三个样子)。
  // 这里仍是一块实心斑而不是连续衰减 —— 兜底路径优先保帧率, 见本文件顶部注释 3。
  const sheen = new Path2D();
  sheen.ellipse(ANT_SHEEN.x, ANT_SHEEN.y, ANT_SHEEN.rx, ANT_SHEEN.ry, 0, 0, TAU);
  const crumb = new Path2D();
  crumb.ellipse(ANT_CRUMB.x, ANT_CRUMB.y, ANT_CRUMB.rx, ANT_CRUMB.ry, 0, 0, TAU);
  _paths = { body, crumb, sheen, e1: mk(1), e2: mk(2), w1: 0.030, w2: 0.029 };
  return _paths;
}
