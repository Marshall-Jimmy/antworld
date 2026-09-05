// WebGL2 渲染后端。
// - 信息素场 → R32F 纹理，全屏/世界四边形上用色阶映射发光（图片的主角）
// - 蚂蚁 → instanced 定向四边形，单个 draw call（20000 只无压力）。
//   形体两套：antStyle=0 是旧的拉长 comet 光点，antStyle=1 是黑壳工蚁(三段+细腰+触角)，表在 render/look.js
// - 食物 → foodLook=0 软光斑点 / foodLook=1 会被啃出缺口的种子(同源 render/look.js)
// - 巢 → 圆盘 + 环形描边
// - 坐标约定：世界 y 向下（与 app.js 点击换算/检视层/Canvas2D 兜底一致）。
//   旧版 uView 的 sy 为正导致画面整体垂直镜像（点击/检视与显示对不上），已修正。

import { Backend } from './backend.js';
import { get, values, SCHEMA } from '../core/config.js';
import { glslRamp, glslTone, FIELD_STOPS, ALARM_STOPS } from './palette.js';
import { PAPER, TRAIL_STOPS, ALARM_INK_STOPS, ANT_U, ANT_V, glslAnt, glslChitin, glslInk, glslInkRamp, glslFood, glslHash1, antLod, antVar } from './look.js';
import { effPeak } from './exposure.js';

const VS_FIELD = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform mat3 uView;
out vec2 vUv;
void main(){ vUv=aUv; vec3 p=uView*vec3(aPos,1.0); gl_Position=vec4(p.xy,0.0,1.0); }`;

// 色阶曲线与 stop 表由 render/palette.js 生成成 GLSL —— 三条渲染路径不可能再各写一套常数。
// uTone=1 走新的软压缩有界色阶(光污染治理), uTone=0 保留下面这段旧硬钳制原码, 旧截图逐位可复现。
// ---- 场/报警场共用的世界四边形 ----
// 为什么单独抽出来并且导出: 这里曾经手写 4 个顶点(pos2+uv2 = 16 floats), 而两处 draw 都按
// drawArrays(TRIANGLES, 0, 6) 画 6 个 —— 第 5、6 个顶点读出缓冲区末尾之外(全 0, 与 v0 重合),
// 于是第二个三角形退化成一个点, **世界只有左上那一半真正被画上信息素层**, 右下那一半露的是 clearColor。
// 加光时代看不出来(缺的那半露出近黑 clear, 而场光在 v=0 处也是近黑); 换成白纸墨色之后一半纯白一半米
// 直接现形。所以判据不放在「看起来对不对」上, 而是 quadVertices 导出 + look_check A16 在 node 里
// 用鞋带公式核两个三角形的面积和 == w*h —— 没有 GPU 也能钉死这类「顶点数/绘制数不同源」的错。
// 绕序: 两个三角形同为 CCW(世界系), 与 cornerVBO/rainVBO 一致, 将来开 CULL_FACE 不会只掉一半。
export function quadVertices(w, h) {
  return new Float32Array([
    0, 0, 0, 0,   w, 0, 1, 0,   0, h, 0, 1,
    w, 0, 1, 0,   w, h, 1, 1,   0, h, 0, 1,
  ]);
}

const FS_FIELD = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
uniform float uPeak;
uniform float uTone;
uniform float uInk; uniform float uInkK;
uniform vec3 uAmbient;
out vec4 o;
${glslTone()}
${glslInk()}
${glslRamp('awFieldRamp', FIELD_STOPS)}
${glslInkRamp('awTrailInk', TRAIL_STOPS)}
void main(){
  float v = max(0.0, texture(uField, vUv).r);
  if (uInk > 0.5) {
    float u = awTone(v / uPeak);
    float a = awInk(u, uInkK);
    o = vec4(awTrailInk(u) * uAmbient, a);   // 非预乘: 纸上的一层染色, a=0 处纸不动
    return;
  }
  if (uTone > 0.5) { o = vec4(awFieldRamp(awTone(v / uPeak)), 1.0); o.rgb *= uAmbient; return; }
  float t = clamp(v / uPeak, 0.0, 1.0);
  float e = t*t*(3.0-2.0*t);            // smoothstep
  vec3 deep = vec3(0.012,0.030,0.095);  // 近黑蓝
  vec3 mid  = vec3(0.10,0.34,0.80);     // 电蓝
  vec3 warm = vec3(0.30,0.72,1.10);     // 亮青
  vec3 core = vec3(1.00,0.84,0.42);     // 金核
  vec3 col = mix(deep, mid, smoothstep(0.0,0.42,t));
  col = mix(col, warm, smoothstep(0.30,0.80,t));
  col += core * e*e * 1.6;
  o = vec4(col*e, 1.0);
  o.rgb *= uAmbient;
}`;

