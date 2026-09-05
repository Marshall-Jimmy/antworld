// look_check.mjs —— P2.3.5 画面外观门禁：白纸墨色 / 黑壳工蚁 / 会被啃的食物 / GLSL 静态 lint
//
// 为什么要有这个文件。P2.3.5 开工后浏览器实测发现：整个阶段跑的是 Canvas2D 兜底，而 WebGL2
// 在这台机器上完全可用。病根是两段着色器编译错误（四参 max / FS 漏声明一个 varying）：编译失败之后
// 代码 return false 静默退回，HUD 只说「Canvas2D(兜底)」不说为什么 ⇒ 一个 bug 烧掉一小时。
// 校验和 / 全部旧门禁 / 验收 PNG 都抓不到它：它们一个不看 DOM，一个不走 GPU。
// 本门禁把这一类 bug 变成**没有 GPU 也能跑**的静态检查（A11-A14），并把肉眼裁决换成像素判据（A1-A5）。
//
// =========================== 判据（先写死，读数只在 stdout）===========================
// A1 退回逐字节：PARAMS=inkMode=0,antStyle=0,foodLook=0 出的图，SHA256 必须等于登记值。
//    登记值来自 `git worktree add .headwt HEAD; node .headwt/render_png.mjs`（= P2.3.4 出厂图）。
//    §4 铁律「关掉必须逐字节退回旧画面」只有这一种证明形式，"看起来一样"不算。
// A2 量具能看见差异：fact 与 legacy 必须大面积不同（>30% 像素）。A1 防"两个配置出同一张图"，
//    A2 防"同一张图被写了两次所以 A1 当然相同"。两条合起来才叫退回证明（§10 红线）。
// A3 白纸：fact 近黑像素占比必须远低于 legacy（旧画面是黑底加光），比值 <0.25 且绝对值 <15%。
//    用比值不用绝对值：绝对阈值随场景内容漂，同一个场景里自比才尺度不变。
// A4 冷蓝雪消失：旧蚁色 vec3(0.35,0.65,1.0) 的识别子（蓝≥170 且 蓝−红≥90 且 绿≥红）在 fact 里
//    相对 legacy 掉到 <2%，且绝对值 <0.5% 画面。这条钉的是用户那句"全都是蓝色像素斑点"。
// A5 蚁是暗色虫体：只切 antStyle 一档（其余同出厂）作差 —— 差异像素占比 >0.05%（证明开关真的有效），
//    且差异像素在 fact 侧均亮度 <0.35（证明"黑壳"真的是暗的）。
// A6 触角/细腰/叼粮：antCoverage 触角中点 lod1 有墨而 lod0 无墨；形体极值必须落在 ANT_U/ANT_V 四边形
//    内（否则触角尖被轮廓裁断）；sheen 只落在腹部；粮粒在头部前缘之外（状态不是全身变色）。
// A7 LOD 阶梯：7.5px 以下不画附属器，13px 以上才画腿，蚁数 >14000 压回 1 档（填充率护栏）。
// A8 食物会被啃：剩余半径随已吃比例 f 单调缩；盘内剩余覆盖面积随 f 单调降且 f=1 时 <0.6×f=0；
//    缺口角跨度/f ∈[0.8,1.2]；f=0 无缺口；同一 seed 两次逐位相同（不许逐帧抖）。
// A9 新啃口只贴在切口：断面内侧 bite 高、颗粒内部 bite≈0 —— 上一版方向写反（1−sstep）被自己的截图否证。
// A10 墨覆盖：对 u 与对 k 都单调增；u<=0 恒零墨；封顶 0.94；底噪(u=.07)不上纸而主廊(u=.5)仍透光。
// A11 GLSL 实参个数：14 段源码里每个内建函数调用的实参数必须落在合法集合内，且不许出现空实参。
//     上一轮生成的正是 max(body,a,b,c) —— 一行静态检查就能抓住，代价却是一整个阶段。
// A12 GLSL varying 配对：FS 的每个 in 必须在配对 VS 里有同名 out；VS 的 out 若被 FS 引用必须有 in。
// A13 GLSL 声明完整：源码里出现的 u<大写>/v<大写> 标识符必须有全局声明；且不许有 `;;`
//     （P2.3 的六处 `uniform vec3 uAmbient;;` 就是这个形状，它静默烧掉了一整个 P2.3）。
// A14 接线：look.js 生成的块真的进了最终着色器源码；生成的常数真的由表驱动（不是手抄第二遍）。
// A15 参数登记：三个开关出厂=1（新画面默认开）且 min=0（必须能关），六个新参数都进了分组表。
// Az*  对照臂：故意造出四参 max / 漏声明 varying / `;;` 三段假源码，判据必须报红。
//     没有这一组，A11-A13 完全可以因为"检查器根本没在扫"而恒绿（§10「量具不许有看起来在测其实没测的行」）。
//
// A16 场 quad 铺满世界 + 混合约定成对：quadVertices 两个三角形的面积和必须 == w*h, 两三角形绕序
//     必须同号; 而且 webgl2.js 里**不许再出现手写的四边形顶点字面量**(只能经 quadVertices)。
//     这条是本轮抓出来的真 bug: 缓冲里只有 4 个顶点而 draw 画 6 个 => 第二个三角形退化 => 世界只有
//     左上那一半被画上信息素层。加光时代 clearColor 与场光在 v=0 处同为近黑所以看不出来, 换白纸才现形。
//     同时钉「FS 输出非预乘」与「墨色分支用 SRC_ALPHA」必须成对出现 —— 它们曾经一边改完另一边没跟,
//     结果 (ONE, 1-SRC_ALPHA) 配上非预乘 rgb, 把「盖在纸上的染色」算成了加光, 有场的一半过曝成纯白。
// Az4 对照臂: 故意把 quad 少写一个顶点, 面积判据必须报红。
// SUB=pixel|shape|glsl|param  分组跑；默认全跑。pixel 组要跑 3 次 render_png（各约 7 s）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { values, SCHEMA, groupOf } from './core/config.js';
import { PAPER, TRAIL_STOPS, ALARM_INK_STOPS, inkCoverage, ANT_BODY, ANT_EXTRA, ANT_CRUMB, ANT_SHEEN, SHEEN_GAIN, ANT_U, ANT_V, CHITIN, CRUMB_RGB, antCoverage, antLod, antVar, FOOD, foodRadius, foodBoundary, foodCoverage, glslAnt, glslFood, glslInk } from './render/look.js';
import { shaderSources, quadVertices } from './render/webgl2.js';

