// 信息素/报警的「浓度 → 亮度」色阶，三条渲染路径(WebGL2 / Canvas2D / PNG)共用同一份定义。
//
// 为什么要单独成模块：此前 WebGL 着色器、canvas2d 的 mapColor、render_png 里各写了一套色阶，
// 常数还互不相同(core 增益 1.6 vs 1.8)。同一份 sim 状态在两条路径下长得不一样，验收图就不能
// 代表玩家看到的画面——这是"光污染"迟迟没被发现的一半原因。现在 GLSL 由这里的 stop 表生成，
// 漂移在结构上就不可能了。
//
// 光污染治理(P2.3.1)的机制理由：
// 实测场强跨场景相差约 500 倍(默认 120s 的 max=0.13 vs 管饱昼间的 max=60、p99=17.7)，
// 而旧色阶是"线性到 peak 后硬钳制 + 再叠一层 1.6 倍金色核心"。于是 peak 以上整条觅食网
// (实测 4.38% 的格子)全被压成同一个值，且各通道溢出到 1.0 以上 → 截断成纯白。
// 结果就是一块看不出结构的白色光斑：走廊的宽度、分叉、强弱全丢了。这就是"光污染"。
// 修法是把色阶改成**有界且对数上肩**：peak 之上有 8 个倍频程(2^8=256×)才走到白热上限，
// 每翻倍亮度可辨地上升一档，且任何通道永不溢出 1.0 → 高浓度区重新读出结构。

// peak 之上的倍频程数：v = peak → 半亮；v = 256×peak → 白热上限。
// 为什么是 8：实测同一个 peak 下最浓的格子与弥散底噪相差 3 个数量级(管饱昼间 max=60 vs p90=0.015)，
// 6 个倍频程(64×)仍会把最热的核心压成一块平顶；8 个(256×)刚好让整条觅食网都留在斜坡上。
export const OCTAVES = 8;

// t = v/peak(无上界) → u ∈ [0,1]。半亮点以下线性(保留旧画面里"淡痕几乎不发光"的观感)，
// 以上按 log2 压缩(把 2~3 个数量级摊进剩下的一半色阶里)。
export function tone(t) {
  if (!(t > 0)) return 0;
  if (t <= 1) return 0.5 * t;
  const u = 0.5 + 0.5 * Math.log2(t) / OCTAVES;
  return u < 1 ? u : 1;
}

function smoothstep(a, b, x) {
  const k = (x - a) / (b - a);
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  return k * k * (3 - 2 * k);
}

// 色阶 stop 表：[起始 u, 结束 u, rgb]，逐级 mix —— 与着色器里生成的那串 mix 严格同构。
// 全部 stop 的每个通道 ≤ 0.99：additive 叠在背景上也不会截断成白，最亮读作"白热金"。
export const FIELD_STOPS = [
  [0.00, 0.07, [0.010, 0.022, 0.060]],   // 弥散痕迹: 只比背景亮一丝
  [0.07, 0.20, [0.040, 0.110, 0.280]],   // 暗蓝: 探索网
  [0.20, 0.42, [0.075, 0.250, 0.560]],   // 蓝: 成形的路
  [0.42, 0.62, [0.140, 0.500, 0.860]],   // 电蓝: 主廊道
  [0.62, 0.78, [0.360, 0.760, 0.970]],   // 亮青: 高强度
  [0.78, 0.88, [0.700, 0.830, 0.900]],   // 青白: 高温过渡。必须绕这一站——青(蓝高红低)直接混到金
                                        //   (红高蓝低)会穿过灰绿, 看着像脏而不是像热
  [0.88, 0.96, [0.930, 0.830, 0.520]],   // 金: 饱和核心
  [0.96, 1.00, [0.990, 0.930, 0.760]],   // 白热金: 上限(256×peak 才到)
];

// 报警红：整体再乘 0.85，给底下的信息素场留出余量(两层都是 additive，不能各自打满)
export const ALARM_STOPS = [
  [0.00, 0.10, [0.047, 0.007, 0.005]],
  [0.10, 0.32, [0.170, 0.024, 0.015]],
  [0.32, 0.58, [0.442, 0.060, 0.030]],
  [0.58, 0.82, [0.748, 0.170, 0.060]],
  [0.82, 1.00, [0.850, 0.476, 0.255]],
];

// 链式 mix：c ← mix(c, stop.rgb, smoothstep(u0,u1,u))。out 复用调用方的数组(热路径零分配)。
export function rampColor(stops, u, out) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], k = smoothstep(s[0], s[1], u), c = s[2];
    r += (c[0] - r) * k; g += (c[1] - g) * k; b += (c[2] - b) * k;
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

// 每帧对 4 万个格子求值不划算：把 ramp 打成 LUT，逐格只剩 tone + 一次查表。
// 键只跟 stop 表有关(peak 在 tone 之前除，不进 LUT)，所以调 peak 不触发重建。
const LUT_N = 1024;
const lutCache = new Map();

export function rampLut(stops, name) {
  // name 必须给: 否则两张新表(墨色/报警墨)会共用同一个 other 槽, 拿到彼此的 LUT
  const key = name || (stops === FIELD_STOPS ? 'field' : stops === ALARM_STOPS ? 'alarm' : 'other');
  let lut = lutCache.get(key);
  if (lut) return lut;
  lut = new Uint8Array((LUT_N + 1) * 3);
  const tmp = [0, 0, 0];
  for (let i = 0; i <= LUT_N; i++) {
    rampColor(stops, i / LUT_N, tmp);
    lut[i * 3] = Math.round(tmp[0] * 255);
    lut[i * 3 + 1] = Math.round(tmp[1] * 255);
    lut[i * 3 + 2] = Math.round(tmp[2] * 255);
  }
  lutCache.set(key, lut);
  return lut;
}

// u ∈ [0,1] → LUT 下标(与 rampLut 配套；越界钳在两端)
export function lutIndex(u) {
  const i = (u * LUT_N) | 0;
  return i < 0 ? 0 : i > LUT_N ? LUT_N : i;
}

// 由同一张 stop 表生成 GLSL —— 着色器里的色阶与这里的常数不可能再对不上。
export function glslRamp(fnName, stops) {
  const f = (x) => x.toFixed(5);
  let body = `vec3 ${fnName}(float u){\n  vec3 c = vec3(0.0);\n`;
  for (const [u0, u1, c] of stops) {
    body += `  c = mix(c, vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])}), smoothstep(${f(u0)}, ${f(u1)}, u));\n`;
  }
  return body + '  return c;\n}';
}

export function glslTone() {
  return `float awTone(float t){
  if (t <= 0.0) return 0.0;
  if (t <= 1.0) return 0.5 * t;
  return min(1.0, 0.5 + 0.5 * log2(t) / ${OCTAVES}.0);
}`;
}