const FS_ALARM = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
uniform float uPeak;
uniform float uTone;
uniform float uInk; uniform float uInkK;
uniform vec3 uAmbient;
out vec4 o;
${glslTone()}
${glslInk()}
${glslRamp('awAlarmRamp', ALARM_STOPS)}
${glslInkRamp('awAlarmInk', ALARM_INK_STOPS)}
void main(){
  float v = max(0.0, texture(uField, vUv).r);
  if (uInk > 0.5) {
    float u = awTone(v / uPeak);
    o = vec4(awAlarmInk(u) * uAmbient, awInk(u, uInkK));   // 报警红叠在走廊墨之上
    return;
  }
  if (uTone > 0.5) { o = vec4(awAlarmRamp(awTone(v / uPeak)), 1.0); o.rgb *= uAmbient; return; }
  float t = clamp(v / uPeak, 0.0, 1.0);
  float e = t*t*(3.0-2.0*t);            // smoothstep
  o = vec4(vec3(1.0,0.22,0.10) * e * 0.9, 1.0);   // 危险红, 叠加在场光之上
  o.rgb *= uAmbient;
}`;

// 蚂蚁:instanced 定向四边形。aCorner 是单位四角(x 向前),实例流 = 位置/朝向/负载。
// 形体在 VS 中按朝向旋转、按负载放大(负重蚂蚁更大),FS 画长椭球 + 头亮尾暗 comet。
const VS_ANT = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aPos;
layout(location=2) in float aTheta;
layout(location=3) in float aLoad;
layout(location=4) in float aVar;
uniform mat3 uView; uniform float uScale; uniform float uLen; uniform float uStyle; uniform float uVar;
out vec2 vC; out vec2 vP; out float vLoad; out float vVar;
void main(){
  float cs = cos(aTheta), sn = sin(aTheta);
  vec2 local;
  vC = aCorner; vLoad = aLoad; vVar = aVar;
  if (uStyle < 0.5) {
    // 旧风格: 半宽 uScale 的拉长 comet(头尾 1.7x)。表达式与旧版逐字相同 ⇒ antStyle=0 画面可退回。
    float sz = uScale * (1.0 + 0.9*aLoad);
    local = vec2(aCorner.x * sz * 1.7, aCorner.y * sz);
    vP = aCorner;
  } else {
    // 新风格: uLen = 一只蚁的体长(世界单位) = antLen 屏幕像素 / 当前缩放。ANT_U/ANT_V 来自
    // render/look.js 的轮廓框(体长=1 的蚁单位), 触角尖与腿尖都在框内。
    float bl = uLen * (1.0 + (aVar - 0.5) * 0.24 * uVar);
    vP = vec2(aCorner.x * 2.0 * ${ANT_U}, aCorner.y * 2.0 * ${ANT_V});
    local = vP * bl;
  }
  vec2 world = aPos + vec2(local.x*cs - local.y*sn, local.x*sn + local.y*cs);
  gl_Position = vec4((uView*vec3(world,1.0)).xy, 0.0, 1.0);
}`;

const FS_ANT = `#version 300 es
precision highp float;
in vec2 vC; in vec2 vP; in float vLoad; in float vVar;
uniform float uTone;
uniform vec3 uAmbient;
out vec4 o;
uniform float uStyle; uniform float uLod;
${glslAnt()}
${glslChitin()}
void main(){
  if (uStyle > 0.5) {
    float body, crumb, sheen;
    awAnt(vP, uLod, body, crumb, sheen);
    float ca = (vLoad > 0.3 ? 1.0 : 0.0) * clamp(crumb, 0.0, 1.0);
    float ba = clamp(body, 0.0, 1.0) * 0.96;
    float alpha = max(ba, ca);
    if (alpha <= 0.004) discard;
    // 三档几丁质按 uid 哈希分桶(与 JS 路径的 floor(v*3) 同一分界) + 腹部一点高光
    vec3 ch = mix(awChitin[0], awChitin[1], step(0.3333333, vVar));
    ch = mix(ch, awChitin[2], step(0.6666667, vVar));
    vec3 rgb = mix(ch + awChitin[1] * 0.9 * clamp(sheen, 0.0, 1.0), awCrumb, ca);
    o = vec4(rgb * uAmbient, alpha);
    return;
  }
  vec3 empty = vec3(0.35,0.65,1.00);   // 空手:冷静蓝
  vec3 loaded= vec3(1.00,0.85,0.35);   // 负重:暖金
  vec3 col = mix(empty, loaded, vLoad);
  // 长椭球体(vC.x∈[-0.5,0.5] 对应实际 ±0.85 半长)
  float r = length(vec2(vC.x/0.85, vC.y/0.5));
  float body = 1.0 - smoothstep(0.70, 1.0, r);
  float comet = clamp(exp(vC.x*3.2), 0.0, 1.0);            // 前亮后暗
  float tail = clamp(exp(vC.x*1.1)*0.45, 0.0, 1.0) * smoothstep(-0.5,-0.05,vC.x);
  float a = clamp(body*(0.30+0.70*comet+tail), 0.0, 1.0);
  // 蚂蚁是**不透明的身体**, 不是灯: 新色阶下走普通 alpha 混合, 蚁群盖住走廊的光而不是往上加。
  // (旧版 additive 让 5000 只蚁叠成一层蓝雾, 是光污染的另一半; Canvas2D/PNG 路径本来就是 alpha)
  if (uTone > 0.5) { o = vec4(col * uAmbient, a); return; }
  o = vec4(col*a*uAmbient, 1.0);
}`;

const VS_FOOD = `#version 300 es
in vec2 aPos; in float aRadius; in float aAmount; in float aRaw; in float aA0; in float aSeed;
uniform mat3 uView; uniform float uZoom;
out float vAmt; out float vR; out float vEat; out float vSeed;
void main(){
  vAmt = aAmount; vR = aRadius; vSeed = aSeed;
  // 已吃掉的比例 = 1 − 现量/出生量(a0 由 world.addFood 记下, sim 一个字节都不读它)
  vEat = aA0 > 0.0 ? clamp(1.0 - aRaw / aA0, 0.0, 1.0) : 0.0;
  vec3 p = uView*vec3(aPos,1.0);
  gl_Position = vec4(p.xy,0.0,1.0);
  gl_PointSize = max(3.0, aRadius*2.0*uZoom);
}`;