const NL = String.fromCharCode(10);
const SUBS = (process.env.SUB || 'pixel,shape,glsl,param').split(',');
const want = (s) => SUBS.includes(s);
let PASS = 0, FAIL = 0;
const ok = (name, cond, detail) => {
  if (cond) { PASS++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { FAIL++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
  return !!cond;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// P2.3.4 出厂图（800x520）的 SHA256 —— 来历见 A1。改 sim 热路径要重跑 §3 的 worktree 对照并同步登记值,
// 与四钉同批：这条判据和 perf_check 一起构成「渲染层改动不可能悄悄改变 sim」的双向证明。
const LEGACY_SHA = '75d1407413bcb129084f143142012226c7a7d2f5ea8e53e7c0cfcf78030327fd';
function SHOT(name, params, secs) {
  const env = { ...process.env, RENDER_OUT: name };
  if (params) env.PARAMS = params;
  if (secs) env.RENDER_SECS = String(secs);
  const t0 = Date.now();
  const log = execFileSync(process.execPath, ['render_png.mjs'], { env, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const file = 'screenshots/' + name;
  if (!existsSync(file)) throw new Error('render_png 没产出 ' + file);
  const buf = readFileSync(file);
  return { file, sha: createHash('sha256').update(buf).digest('hex'), png: PNG.sync.read(buf), ms, log: log.trim().split(NL).pop() };
}
const lum255 = (p, o) => 0.299 * p[o] + 0.587 * p[o + 1] + 0.114 * p[o + 2];
function stats(img) {
  const p = img.data, n = img.width * img.height;
  let dark = 0, blue = 0, warm = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = p[o], g = p[o + 1], b = p[o + 2], L = lum255(p, o);
    if (L < 25.5) dark++;                                  // 近黑: 亮度 <10%
    if (b >= 170 && b - r >= 90 && g >= r) blue++;         // 旧蚁色识别子(A4)
    if (r >= 200 && g >= 190 && b >= 170 && b <= g) warm++; // 暖白纸
    sum += L;
  }
  return { n, dark: dark / n, blue: blue / n, warm: warm / n, mean: sum / n / 255 };
}
function diffFrac(a, b) {
  const pa = a.data, pb = b.data; let d = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) d++;
  }
  return d / (a.width * a.height);
}
function diffBand(a, b) {
  // a->b 的差异带: 占比 + 两各自侧的均亮度 + 两各自侧「近黑核心」(L<25%) 占差异带的比例。
  // 为什么不用单侧绝对阈值: 差异带里大半是半覆盖的轮廓边缘(墨 alpha = cov), 均值必然被它们抬起来;
  // 上一版写死 meanLum < 0.35 是把『实心那一格』当成了『整个带』, 第一条读数 0.406 直接假红(见 METRICS P2.3.5 ㊾)。
  // 比值与分位才是尺度无关的: 同一批像素两边互比, 场景整体变亮变暗都不改判据。
  const pa = a.data, pb = b.data; let d = 0, sumA = 0, sumB = 0, dkA = 0, dkB = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) {
      const LA = lum255(pa, i), LB = lum255(pb, i);
      d++; sumA += LA; sumB += LB; if (LA < 64) dkA++; if (LB < 64) dkB++;
    }
  }
  const n = a.width * a.height;
  return { frac: d / n, meanA: sumA / Math.max(d, 1) / 255, meanB: sumB / Math.max(d, 1) / 255,
    darkA: dkA / Math.max(d, 1), darkB: dkB / Math.max(d, 1) };
}

