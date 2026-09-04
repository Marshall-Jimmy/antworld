// WebGL2 渲染后端。
// - 信息素场 → R32F 纹理，全屏/世界四边形上用色阶映射发光（图片的主角）
// - 蚂蚁 → instanced 定向四边形（头尾拉长的 comet 形体，单个 draw call，20000 只无压力）
// - 食物 → 软光斑点
// - 巢 → 圆盘 + 环形描边
// - 坐标约定：世界 y 向下（与 app.js 点击换算/检视层/Canvas2D 兜底一致）。
//   旧版 uView 的 sy 为正导致画面整体垂直镜像（点击/检视与显示对不上），已修正。

import { Backend } from './backend.js';
import { get, values, SCHEMA } from '../core/config.js';

const VS_FIELD = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform mat3 uView;
out vec2 vUv;
void main(){ vUv=aUv; vec3 p=uView*vec3(aPos,1.0); gl_Position=vec4(p.xy,0.0,1.0); }`;

const FS_FIELD = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
uniform float uPeak;
out vec4 o;
void main(){
  float v = max(0.0, texture(uField, vUv).r);
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
}`;

const FS_ALARM = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
uniform float uPeak;
out vec4 o;
void main(){
  float v = max(0.0, texture(uField, vUv).r);
  float t = clamp(v / uPeak, 0.0, 1.0);
  float e = t*t*(3.0-2.0*t);            // smoothstep
  o = vec4(vec3(1.0,0.22,0.10) * e * 0.9, 1.0);   // 危险红, 叠加在场光之上
}`;

// 蚂蚁:instanced 定向四边形。aCorner 是单位四角(x 向前),实例流 = 位置/朝向/负载。
// 形体在 VS 中按朝向旋转、按负载放大(负重蚂蚁更大),FS 画长椭球 + 头亮尾暗 comet。
const VS_ANT = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aPos;
layout(location=2) in float aTheta;
layout(location=3) in float aLoad;
uniform mat3 uView; uniform float uScale;
out vec2 vC; out float vLoad;
void main(){
  float sz = uScale * (1.0 + 0.9*aLoad);
  vec2 local = vec2(aCorner.x * sz * 1.7, aCorner.y * sz);   // 头尾方向拉长 1.7x
  float cs = cos(aTheta), sn = sin(aTheta);
  vec2 world = aPos + vec2(local.x*cs - local.y*sn, local.x*sn + local.y*cs);
  gl_Position = vec4((uView*vec3(world,1.0)).xy, 0.0, 1.0);
  vC = aCorner; vLoad = aLoad;
}`;

const FS_ANT = `#version 300 es
precision highp float;
in vec2 vC; in float vLoad;
out vec4 o;
void main(){
  vec3 empty = vec3(0.35,0.65,1.00);   // 空手:冷静蓝
  vec3 loaded= vec3(1.00,0.85,0.35);   // 负重:暖金
  vec3 col = mix(empty, loaded, vLoad);
  // 长椭球体(vC.x∈[-0.5,0.5] 对应实际 ±0.85 半长)
  float r = length(vec2(vC.x/0.85, vC.y/0.5));
  float body = 1.0 - smoothstep(0.70, 1.0, r);
  float comet = clamp(exp(vC.x*3.2), 0.0, 1.0);            // 前亮后暗
  float tail = clamp(exp(vC.x*1.1)*0.45, 0.0, 1.0) * smoothstep(-0.5,-0.05,vC.x);
  float a = body*(0.30+0.70*comet+tail);
  o = vec4(col*a, 1.0);
}`;

const VS_FOOD = `#version 300 es
in vec2 aPos; in float aRadius; in float aAmount;
uniform mat3 uView; uniform float uZoom;
out float vAmt;
void main(){
  vAmt = aAmount;
  vec3 p = uView*vec3(aPos,1.0);
  gl_Position = vec4(p.xy,0.0,1.0);
  gl_PointSize = max(3.0, aRadius*2.0*uZoom);
}`;