const FS_FOOD = `#version 300 es
precision highp float;
in float vAmt; in float vR; in float vEat; in float vSeed;
uniform vec3 uAmbient;
uniform float uLook;
out vec4 o;
${glslHash1()}
${glslFood()}
${glslChitin()}
void main(){
  if (uLook > 0.5) {
    // 一粒种子: 随取食整体缩小 + 沿一个扇形被啃开(缺口角度 ∝ 已吃掉的比例),
    // 新啃口露浅色内瓤, 外壳由中心受光到边缘变暗。几何与 JS 路径同源: look.js 的 awFood。
    vec2 d = (gl_PointCoord - 0.5) * 2.0 * vR;
    float cov, bite;
    awFood(d, vR, vEat, vSeed, cov, bite);
    if (cov <= 0.004) discard;
    float t = bite > 0.12 ? 0.0 : 0.30 + 0.70*min(1.0, length(d)/max(awFoodR(vR, vEat), 1e-6));
    o = vec4(mix(awFlesh, awHull, t) * uAmbient, cov);
    return;
  }
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.04, d);
  float amt = clamp(vAmt, 0.0, 1.0);
  vec3 col = vec3(0.30, 1.00, 0.45)*amt;
  o = vec4(col*a, 1.0);
  o.rgb *= uAmbient;
}`;

// 墙(P2.1): 每墙格一个实心方块点。不透明板岩色, 普通混合盖在场上(不参与发光叠加)。
const VS_WALL = `#version 300 es
in vec2 aPos;
uniform mat3 uView; uniform float uSize;
void main(){
  vec3 p = uView*vec3(aPos,1.0);
  gl_Position = vec4(p.xy,0.0,1.0);
  gl_PointSize = max(2.0, uSize);
}`;

const FS_WALL = `#version 300 es
precision highp float;
uniform vec3 uAmbient;
uniform float uInk;
out vec4 o;
void main(){
  // 方块点内轻微中心亮边缘暗, 让整面墙有一点厚度感
  vec2 d = abs(gl_PointCoord - 0.5);
  float edge = smoothstep(0.5, 0.34, max(d.x, d.y));
  // 纸上墙是炭黑的实体(旧黑底上是板岩蓝: 那张图里墙本来就该比背景亮)
  vec3 c = uInk > 0.5 ? mix(vec3(0.075,0.070,0.068), vec3(0.20,0.185,0.170), edge)
                      : mix(vec3(0.13,0.15,0.19), vec3(0.30,0.34,0.42), edge);
  o = vec4(c, 1.0);
  o.rgb *= uAmbient;
}`;

const VS_CIRCLE = `#version 300 es
in vec2 aPos;
uniform mat3 uView; uniform vec2 uCenter; uniform float uRadius;
void main(){
  vec2 wp = uCenter + aPos*uRadius;
  vec3 p = uView*vec3(wp,1.0);
  gl_Position = vec4(p.xy,0.0,1.0);
}`;

const FS_CIRCLE = `#version 300 es
precision highp float;
uniform vec4 uColor;
uniform vec3 uAmbient;
out vec4 o;
void main(){ o = vec4(uColor.rgb*uAmbient, uColor.a); }`;

// 雨丝(P2.3): 屏幕空间全屏四边形。雨在天上, 不贴世界坐标, 所以不进 uView。
const VS_RAIN = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vN;
void main(){ vN = aPos*0.5+0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_RAIN = `#version 300 es
precision highp float;
in vec2 vN;                  // 0..1 屏幕坐标, y 向上
uniform vec2 uRes;           // 设备像素
uniform float uTime;         // 逻辑秒: 与 sim 同步, 加速时雨也落得更快
uniform float uRain;         // 0..1 雨强
uniform float uWind;         // 带符号切变量: 雨丝往哪边斜、斜多少
uniform vec3 uAmbient;       // 雨丝是散射高光, 亮度跟环境光走
uniform float uInk;          // 纸上雨是灰蓝暗条, 不是黑底上的亮丝
out vec4 o;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 一层视差雨: 在按风切斜、向下滚动的格网里, 每格至多一根丝(约四成格子空着)
float layer(vec2 uv, float cell, float speed, float thick, float seed){
  vec2 g = vec2(uv.x*uRes.x + uv.y*uRes.y*uWind, uv.y*uRes.y + uTime*speed) / cell;
  vec2 id = floor(g), f = fract(g);
  float h = hash21(id + seed);
  if (h > 0.6) return 0.0;
  float lane = 0.10 + 0.80*fract(h*37.1);      // 丝在格内的横向位置
  float y0 = 0.02 + 0.34*fract(h*11.7);        // 亮端(雨滴头)在格内的起始高度
  float len = 0.34 + 0.62*fract(h*23.3);       // 拖尾长度
  if (y0 + len > 1.0) len = 1.0 - y0;          // 不跨格: 否则断口会排成可见的网格线
  float across = smoothstep(thick, 0.0, abs(f.x - lane));
  float along = (1.0 - smoothstep(y0, y0 + len, f.y)) * smoothstep(y0 - 0.02, y0 + 0.10, f.y);
  return across * along;
}

void main(){
  if (uRain <= 0.002) { o = vec4(0.0); return; }
  float lum = dot(uAmbient, vec3(0.3333));
  float a = uRain * (layer(vN, 70.0, 980.0, 0.050, 1.7) * 0.80
                   + layer(vN, 46.0, 700.0, 0.040, 5.3) * 0.55
                   + layer(vN, 28.0, 470.0, 0.050, 9.1) * 0.30);
  if (uInk > 0.5) { o = vec4(vec3(0.30, 0.38, 0.50) * uAmbient, min(1.0, a) * 0.55); return; }
  o = vec4(vec3(0.62, 0.74, 0.95) * lum * a, 1.0);
}`;
// 编译失败必须说得出是**哪一段**(P2.3.5 事故): 旧写法只报 'shader: ERROR 0:16', 而 14 段源码里 7 段
// 都在 16 行附近出错 —— 定位一次靠的是手工搭一个探针页 + 逐个猜。名字是免费的, 别再省。
function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader ' + name + ': ' + gl.getShaderInfoLog(s));
  }
  return s;
}
function program(gl, vs, fs, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + '/vs'));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + '/fs'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link ' + name + ': ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// 着色器源码登记表(P2.3.5): 唯一目的是让 look_check.mjs 能在**没有 GPU 的 node 里**静态 lint
// 这 14 段源码。上一轮两个编译错误(四参 max / FS 漏声明 varying)都是**运行时**才炸, 而炸了之后
// 的画面看起来完全正常(静默兜底 Canvas2D) —— 只靠浏览器实测抓这一类 bug, 成本是一整个阶段。
export function shaderSources() {
  return [
    ['field', VS_FIELD, FS_FIELD],
    ['alarm', VS_FIELD, FS_ALARM],
    ['ant', VS_ANT, FS_ANT],
    ['food', VS_FOOD, FS_FOOD],
    ['wall', VS_WALL, FS_WALL],
    ['circle', VS_CIRCLE, FS_CIRCLE],
    ['rain', VS_RAIN, FS_RAIN],
  ];
}