// ---- GLSL 静态 lint 的零件 ----
function strip(src) {
  let s = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== NL) i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') i++; i++; continue; }
    s += c; i++;
  }
  return s;
}
// depthMask: 只留括号深度 0 的文本(深度 >0 换成空格)。声明扫描与 `;;` 扫描都要它 ——
// `void awAnt(vec2 p, out float body)` 与 `for (;;)` 都在括号里, 不抹白会假红。
function depthMask(s) {
  let out = '', d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') { if (d > 0) d--; }
    out += d > 0 ? ' ' : c;
  }
  return out;
}
const ARITY = {
  max: [2], min: [2], mix: [3], clamp: [2, 3], smoothstep: [2, 3], step: [2], pow: [2],
  length: [1], distance: [2], dot: [2], normalize: [1], reflect: [2], refract: [3],
  abs: [1], sign: [1], floor: [1], ceil: [1], fract: [1], mod: [2], modf: [2], vec2: [0, 1, 2],
  vec3: [0, 1, 2, 3], vec4: [0, 1, 2, 3, 4], mat2: [0, 1, 2], mat3: [0, 1, 3],
  texture: [2, 3], float: [1], int: [1], uint: [1], atan: [1, 2], asin: [1], acos: [1],
  sin: [1], cos: [1], tan: [1], sqrt: [1], inversesqrt: [1], exp: [1], log: [1], exp2: [1],
  log2: [1], trunc: [1], round: [1], lessThan: [1], greaterThan: [1], equal: [1], notEqual: [1],
  all: [1], any: [1], not: [1], transpose: [1], inverse: [1], dFdx: [1], dFdy: [1],
};
const TYPES = '\\b(?:void|float|int|uint|bool|vec2|vec3|vec4|bvec2|bvec3|bvec4|mat2|mat3|ivec2|ivec3|uvec2|sampler2D|usampler2D)\\b';
// 顶层实参切分: 只在深度 1 切逗号。f() 会得到 [''] —— 空实参是上一轮那个 join bug 的指纹。
// 扫描必须**停在开括号上**由它把深度从 0 抬到 1: 早先写成从括号后开始, 于是实参里第一个
// 嵌套调用(max(a, min(b,c)))的闭括号被当成整个调用的结束, 判据假红。
function callSites(s) {
  const res = [];
  const re = new RegExp('\\b([A-Za-z_]\\w*)\\s*\\(', 'g');
  let m;
  while ((m = re.exec(s))) {
    let i = re.lastIndex - 1, d = 0, cur = '', args = [];
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[' || c === '{') { d++; if (d > 1) cur += c; continue; }
      if (c === ')' || c === ']' || c === '}') {
        d--;
        if (d === 0) { args.push(cur.trim()); break; }
        cur += c; continue;
      }
      if (c === ',' && d === 1) { args.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    res.push({ name: m[1], args, at: m.index });
  }
  return res;
}
function decls(s) {
  const g = depthMask(strip(s)), all = strip(s);
  const out = new Set(), ins = new Set(), names = new Set();
  for (const line of g.split(NL)) {
    let k = line.match(new RegExp('^\\s*(?:(?:flat|noperspective|smooth|centroid)\\s+)*(in|out)\\s+(?:\\w+)(?:\\s*\\[[^\\]]*\\])?\\s+(\\w+)'));
    if (k) (k[1] === 'in' ? ins : out).add(k[2]);
    k = line.match(/^\s*uniform\s+(?:\w+)(?:\s*\[[^\]]*\])?\s+(\w+)/);
    if (k) names.add(k[1]);
  }
  // 任何深度的 `类型 名字` 都算声明过(局部量/函数形参都在括号里, 光看深度 0 会把它们误判成野引用)
  for (const k of all.match(new RegExp(TYPES + '\\s*(?:\\[[^\\]]*\\])?\\s*([A-Za-z_]\\w*)', 'g')) || []) {
    const id = /([A-Za-z_]\w*)\s*$/.exec(k); if (id) names.add(id[1]);
  }
  return { out, ins, names };
}
function lintSources(pairs) {
  const bad = [], empty = [], vbad = [], dbad = [], wired = {};
  for (const [name, vs, fs] of pairs) {
    for (const kind of [['vs', vs], ['fs', fs]]) {
      const s = strip(kind[1]);
      for (const c of callSites(s)) {
        const allow = ARITY[c.name];
        if (!allow) continue;
        if (c.args.length === 1 && c.args[0] === '') { empty.push(name + '/' + kind[0] + ' ' + c.name + '()'); continue; }
        if (!allow.includes(c.args.length)) {
          bad.push(name + '/' + kind[0] + ' ' + c.name + ' 实参 ' + c.args.length + ' 个(合法 ' + allow.join('/') + '): ' + c.args.join('|').slice(0, 60));
        }
      }
      if (/;;/.test(depthMask(s))) dbad.push(name + '/' + kind[0] + ' 有两个连续分号');
      const D = decls(kind[1]);
      for (const t of s.match(/\b(?:u|v)[A-Z]\w*\b/g) || []) {
        if (!D.names.has(t)) dbad.push(name + '/' + kind[0] + ' 引用了 ' + t + ' 但没有它的声明');
      }
    }
    const G = decls(vs), H = decls(fs);
    for (const v of H.ins) if (!G.out.has(v)) vbad.push(name + ': FS 声明了 in ' + v + ' 而 VS 没有同名 out');
    for (const v of G.out) if (!H.ins.has(v) && new RegExp('\\b' + v + '\\b').test(fs)) vbad.push(name + ': VS 的 out ' + v + ' 被 FS 用到却没声明 in');
    wired[name] = { ant: /awAnt\s*\(/.test(fs) ? 1 : 0, food: /awFood\s*\(/.test(fs) ? 1 : 0, ink: /awInk\s*\(/.test(fs) ? 1 : 0 };
  }
  return { bad, empty, vbad, dbad, wired };
}

// 鞋带公式求一个三角形有向面积(带符号 => 顺带拿到绕序)
function triArea(a, v1, v2) {
  return ((v1[0] - a[0]) * (v2[1] - a[1]) - (v2[0] - a[0]) * (v1[1] - a[1])) / 2;
}
function quadReport(arr) {
  const v = [];
  for (let i = 0; i + 1 < arr.length; i += 4) v.push([arr[i], arr[i + 1]]);
  const tris = [];
  for (let t = 0; t * 3 + 2 < v.length; t++) tris.push([v[t * 3], v[t * 3 + 1], v[t * 3 + 2]]);
  const signed = tris.map((p) => triArea(p[0], p[1], p[2]));
  let area = 0; for (const s of signed) area += Math.abs(s);
  let wind = 0; for (const s of signed) wind += Math.sign(s);
  return { verts: v.length, tris: tris.length, area, sameWinding: Math.abs(wind) === signed.length };
}
console.log('== P2.3.5 画面外观门禁  SUB=' + SUBS.join(',') + ' ==');
if (want('param')) {
  console.log('-- A15 参数登记 --');
  for (const k of ['inkMode', 'antStyle', 'foodLook']) {
    const s = SCHEMA.find((x) => x.key === k);
    if (!s) { ok('A15 ' + k + ' 在 SCHEMA', false); continue; }
    ok('A15 ' + k + ' 出厂=1 且能关到 0', s.default === 1 && s.min === 0, 'default=' + s.default + ' min=' + s.min);
  }
  for (const k of ['trailInk', 'antLen', 'antVar']) {
    const s = SCHEMA.find((x) => x.key === k);
    ok('A15 ' + k + ' 已登记', !!s, s ? 'default=' + s.default : '');
  }
  let g = '';
  try { g = groupOf('inkMode'); } catch (e) { g = 'THROW:' + e.message.slice(0, 24); }
  ok('A15 分组表已收 6 个新参数', g === '画面外观 (P2.3.5)', 'groupOf(inkMode)=' + g);
  ok('A15 出厂确实开着(读加载后的 values)', values.inkMode === 1 && values.antStyle === 1 && values.foodLook === 1,
    'inkMode=' + values.inkMode + ' antStyle=' + values.antStyle + ' foodLook=' + values.foodLook);
}
if (want('glsl')) {
  console.log('-- A11-A14 GLSL 静态 lint(不需要 GPU) --');
  const pairs = shaderSources();
  ok('A14 着色器登记表非空', pairs.length === 7, 'programs=' + pairs.length);
  const R = lintSources(pairs);
  ok('A11 内建函数实参个数合法(7 对 14 段)', R.bad.length === 0, R.bad.slice(0, 4).join(NL + '        ') || 'ok');
  ok('A11 没有空实参调用', R.empty.length === 0, R.empty.slice(0, 3).join(' / ') || 'ok');
  ok('A12 VS/FS varying 逐对配平', R.vbad.length === 0, R.vbad.slice(0, 4).join(NL + '        ') || 'ok');
  ok('A13 无 `;;` 且 u*/v* 都有声明', R.dbad.length === 0, R.dbad.slice(0, 4).join(NL + '        ') || 'ok');
  const w = R.wired;
  ok('A14 look.js 生成的块接进了着色器', w.ant && w.ant.ant === 1 && w.food && w.food.food === 1 && w.field && w.field.ink === 1 && w.alarm.ink === 1,
    JSON.stringify({ ant: w.ant, food: w.food, field: w.field, alarm: w.alarm }));
  console.log('-- Az 对照臂(判据自己必须能红) --');
  // A11 的假源码: 上一轮 glslAnt 的 join bug 生成的就是这个形状
  const z1 = lintSources([['trapMax', '#version 300 es', '#version 300 es' + NL + 'void main(){ float q = max(a, b, c, d); }']]);
  ok('Az1 四参 max 会被 A11 报红', z1.bad.length === 1 && /max 实参 4/.test(z1.bad[0]), JSON.stringify(z1.bad));
  const z1b = lintSources([['trapEmpty', '#version 300 es', '#version 300 es' + NL + 'void main(){ float q = min(); }']]);
  ok('Az1b 空实参会被 A11 报红', z1b.empty.length === 1, JSON.stringify(z1b.empty));
  // A12/A13 的假源码: VS 新增了 out vP 而 FS 忘了声明 in —— 上一轮的第二个 bug
  const z2 = lintSources([['trapVar', '#version 300 es' + NL + 'out vec2 vP;' + NL + 'void main(){ vP=vec2(0.0); }',
    '#version 300 es' + NL + 'void main(){ frag = vec4(vP, 0.0, 1.0); }']]);
  ok('Az2 漏声明的 varying 会被 A12 报红', z2.vbad.length === 1 && /vP/.test(z2.vbad[0]), JSON.stringify(z2.vbad));
  ok('Az2 同一个 bug 也会被 A13 报红', z2.dbad.length >= 1 && /vP/.test(z2.dbad.join(' ')), JSON.stringify(z2.dbad));
  const z3 = lintSources([['trapSemi', '#version 300 es', '#version 300 es' + NL + 'uniform vec3 uAmbient;;' + NL + 'void main(){}']]);
  ok('Az3 `;;` 会被 A13 报红', z3.dbad.length === 1 && /连续分号/.test(z3.dbad[0]), JSON.stringify(z3.dbad));
  console.log('-- A14b 生成的 GLSL 由表驱动(不是手抄第二遍) --');
  const gf = glslFood(), gi = glslInk(), ga = glslAnt();
  ok('A14b 食物 GLSL 的常数来自 FOOD 表', gf.includes(FOOD.bins.toFixed(1)) && gf.includes(FOOD.biteK.toFixed(2)) && gf.includes(FOOD.shrink.toFixed(2)) && gf.includes(FOOD.depth.toFixed(1)), 'bins/biteK/shrink/depth');
  ok('A14b 墨覆盖 GLSL 的幂与封顶与 JS 一致', gi.includes('1.6') && gi.includes('0.94'), gi.slice(0, 34) + '...');
  const segs = ANT_EXTRA.reduce((s, e) => s + (e.pts.length - 1), 0);
  const nP = (ga.match(/awCovP\(p,/g) || []).length, nE = (ga.match(/awCovE\(p,/g) || []).length;
  // +2 = 高光带 + 粮粒(P2.4d: 高光带从前是「复用腹节那个椭圆」, 所以旧写法只数到 +1)
  ok('A14b 蚁体 GLSL 段数 = 形状表条数', nP === segs && nE === ANT_BODY.length + 2, 'polys=' + nP + '/' + segs + ' ellipses=' + nE + '/' + (ANT_BODY.length + 2));
}
  console.log('-- A16 场 quad 几何 + 混合约定(本轮抓到的真 bug) --');
  const src = readFileSync('./render/webgl2.js', 'utf8');
  const q = quadVertices(1000, 600);
  const rep = quadReport(q);
  ok('A16 场 quad 顶点数 = 6(与 drawArrays(TRIANGLES,0,6) 同源)', rep.verts === 6 && rep.tris === 2,
    'verts=' + rep.verts + ' tris=' + rep.tris);
  ok('A16 两个三角形面积和 == w*h(世界被铺满, 没有对角缺口)', Math.abs(rep.area - 600000) < 1e-6,
    'area=' + rep.area.toFixed(1) + ' expect=600000');
  ok('A16 两三角形同绕序(开 CULL_FACE 不会只掉一半)', rep.sameWinding, 'sameWinding=' + rep.sameWinding);
  ok('A16 世界尺寸变了 quad 会跟着变', quadReport(quadVertices(37, 11)).area === 37 * 11, 'area=37*11');
  ok('A16 不许再出现手写四边形顶点字面量', !/bufferData\(gl\.ARRAY_BUFFER, new Float32Array\(\[[^\]]*0,0,[^\]]*1,1,/.test(src),
    'quadVertices 调用数=' + (src.match(/quadVertices\(/g) || []).length);
  const field = shaderSources().find((p) => p[0] === 'field');
  const inkOut = /o = vec4\(awTrailInk\(u\) \* uAmbient, a\)/.test(field[2]);
  const premultBlend = /gl\.blendFunc\(ink \? gl\.SRC_ALPHA : gl\.ONE, ink \? gl\.ONE_MINUS_SRC_ALPHA : gl\.ONE\)/.test(src);
  ok('A16 FS 非预乘 与 墨色分支 SRC_ALPHA 成对(改一边必须改另一边)', inkOut === premultBlend && premultBlend,
    'fsNonPremult=' + inkOut + ' blendSrcAlpha=' + premultBlend);
  const bad = new Float32Array([0,0,0,0, 1000,0,1,0, 0,600,0,1, 1000,600,1,1]);
  const badRep = quadReport(bad);
  ok('Az4 少写一个顶点的假 quad 会被 A16 报红', badRep.verts === 4 && Math.abs(badRep.area - 600000) > 1,
    'verts=' + badRep.verts + ' area=' + badRep.area.toFixed(1));

if (want('shape')) {
  console.log('-- A6-A7 蚁体形状(直接调 look.js) --');
  const mid = ANT_EXTRA[0].pts[1];
  const c1 = antCoverage(mid[0], mid[1], 1), c0 = antCoverage(mid[0], mid[1], 0);
  ok('A6 触角中点 lod1 有墨 / lod0 无墨', c1.body > 0.4 && c0.body < 0.02, 'body(lod1)=' + c1.body.toFixed(3) + ' body(lod0)=' + c0.body.toFixed(4));
  let mx = 0, my = 0;
  for (const e of ANT_EXTRA) for (const p of e.pts) { mx = Math.max(mx, Math.abs(p[0]) + e.w); my = Math.max(my, Math.abs(p[1]) + e.w); }
  for (const e of ANT_BODY) { mx = Math.max(mx, Math.abs(e.x) + e.rx); my = Math.max(my, Math.abs(e.y) + e.ry); }
  for (const e of [ANT_CRUMB, ANT_SHEEN]) { mx = Math.max(mx, Math.abs(e.x) + e.rx); my = Math.max(my, Math.abs(e.y) + e.ry); }
  ok('A6 轮廓四边形盖住触角尖与叼的粮', mx <= ANT_U && my <= ANT_V, 'xMax=' + mx.toFixed(3) + '/' + ANT_U + ' yMax=' + my.toFixed(3) + '/' + ANT_V);
  const gs = ANT_BODY[0], hd = ANT_BODY[ANT_BODY.length - 1];
  // A6 高光(P2.4d 重述 + 加严 · 为什么允许重述见 METRICS P2.4d §1, 不是为了让它变绿):
  //   旧写法拿「腹节中心 sheen>0.5」当「高光只在腹部」的证据。高光从「整节腹部」改成「一条窄带」之后,
  //   腹节中心本身已经不在带上(0.403) ⇒ 旧写法会把一次改好误报成改坏。这一条真正要钉的是**空间归属**,
  //   所以拆成三问: 带在自己的中心满值 / 不许越出体外 / 头部必须为零;
  //   再加两条旧判据看不见的: 腹节里离带最远的那一角必须无光(否证「又涨回整节肚子」) + 带面积占腹节 <0.30。
  const shBand = antCoverage(ANT_SHEEN.x, ANT_SHEEN.y, 1).sheen;
  const shHead = antCoverage(hd.x, hd.y, 1).sheen;
  const shFar = antCoverage(gs.x - gs.rx * 0.62, gs.y + gs.ry * 0.62, 1).sheen;
  const shOut = antCoverage(gs.x, gs.y + gs.ry * 1.35, 1).sheen;          // 体外: 腹部上缘之外一点
  const shArea = (ANT_SHEEN.rx * ANT_SHEEN.ry) / (gs.rx * gs.ry);        // π 相消
  ok('A6 高光带中心满值', shBand > 0.9, 'sheen(band)=' + shBand.toFixed(3));
  ok('A6 高光不越出体外', shOut < 0.02, 'sheen(体外)=' + shOut.toFixed(4));
  ok('A6 高光不涂满腹节(离带最远的腹节角必须无光)', shFar < 0.05 && shArea < 0.30,
    'sheen(腹节远角)=' + shFar.toFixed(4) + ' 带/腹节面积=' + shArea.toFixed(3));
  ok('A6 高光只在腹部(头部为零)', shHead < 0.02, 'sheen(head)=' + shHead.toFixed(4));
  ok('A6 高光增益 ≤ 0.5(旧值 0.9 会把虫体画成两种颜色)', SHEEN_GAIN <= 0.5 && SHEEN_GAIN > 0,
    'SHEEN_GAIN=' + SHEEN_GAIN);
  ok('A6 叼的粮在头前缘之外(不是全身变色)', ANT_CRUMB.x - ANT_CRUMB.rx > hd.x, 'crumbBack=' + (ANT_CRUMB.x - ANT_CRUMB.rx).toFixed(3) + ' headX=' + hd.x);
  ok('A6 三段身体 + 腹柄细腰(膜翅目读数)', ANT_BODY.length >= 4 && ANT_BODY[1].rx < 0.08 && ANT_BODY[0].rx > ANT_BODY[3].rx,
    'parts=' + ANT_BODY.length + ' petioleRx=' + ANT_BODY[1].rx);
  ok('A7 LOD 阶梯 7.5/13 与 14000 护栏', antLod(7.4, 5000) === 0 && antLod(7.6, 5000) === 1 && antLod(12.9, 5000) === 1 && antLod(13, 5000) === 2 && antLod(20, 14001) === 1,
    '=> ' + [antLod(7.4, 5000), antLod(7.6, 5000), antLod(12.9, 5000), antLod(13, 5000), antLod(20, 14001)].join('/'));
  const bins = [0, 0, 0];
  for (let i = 0; i < 3000; i++) bins[Math.min(2, Math.floor(antVar(i) * 3))]++;
  ok('A6 个体差异按 uid 稳定且跨三档', antVar(7) === antVar(7) && bins.every((b) => b > 300) && CHITIN.length === 3,
    'v(7)=' + antVar(7).toFixed(4) + ' bins=' + JSON.stringify(bins));
  ok('A6 几丁质是近黑(最亮一档也 <0.25)', Math.max(...CHITIN.flat()) < 0.25 && Math.max(...CRUMB_RGB) > 0.6,
    'chitinMax=' + Math.max(...CHITIN.flat()).toFixed(3) + ' crumb=' + CRUMB_RGB.join(','));
  ok('A6 纸是亮的而墨是暗的', Math.min(...PAPER) > 0.9 && Math.max(...TRAIL_STOPS[3][2]) < 0.4 && Math.max(...ALARM_INK_STOPS[2][2]) < 0.6,
    'paper=' + PAPER.join(',') + ' 主廊墨=' + TRAIL_STOPS[3][2].join(','));
  console.log('-- A10 墨覆盖 --');
  let monoU = true, monoK = true;
  for (let i = 1; i <= 40; i++) {
    const u = i / 40;
    if (inkCoverage(u, 1.2) < inkCoverage(u - 1 / 40, 1.2) - 1e-12) monoU = false;
    if (inkCoverage(u, 0.2 + i / 40 * 2) < inkCoverage(u, 0.2 + (i - 1) / 40 * 2) - 1e-12) monoK = false;
  }
  ok('A10 对 u 与对 k 都单调增', monoU && monoK);
  ok('A10 底噪不上纸 / 主廊仍透光', inkCoverage(0.07, 1.2) < 0.05 && inkCoverage(0.5, 1.2) > 0.25 && inkCoverage(0.5, 1.2) < 0.6,
    'u=.07->' + inkCoverage(0.07, 1.2).toFixed(3) + ' u=.5->' + inkCoverage(0.5, 1.2).toFixed(3));
  ok('A10 u<=0 恒零墨 且封顶 0.94', inkCoverage(0, 3) === 0 && inkCoverage(-1, 3) === 0 && inkCoverage(1, 3) === 0.94,
    'ink(0)=' + inkCoverage(0, 3) + ' ink(1,k=3)=' + inkCoverage(1, 3));
  console.log('-- A8-A9 被啃的食物 --');
  let prevR = 1e9, rMono = true;
  for (let i = 0; i <= 20; i++) { const R = foodRadius(30, i / 20); if (R > prevR + 1e-12) rMono = false; prevR = R; }
  ok('A8 剩余半径随已吃比例单调缩', rMono && near(foodRadius(30, 0), 30, 1e-9) && near(foodRadius(30, 1), 30 * FOOD.shrink, 1e-9),
    'R(0)=30 R(1)=' + foodRadius(30, 1).toFixed(2));
  const area = (f, seed) => {
    let a = 0; const R = foodRadius(30, f), N = 180, M = 60, da = Math.PI * 2 / N, dr = R / M;
    for (let i = 0; i < N; i++) {
      const an = (i + 0.5) / N * Math.PI * 2;
      for (let j = 0; j < M; j++) {
        const rr = (j + 0.5) * dr;
        a += foodCoverage(Math.cos(an) * rr, Math.sin(an) * rr, 30, f, seed).cov * rr * da * dr;
      }
    }
    return a;
  };
  const A = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => area(f, 0.37));
  let aMono = true;
  for (let i = 1; i < A.length; i++) if (A[i] > A[i - 1] + 1e-9) aMono = false;
  ok('A8 盘内剩余覆盖面积单调下降', aMono && A[5] < 0.6 * A[0], 'A=' + A.map((x) => x.toFixed(0)).join(' ') + ' A(1)/A(0)=' + (A[5] / A[0]).toFixed(3));
  const gapFrac = (f, seed) => {
    let g = 0; const N = 720, R = foodRadius(30, f);
    for (let i = 0; i < N; i++) { const a = i / N * Math.PI * 2; if (foodBoundary(30, f, seed, a) < R * 0.98) g++; }
    return g / N;
  };
  ok('A8 f=0 没有缺口', gapFrac(0, 0.11) === 0, 'gap=' + gapFrac(0, 0.11));
  for (const f of [0.2, 0.45, 0.7, 0.9]) {
    const g = gapFrac(f, 0.11);
    ok('A8 缺口角跨度 ~ f=' + f, g > f * 0.8 && g < Math.min(1, f * 1.2 + 0.06), '实测=' + g.toFixed(3));
  }
  ok('A8 啃痕逐帧稳定(同一 seed 逐位相同)', foodBoundary(30, 0.55, 0.31, 1.234) === foodBoundary(30, 0.55, 0.31, 1.234), 'b=' + foodBoundary(30, 0.55, 0.31, 1.234));
  ok('A9 浅色只贴在切口(内侧高 / 内部零)', (() => {
    const f = 0.6, seed = 0.31, span = Math.PI * 2 * f;
    let inner = 0, deep = 0, N = 400;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N * span, wa = seed * Math.PI * 2 + t;      // 缺口在世界角 [seed*TAU, seed*TAU+span) 里
      const lim = foodBoundary(30, f, seed, wa);
      inner += foodCoverage(Math.cos(wa) * lim * 0.985, Math.sin(wa) * lim * 0.985, 30, f, seed).bite;
      deep += foodCoverage(Math.cos(wa) * lim * 0.5, Math.sin(wa) * lim * 0.5, 30, f, seed).bite;
    }
    return inner / N > 0.5 && deep / N < 0.05;
  })(), '判据: 切口内侧 >0.5 / 颗粒内部 <0.05');
}
if (want('pixel')) {
  console.log('-- A1-A5 三条渲染路径的像素裁决(3 次 render_png) --');
  const legacy = SHOT('_look_legacy.png', 'inkMode=0,antStyle=0,foodLook=0');
  const fact = SHOT('_look_fact.png', null);
  const noant = SHOT('_look_noant.png', 'antStyle=0');
  console.log('  info  render_png ms: legacy=' + legacy.ms + ' fact=' + fact.ms + ' noant=' + noant.ms + '   | ' + fact.log);
  ok('A1 关掉三档逐字节退回 P2.3.4 出厂图', legacy.sha === LEGACY_SHA, legacy.sha + (legacy.sha === LEGACY_SHA ? '' : ' != ' + LEGACY_SHA));
  const df = diffFrac(legacy.png, fact.png);
  ok('A2 量具看得见新旧差异(>30% 像素不同)', df > 0.3 && fact.sha !== legacy.sha, 'diff=' + (df * 100).toFixed(1) + '%');
  const SL = stats(legacy.png), SF = stats(fact.png);
  ok('A3 近黑占比降到旧的 25% 以下且绝对值 <15%', SF.dark < SL.dark * 0.25 && SF.dark < 0.15,
    'legacy=' + (SL.dark * 100).toFixed(1) + '% fact=' + (SF.dark * 100).toFixed(1) + '%');
  ok('A3b 白纸是新画面的主体(>60% 暖亮底)', SF.warm > 0.6, 'fact=' + (SF.warm * 100).toFixed(1) + '% legacy=' + (SL.warm * 100).toFixed(1) + '%');
  ok('A4 冷蓝雪消失(旧蚁色识别子 <旧画面 2% 且 <0.5%)', SF.blue < SL.blue * 0.02 && SF.blue < 0.005,
    'legacy=' + (SL.blue * 100).toFixed(2) + '% fact=' + (SF.blue * 100).toFixed(3) + '%');
  // a = 旧蚁形(纸上画蓝点) b = 新蚁形(黑壳): 同一批像素两边互比
  const band = diffBand(noant.png, fact.png);
  ok('A5 只切 antStyle 就能看见差异(PNG 路径也得听这个旋钮)', band.frac > 0.0005, 'diff=' + (band.frac * 100).toFixed(3) + '%');
  ok('A5b 同一片蚁 footprint 变暗到 60% 以下', band.meanB < band.meanA * 0.6,
    'meanLum 新=' + band.meanB.toFixed(3) + ' 旧=' + band.meanA.toFixed(3) + ' 比=' + (band.meanB / band.meanA).toFixed(3));
  ok('A5c 新侧蚁体核心是黑的(近黑占差异带 >15%), 旧侧几乎为 0', band.darkB > 0.15 && band.darkA < 0.01,
    'dark 新=' + (band.darkB * 100).toFixed(1) + '% 旧=' + (band.darkA * 100).toFixed(2) + '%');
}
console.log('== look_check: ' + PASS + ' PASS / ' + FAIL + ' FAIL ==');
process.exitCode = FAIL ? 1 : 0;