const FS_FOOD = `#version 300 es
precision highp float;
in float vAmt;
out vec4 o;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.04, d);
  float amt = clamp(vAmt, 0.0, 1.0);
  vec3 col = vec3(0.30, 1.00, 0.45)*amt;
  o = vec4(col*a, 1.0);
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
out vec4 o;
void main(){
  // 方块点内轻微中心亮边缘暗, 让整面墙有一点厚度感
  vec2 d = abs(gl_PointCoord - 0.5);
  float edge = smoothstep(0.5, 0.34, max(d.x, d.y));
  o = vec4(mix(vec3(0.13,0.15,0.19), vec3(0.30,0.34,0.42), edge), 1.0);
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
out vec4 o;
void main(){ o = uColor; }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
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
    this.dpr = 1;
  }

  init(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    if (!gl) return false;
    this.ctx = gl;
    this.canvas = canvas;
    this.linearOK = !!gl.getExtension('OES_texture_float_linear');

    // 四边形顶点:世界 (0,0)-(w,h), uv 对应
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0,0, 0,0,   get('worldW'),0, 1,0,
      0,get('worldH'), 0,1,  get('worldW'),get('worldH'), 1,1,
    ]), gl.STATIC_DRAW);

    this.pField = program(gl, VS_FIELD, FS_FIELD);
    this.pAlarm = program(gl, VS_FIELD, FS_ALARM);
    this.pAnt = program(gl, VS_ANT, FS_ANT);
    this.pFood = program(gl, VS_FOOD, FS_FOOD);
    this.pWall = program(gl, VS_WALL, FS_WALL);
    this.pCircle = program(gl, VS_CIRCLE, FS_CIRCLE);

    // ---- location 缓存（每帧查询 getUniformLocation/getAttribLocation 有开销） ----
    this.locView = new Map([
      [this.pField, gl.getUniformLocation(this.pField, 'uView')],
      [this.pAlarm, gl.getUniformLocation(this.pAlarm, 'uView')],
      [this.pAnt, gl.getUniformLocation(this.pAnt, 'uView')],
      [this.pFood, gl.getUniformLocation(this.pFood, 'uView')],
      [this.pWall, gl.getUniformLocation(this.pWall, 'uView')],
      [this.pCircle, gl.getUniformLocation(this.pCircle, 'uView')],
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
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 16, 12);
    gl.vertexAttribDivisor(3, 1);

    // 食物
    this.vaoFood = gl.createVertexArray();
    gl.bindVertexArray(this.vaoFood);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.foodVBO);
    this._setupAttribs(gl, this.pFood, { aPos: [2, 16, 0], aRadius: [1, 16, 8], aAmount: [1, 16, 12] });

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
  }

  // quad 顶点含世界尺寸；面板改 worldW/H 后（reset 重建 field）自动重建
  _ensureQuad(gl, w, h) {
    if (this.quadW === w && this.quadH === h) return;
    this.quadW = w; this.quadH = h;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0,0, 0,0,   w,0, 1,0,
      0,h, 0,1,   w,h, 1,1,
    ]), gl.STATIC_DRAW);
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

    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.008, 0.012, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // ---- 信息素场:发光色阶 (additive 叠加在暗底) ----
    this._prepareTexture(gl, field.gw, field.gh);
    this._ensureQuad(gl, field.w, field.h);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, field.gw, field.gh, gl.RED, gl.FLOAT, field.buf);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this._use(gl, this.pField);
    gl.uniform1f(this.loc.peak, values.peak);
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

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
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
      this.foodData = new Float32Array(n * 4);
      this.foodCount = n;
    }
    const d = this.foodData;
    for (let i = 0; i < n; i++) {
      const f = foodPatches[i];
      d[i * 4] = f.x; d[i * 4 + 1] = f.y;
      d[i * 4 + 2] = f.radius;
      d[i * 4 + 3] = Math.min(1, f.amount / 10);
    }
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * 4), gl.STREAM_DRAW);
    this._use(gl, this.pFood);
    // uZoom 语义 = 像素/世界单位(含 dpr),食物点大小随之缩放
    gl.uniform1f(this.loc.foodZoom, this._zoom * this.dpr);
    gl.bindVertexArray(this.vaoFood);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.bindVertexArray(null);
  }

  _drawNest(gl, x, y, r) {
    this._use(gl, this.pCircle);
    gl.uniform2f(this.loc.center, x, y);
    gl.uniform1f(this.loc.radius, r);
    // 盘:半透明填充
    gl.bindVertexArray(this.vaoNestFan);
    gl.uniform4f(this.loc.color, 0.10, 0.16, 0.28, 0.45);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 73);
    // 环:描边
    gl.bindVertexArray(this.vaoNestLoop);
    gl.uniform4f(this.loc.color, 0.55, 0.95, 1.0, 1.0);
    gl.lineWidth(1.5 * this.dpr);
    gl.drawArrays(gl.LINE_LOOP, 0, 72);
    gl.bindVertexArray(null);
  }

  _drawPredator(gl, pred) {
    if (!pred) return;
    this._use(gl, this.pCircle);
    gl.uniform2f(this.loc.center, pred.x, pred.y);
    gl.uniform1f(this.loc.radius, pred.r);
    // 盘:暗红半透明(additive 下即危险区辉光)
    gl.bindVertexArray(this.vaoNestFan);
    gl.uniform4f(this.loc.color, 0.35, 0.03, 0.03, 0.30);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 73);
    // 环:亮红描边
    gl.bindVertexArray(this.vaoNestLoop);
    gl.uniform4f(this.loc.color, 1.0, 0.30, 0.20, 1.0);
    gl.lineWidth(1.5 * this.dpr);
    gl.drawArrays(gl.LINE_LOOP, 0, 72);
    gl.bindVertexArray(null);
  }

  _drawAnts(gl, colony) {
    const n = colony.count;
    if (n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.antVBO);
    if (!this.antBuf || this.antBuf.length < n * 4) {
      this.antBuf = new Float32Array(n * 4);
    }
    const buf = this.antBuf;
    for (let i = 0; i < n; i++) {
      buf[i * 4] = colony.px[i];
      buf[i * 4 + 1] = colony.py[i];
      buf[i * 4 + 2] = colony.theta[i];
      buf[i * 4 + 3] = colony.load[i];
    }
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, n * 4), gl.STREAM_DRAW);
    this._use(gl, this.pAnt);
    // 半宽 3 逻辑像素(CSS) → 世界单位。quad 经世界变换,分辨率无关,不乘 dpr;
    // (uZoom/lineWidth 走设备像素才需要 dpr)。负重蚂蚁在 VS 内再放大
    gl.uniform1f(this.loc.antScale, 3.0 / (this._zoom ?? 0.5));
    gl.bindVertexArray(this.vaoAnt);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
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
  }
}