export class WebGL2Backend extends Backend {
  constructor() {
    super();
    this.ctx = null;
    this.uView = new Float32Array(9);
    this.antBuf = null;
    this.antCount = 0;
    this.fieldTex = null;
    this.fieldDims = [0, 0];
    this.linearOK = false;
    this.amb = new Float32Array([1, 1, 1]);   // 环境光(P2.3): 恒等 = 1,1,1 = 旧画面
    this.failReason = 'init() 未调用';       // 兜底原因(P2.3.5 事故): 必须能被 HUD 说出来
    this.dpr = 1;
  }

  init(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    if (!gl) { this.failReason = 'getContext(webgl2)=null'; return false; }
    this.failReason = '';
    this.ctx = gl;
    this.canvas = canvas;
    this.linearOK = !!gl.getExtension('OES_texture_float_linear');

    // 四边形顶点:世界 (0,0)-(w,h), uv 对应
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices(get('worldW'), get('worldH')), gl.STATIC_DRAW);

    this.pField = program(gl, VS_FIELD, FS_FIELD, 'field');
    this.pAlarm = program(gl, VS_FIELD, FS_ALARM, 'alarm');
    this.pAnt = program(gl, VS_ANT, FS_ANT, 'ant');
    this.pFood = program(gl, VS_FOOD, FS_FOOD, 'food');
    this.pWall = program(gl, VS_WALL, FS_WALL, 'wall');
    this.pCircle = program(gl, VS_CIRCLE, FS_CIRCLE, 'circle');
    this.pRain = program(gl, VS_RAIN, FS_RAIN, 'rain');

    // ---- location 缓存（每帧查询 getUniformLocation/getAttribLocation 有开销） ----
    this.locView = new Map([
      [this.pField, gl.getUniformLocation(this.pField, 'uView')],
      [this.pAlarm, gl.getUniformLocation(this.pAlarm, 'uView')],
      [this.pAnt, gl.getUniformLocation(this.pAnt, 'uView')],
      [this.pFood, gl.getUniformLocation(this.pFood, 'uView')],
      [this.pWall, gl.getUniformLocation(this.pWall, 'uView')],
      [this.pCircle, gl.getUniformLocation(this.pCircle, 'uView')],
    ]);
    // 环境光(P2.3): 六个场景程序各自缓存 uAmbient(雨丝程序不经 _use, 单独取)
    this.locAmbient = new Map([
      [this.pField, gl.getUniformLocation(this.pField, 'uAmbient')],
      [this.pAlarm, gl.getUniformLocation(this.pAlarm, 'uAmbient')],
      [this.pAnt, gl.getUniformLocation(this.pAnt, 'uAmbient')],
      [this.pFood, gl.getUniformLocation(this.pFood, 'uAmbient')],
      [this.pWall, gl.getUniformLocation(this.pWall, 'uAmbient')],
      [this.pCircle, gl.getUniformLocation(this.pCircle, 'uAmbient')],
    ]);
    // 色阶模式(P2.3.1): 只有场/报警/蚂蚁三个程序有 uTone
    this.locTone = new Map([
      [this.pField, gl.getUniformLocation(this.pField, 'uTone')],
      [this.pAlarm, gl.getUniformLocation(this.pAlarm, 'uTone')],
      [this.pAnt, gl.getUniformLocation(this.pAnt, 'uTone')],
    ]);
    this.loc = {
      peak: gl.getUniformLocation(this.pField, 'uPeak'),
      alarmPeak: gl.getUniformLocation(this.pAlarm, 'uPeak'),
      antScale: gl.getUniformLocation(this.pAnt, 'uScale'),
      foodZoom: gl.getUniformLocation(this.pFood, 'uZoom'),
      wallSize: gl.getUniformLocation(this.pWall, 'uSize'),
      center: gl.getUniformLocation(this.pCircle, 'uCenter'),
      radius: gl.getUniformLocation(this.pCircle, 'uRadius'),
      color: gl.getUniformLocation(this.pCircle, 'uColor'),
      rainRes: gl.getUniformLocation(this.pRain, 'uRes'),
      rainTime: gl.getUniformLocation(this.pRain, 'uTime'),
      rainAmt: gl.getUniformLocation(this.pRain, 'uRain'),
      rainWind: gl.getUniformLocation(this.pRain, 'uWind'),
      rainAmb: gl.getUniformLocation(this.pRain, 'uAmbient'),
      // P2.3.5 画面外观: 每一层一个开关, 关掉就回到旧原码
      fieldInk: gl.getUniformLocation(this.pField, 'uInk'),
      fieldInkK: gl.getUniformLocation(this.pField, 'uInkK'),
      alarmInk: gl.getUniformLocation(this.pAlarm, 'uInk'),
      alarmInkK: gl.getUniformLocation(this.pAlarm, 'uInkK'),
      wallInk: gl.getUniformLocation(this.pWall, 'uInk'),
      rainInk: gl.getUniformLocation(this.pRain, 'uInk'),
      foodLook: gl.getUniformLocation(this.pFood, 'uLook'),
      antLen: gl.getUniformLocation(this.pAnt, 'uLen'),
      antStyle: gl.getUniformLocation(this.pAnt, 'uStyle'),
      antVar: gl.getUniformLocation(this.pAnt, 'uVar'),
      antLod: gl.getUniformLocation(this.pAnt, 'uLod'),
    };

    // quad 使用的世界尺寸记录——面板改 worldW/H 后需要重建（否则场被拉伸到旧范围）
    this.quadW = get('worldW');
    this.quadH = get('worldH');

    // 蚂蚁 interleaved 实例流缓冲
    this.antVBO = gl.createBuffer();

    // 食物 instanced 点
    this.foodVBO = gl.createBuffer();
    this.foodCount = 0;

    // 墙(P2.1): 静态几何, 只在 wallVersion 变化时重建顶点
    this.wallVBO = gl.createBuffer();
    this.wallData = null;
    this.wallVersionDrawn = -1;
    this.wallCountDrawn = 0;

    // 单位圆(用于巢 & 可复用)
    const N = 72, fan = new Float32Array((N + 1) * 2), loop = new Float32Array(N * 2);
    fan[0] = fan[1] = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a), y = Math.sin(a);
      loop[i * 2] = x; loop[i * 2 + 1] = y;
      fan[(i + 1) * 2] = x; fan[(i + 1) * 2 + 1] = y;
    }
    this.aFan = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aFan);
    gl.bufferData(gl.ARRAY_BUFFER, fan, gl.STATIC_DRAW);
    this.aLoop = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aLoop);
    gl.bufferData(gl.ARRAY_BUFFER, loop, gl.STATIC_DRAW);

    // 蚂蚁角点(两个三角形,单位四角)
    this.cornerVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5,-0.5,  0.5,-0.5,  0.5, 0.5,
      -0.5,-0.5,  0.5, 0.5, -0.5, 0.5,
    ]), gl.STATIC_DRAW);

    // ---- VAO:把顶点布局钉死,每帧只 bindVertexArray + draw ----
    // 场 quad
    this.vaoField = gl.createVertexArray();
    gl.bindVertexArray(this.vaoField);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    this._setupAttribs(gl, this.pField, { aPos: [2, 16, 0], aUv: [2, 16, 8] });

    // 报警场 quad(P2.2): 复用 quad 缓冲, 独立 VAO(pAlarm attrib 布局单独钉)
    this.vaoAlarm = gl.createVertexArray();
    gl.bindVertexArray(this.vaoAlarm);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    this._setupAttribs(gl, this.pAlarm, { aPos: [2, 16, 0], aUv: [2, 16, 8] });

    // 蚂蚁:角点 per-vertex(divisor 0) + 实例流(divisor 1)
    this.vaoAnt = gl.createVertexArray();
    gl.bindVertexArray(this.vaoAnt);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.antVBO);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 12);
    gl.vertexAttribDivisor(3, 1);
    // P2.3.5: 第 5 个 float = 个体差异(由 uid 哈希, 0..1)。旧版只有 4 个 ⇒ 步长 16→20
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(4, 1);

    // 食物
    this.vaoFood = gl.createVertexArray();
    gl.bindVertexArray(this.vaoFood);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.foodVBO);
    this._setupAttribs(gl, this.pFood, { aPos: [2, 28, 0], aRadius: [1, 28, 8], aAmount: [1, 28, 12], aRaw: [1, 28, 16], aA0: [1, 28, 20], aSeed: [1, 28, 24] });

    // 墙
    this.vaoWall = gl.createVertexArray();
    gl.bindVertexArray(this.vaoWall);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wallVBO);
    this._setupAttribs(gl, this.pWall, { aPos: [2, 0, 0] });

    // 巢盘/巢环
    this.vaoNestFan = gl.createVertexArray();
    gl.bindVertexArray(this.vaoNestFan);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aFan);
    this._setupAttribs(gl, this.pCircle, { aPos: [2, 0, 0] });
    this.vaoNestLoop = gl.createVertexArray();
    gl.bindVertexArray(this.vaoNestLoop);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aLoop);
    this._setupAttribs(gl, this.pCircle, { aPos: [2, 0, 0] });

    // 雨丝: NDC 全屏四边形(与相机无关, 单独一个 buffer/VAO)
    this.vaoRain = gl.createVertexArray();
    gl.bindVertexArray(this.vaoRain);
    this.rainVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rainVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  1, 1,
      -1,-1,  1, 1, -1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    return true;
  }

  // 在当前绑定的 VAO 上配置 attrib(缓存 location + enable + pointer)
  _setupAttribs(gl, p, spec) {
    for (const [name, [size, stride, off]] of Object.entries(spec)) {
      const loc = gl.getAttribLocation(p, name);
      if (loc < 0) continue;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    }
  }

  _makeTex(gl, gw, gh) {
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, gw, gh, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.linearOK ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.linearOK ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tx;
  }

  _prepareTexture(gl, gw, gh) {
    if (this.fieldTex && this.fieldDims[0] === gw && this.fieldDims[1] === gh) return;
    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    this.fieldTex = this._makeTex(gl, gw, gh);
    this.fieldDims = [gw, gh];
  }

  _prepareAlarmTexture(gl, gw, gh) {
    if (this.alarmTex && this.alarmDims[0] === gw && this.alarmDims[1] === gh) return;
    if (this.alarmTex) gl.deleteTexture(this.alarmTex);
    this.alarmTex = this._makeTex(gl, gw, gh);
    this.alarmDims = [gw, gh];
  }

  setCamera(cx, cy, zoom) {
    const gl = this.ctx; if (!gl) return;
    this._cx = cx; this._cy = cy; this._zoom = zoom;
  }

  _updateView() {
    const gl = this.ctx; if (!gl) return;
    const w = this.canvas.width, h = this.canvas.height;
    const z = this._zoom ?? 0.5;
    // 世界 y 向下(与 app.js 点击换算一致):sy 取负
    const sx = (2 * z) / w, sy = -(2 * z) / h;
    const cx = this._cx ?? w / 2, cy = this._cy ?? h / 2;
    const m = this.uView;
    m[0] = sx; m[1] = 0; m[2] = 0;
    m[3] = 0; m[4] = sy; m[5] = 0;
    m[6] = -cx * sx; m[7] = -cy * sy; m[8] = 1;
  }

  _use(gl, p) {
    gl.useProgram(p);
    gl.uniformMatrix3fv(this.locView.get(p), false, this.uView);
    const la = this.locAmbient.get(p);
    if (la) gl.uniform3fv(la, this.amb);
    const lt = this.locTone.get(p);
    if (lt) gl.uniform1f(lt, values.toneMap);
  }

  // quad 顶点含世界尺寸；面板改 worldW/H 后（reset 重建 field）自动重建
  _ensureQuad(gl, w, h) {
    if (this.quadW === w && this.quadH === h) return;
    this.quadW = w; this.quadH = h;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices(w, h), gl.STATIC_DRAW);
    // quad 内容变了,VAO 不用动(只引用 buffer 对象)
  }

  resize(w, h) {
    const gl = this.ctx; if (!gl) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(1, Math.round(w * this.dpr));
    const ph = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw; this.canvas.height = ph;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(view) {
    const gl = this.ctx; if (!gl) return;
    const { field, foodPatches, nestX, nestY, nestRadius, colony } = view;
    this._updateView();

    // 环境光(P2.3): tint 乘进所有场景层。view.env 为 null 时恒为 1 → 画面与旧版逐位一致
    const env = view.env;
    const amb = this.amb;
    if (env) { amb[0] = env.tint[0]; amb[1] = env.tint[1]; amb[2] = env.tint[2]; }
    else { amb[0] = 1; amb[1] = 1; amb[2] = 1; }

    gl.disable(gl.DEPTH_TEST);
    // 底色: 旧画面是近黑的夜空(信息素往上加光); 墨色模式是一张被环境光照明的纸
    // (夜里/雨天的纸自动变暗变冷 —— 同一条 uAmbient 管线, 不必再为天气单独调色)
    if (values.inkMode > 0.5) gl.clearColor(PAPER[0] * amb[0], PAPER[1] * amb[1], PAPER[2] * amb[2], 1);
    else gl.clearColor(0.008 * amb[0], 0.012 * amb[1], 0.03 * amb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // ---- 信息素场:发光色阶 (additive 叠加在暗底) ----
    this._prepareTexture(gl, field.gw, field.gh);
    this._ensureQuad(gl, field.w, field.h);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, field.gw, field.gh, gl.RED, gl.FLOAT, field.buf);

    const ink = values.inkMode > 0.5;
    gl.enable(gl.BLEND);
    // 加光路径: 出射 = 底 + 光(ONE, ONE)。染墨路径: 出射 = 底×(1−a) + 墨×a(预乘 alpha)。
    // 墨色层是「盖在纸上的染色」⇒ 普通 alpha 混合(SRC_ALPHA), 与墙/食物/蚁/雨四条层同一约定;
    // 曾经写成 (ONE, 1-SRC_ALPHA) 而 FS 输出的是非预乘 rgb, 结果墨色被当成加光: u=0 处
    // 也照样把 纸 + 浅土黄 加出来 ⇒ 有场的那一半直接过曝成纯白。加光分支保持 (ONE, ONE) 不变。
    gl.blendFunc(ink ? gl.SRC_ALPHA : gl.ONE, ink ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    this._use(gl, this.pField);
    gl.uniform1f(this.loc.peak, effPeak());   // P2.3.2: 参考浓度可由自适应曝光接管(effPeak 保证只收光不加光)
    gl.uniform1f(this.loc.fieldInk, ink ? 1 : 0);
    gl.uniform1f(this.loc.fieldInkK, values.trailInk);
    gl.bindVertexArray(this.vaoField);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // ---- 报警信息素(P2.2): 危险红叠加(additive), 活动才上传/绘制 ----
    if (view.alarm && view.alarm.field) {
      const a = view.alarm;
      this._prepareAlarmTexture(gl, a.field.gw, a.field.gh);
      gl.bindTexture(gl.TEXTURE_2D, this.alarmTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, a.field.gw, a.field.gh, gl.RED, gl.FLOAT, a.field.buf);
      this._use(gl, this.pAlarm);
      gl.uniform1f(this.loc.alarmPeak, a.peak);
      gl.uniform1f(this.loc.alarmInk, ink ? 1 : 0);
      gl.uniform1f(this.loc.alarmInkK, 1.4);   // 报警要压得住走廊, 浓度乘子比轨迹高
      gl.bindVertexArray(this.vaoAlarm);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }

    // ---- 障碍墙(P2.1): 不透明实体, 盖住场光 ----
    this._drawWalls(gl, view.walls);
    // ---- 食物软光斑 ----
    this._drawFood(gl, foodPatches);
    // ---- 巢:盘 + 环 ----
    this._drawNest(gl, nestX, nestY, nestRadius);
    // ---- 捕食者(P2.2): 危险区红盘 + 描边 ----
    this._drawPredator(gl, view.predator);
    // ---- 蚂蚁:单个 instanced draw call ----
    this._drawAnts(gl, colony);
    // ---- 雨丝(P2.3): 最后一层, 盖在所有东西之上 ----
    if (env && env.rain > 0.01) this._drawRain(gl, env);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  // 雨丝: 纯程序化, 没有顶点数据——一格一线, 由哈希决定疏密与长短
  _drawRain(gl, env) {
    gl.useProgram(this.pRain);
    gl.uniform2f(this.loc.rainRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.loc.rainTime, env.t || 0);
    gl.uniform1f(this.loc.rainAmt, Math.min(1, env.rain));
    // windDir=0 是合法值(竖直雨),不能当假值吞掉;缺失时退回常年西风 -0.5
    const wd = env.windDir === undefined ? -0.5 : env.windDir;
    gl.uniform1f(this.loc.rainWind, wd * (0.10 + 0.45 * env.rain));
    gl.uniform3fv(this.loc.rainAmb, this.amb);
    gl.uniform1f(this.loc.rainInk, values.inkMode > 0.5 ? 1 : 0);
    gl.enable(gl.BLEND);
    // 黑底上雨是散射高光(加光); 白纸上雨是一道道灰蓝暗条(染色)
    if (values.inkMode > 0.5) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vaoRain);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  // 墙格 → 点精灵。顶点只在 wallVersion 变化时重建(静止墙每帧零重建成本)。
  _drawWalls(gl, walls) {
    if (!walls || walls.count === 0) return;
    if (this.wallVersionDrawn !== walls.version) {
      const { buf, gw, gh, cell } = walls;
      const n = walls.count;
      if (!this.wallData || this.wallData.length < n * 2) this.wallData = new Float32Array(n * 2);
      const d = this.wallData;
      let m = 0;
      for (let iy = 0; iy < gh; iy++) {
        for (let ix = 0; ix < gw; ix++) {
          if (buf[iy * gw + ix]) {
            d[m++] = (ix + 0.5) * cell;
            d[m++] = (iy + 0.5) * cell;
          }
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.wallVBO);
      gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, m), gl.STATIC_DRAW);
      this.wallCountDrawn = n;
      this.wallVersionDrawn = walls.version;
    }
    this._use(gl, this.pWall);
    gl.uniform1f(this.loc.wallInk, values.inkMode > 0.5 ? 1 : 0);
    // 点大小 = 格边长(世界单位) × 像素/世界单位(含 dpr), 与格子严丝合缝
    gl.uniform1f(this.loc.wallSize, walls.cell * this._zoom * this.dpr);
    gl.bindVertexArray(this.vaoWall);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);   // 不透明实体, 不与发光叠加
    gl.drawArrays(gl.POINTS, 0, this.wallCountDrawn);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(null);
  }

  _drawFood(gl, foodPatches) {
    const n = foodPatches.length;
    if (n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.foodVBO);
    if (this.foodCount !== n) {
      this.foodData = new Float32Array(n * 7);
      this.foodCount = n;
    }
    const d = this.foodData;
    for (let i = 0; i < n; i++) {
      const f = foodPatches[i];
      d[i * 7] = f.x; d[i * 7 + 1] = f.y;
      d[i * 7 + 2] = f.radius;
      d[i * 7 + 3] = Math.min(1, f.amount / 10);
      d[i * 7 + 4] = f.amount;
      d[i * 7 + 5] = f.a0 ?? f.amount;          // 没有 a0 的旧世界对象: 视作从未被啃(括号必须有)
      d[i * 7 + 6] = (i * 0.6180339887) % 1;   // 每块食物啃的方向不同(黄金角错开, 不新增随机流)
    }
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * 7), gl.STREAM_DRAW);
    this._use(gl, this.pFood);
    gl.uniform1f(this.loc.foodLook, values.foodLook > 0.5 ? 1 : 0);
    // 新的食物是**实体**(不透明, 盖住纸与走廊); 旧的是软光斑(加光)
    if (values.foodLook > 0.5) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    // uZoom 语义 = 像素/世界单位(含 dpr),食物点大小随之缩放
    gl.uniform1f(this.loc.foodZoom, this._zoom * this.dpr);
    gl.bindVertexArray(this.vaoFood);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  _drawNest(gl, x, y, r) {
    this._use(gl, this.pCircle);
    gl.uniform2f(this.loc.center, x, y);
    const ink = values.inkMode > 0.5;
    gl.uniform1f(this.loc.radius, r);
    // 盘:半透明填充(墨色下是洞口深处的暗)
    gl.bindVertexArray(this.vaoNestFan);
    if (ink) {
      gl.uniform1f(this.loc.radius, r * 0.62);
      gl.uniform4f(this.loc.color, 0.135, 0.105, 0.090, 0.92);
    } else {
      gl.uniform4f(this.loc.color, 0.10, 0.16, 0.28, 0.45);
    }
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 73);
    // 环:描边(墨色下是挖出来堆在口上的浮土)
    gl.bindVertexArray(this.vaoNestLoop);
    gl.uniform1f(this.loc.radius, r);
    gl.uniform4f(this.loc.color, ink ? 0.62 : 0.55, ink ? 0.52 : 0.95, ink ? 0.40 : 1.0, ink ? 0.85 : 1.0);
    gl.lineWidth((ink ? 2.4 : 1.5) * this.dpr);
    gl.drawArrays(gl.LINE_LOOP, 0, 72);
    if (ink) {
      gl.uniform1f(this.loc.radius, r * 1.10);
      gl.uniform4f(this.loc.color, 0.72, 0.63, 0.49, 0.55);
      gl.lineWidth(1.6 * this.dpr);
      gl.drawArrays(gl.LINE_LOOP, 0, 72);
    }
    gl.uniform1f(this.loc.radius, r);
    gl.bindVertexArray(null);
  }

  _drawPredator(gl, pred) {
    if (!pred) return;
    this._use(gl, this.pCircle);
    gl.uniform2f(this.loc.center, pred.x, pred.y);
    gl.uniform1f(this.loc.radius, pred.r);
    const ink = values.inkMode > 0.5;
    // 盘:暗红半透明(旧图 additive 下即危险区辉光; 纸上是压住走廊的一层暗红渍)
    gl.bindVertexArray(this.vaoNestFan);
    gl.uniform4f(this.loc.color, ink ? 0.55 : 0.35, ink ? 0.10 : 0.03, ink ? 0.07 : 0.03, ink ? 0.26 : 0.30);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 73);
    // 环:亮红描边
    gl.bindVertexArray(this.vaoNestLoop);
    gl.uniform4f(this.loc.color, ink ? 0.52 : 1.0, ink ? 0.13 : 0.30, ink ? 0.09 : 0.20, 1.0);
    gl.lineWidth(1.5 * this.dpr);
    gl.drawArrays(gl.LINE_LOOP, 0, 72);
    gl.bindVertexArray(null);
  }

  _drawAnts(gl, colony) {
    // P2.5: 画的是**活蚁数**。尸体在收尾 pass 里已被搬出 [0, population) 区间, 天然不会被画到。
    const n = colony.population ?? colony.count;
    if (n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.antVBO);
    if (!this.antBuf || this.antBuf.length < n * 5) {
      this.antBuf = new Float32Array(n * 5);
    }
    const buf = this.antBuf;
    const style = values.antStyle > 0.5;
    const av = values.antVar;
    const uid = colony.uid;
    for (let i = 0; i < n; i++) {
      const k = i * 5;
      buf[k] = colony.px[i];
      buf[k + 1] = colony.py[i];
      buf[k + 2] = colony.theta[i];
      buf[k + 3] = colony.load[i];
      // 第 5 个 = 个体差异 0..1(按 uid 哈希, 稳定)。antVar=0 时把它钉在 0.5:
      // 于是「全群同一只蚁复制粘贴」这一档是真的(同色同大小), 而不是仍在三档之间跳。
      buf[k + 4] = style ? antVar(uid ? uid[i] : i) * av + 0.5 * (1 - av) : 0;
    }
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, n * 5), gl.STREAM_DRAW);
    this._use(gl, this.pAnt);
    // 半宽 3 逻辑像素(CSS) → 世界单位。quad 经世界变换,分辨率无关,不乘 dpr;
    // (uZoom/lineWidth 走设备像素才需要 dpr)。负重蚂蚁在 VS 内再放大
    gl.uniform1f(this.loc.antScale, 3.0 / (this._zoom ?? 0.5));
    gl.uniform1f(this.loc.antStyle, style ? 1 : 0);
    gl.uniform1f(this.loc.antVar, av);
    if (style) {
      // 体长: antLen 是**屏幕 CSS 像素**(与缩放无关, 所以推近拉远都读得出同一只蚁),
      // 除以当前缩放换成世界单位。LOD 由体长与蚁数共同决定(见 look.js antLod 的理由)。
      gl.uniform1f(this.loc.antLen, values.antLen / (this._zoom ?? 0.5));
      gl.uniform1f(this.loc.antLod, antLod(values.antLen, n));
    }
    // 新色阶下蚂蚁按身体画(alpha 混合), 旧色阶下保持 additive 以逐位复现旧截图;
    // 黑壳工蚁永远是不透明实体(它在纸上, 不是在夜里发光)
    if (style || values.toneMap > 0.5) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vaoAnt);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.ctx; if (!gl) return;
    gl.deleteTexture(this.fieldTex);
    if (this.alarmTex) gl.deleteTexture(this.alarmTex);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.antVBO);
    gl.deleteBuffer(this.foodVBO);
    gl.deleteBuffer(this.wallVBO);
    gl.deleteBuffer(this.aFan);
    gl.deleteBuffer(this.aLoop);
    gl.deleteBuffer(this.cornerVBO);
    gl.deleteVertexArray(this.vaoField);
    if (this.vaoAlarm) gl.deleteVertexArray(this.vaoAlarm);
    gl.deleteVertexArray(this.vaoAnt);
    gl.deleteVertexArray(this.vaoFood);
    gl.deleteVertexArray(this.vaoWall);
    gl.deleteVertexArray(this.vaoNestFan);
    gl.deleteVertexArray(this.vaoNestLoop);
    if (this.vaoRain) gl.deleteVertexArray(this.vaoRain);
    if (this.rainVBO) gl.deleteBuffer(this.rainVBO);
  }
}
