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

  // ---- 转向 ----
  { key: 'K_chem',     default: 1.6, min: 0, max: 10, step: 0.05, desc: '沿信息素梯度转向的增益(空手时)' },
  { key: 'K_home',     default: 3.4, min: 0, max: 10, step: 0.05, desc: '沿回家向量转向的增益(负重时)' },
  { key: 'K_out',      default: 0,   min: 0, max: 10, step: 0.05, desc: '出巢极性:空手蚂蚁被推着向外走(K_home的反向项)' },
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
  { key: 'leak',       default: 0.02,min: 0,   max: 0.6,step: 0.005, desc: '航位推算遗忘率(比例/秒),0=永远记得' },
  { key: 'carryTimeout',default: 40, min: 1,  max: 120, step: 1, desc: '负重最久时长(秒),超时弃货防死循环' },
  { key: 'forageTimeout',default: 30,min: 0,  max: 120, step: 1, desc: '空手觅食超时(秒):太久没收获就放弃觅食、凭路径积分直接回家休整再出发(P1.9), 0=关闭' },
  { key: 'missRecover',  default: 0.02,min: 0,  max: 0.2, step: 0.005, desc: '觅食失败后的信任恢复速率(次/秒):失败越多越不信信息素路,成功采食立即回满' },
  { key: 'nestRadius', default: 30,  min: 5,  max: 300, step: 1, desc: '巢半径:回家向量小于它就算到家' },
  { key: 'foodLoadRate',default: 0.5,min: 0.05,max: 5,  step: 0.05, desc: '采食速率(载货量/秒),连续上升不是秒满' },
  { key: 'depositRate',default: 0.45,min: 0.001,max: 2, step: 0.005, desc: '负重蚂蚁每秒沉积的信息素量' },

  // ---- 真实感 (个体差异与停顿; 全 0 = 回到整齐划一的旧机制) ----
  { key: 'speedVar',   default: 0.2, min: 0, max: 0.6, step: 0.05, desc: '个体速度差异(±比例):有的蚁快有的蚁慢' },
  { key: 'turnVar',    default: 0.3, min: 0, max: 1,   step: 0.05, desc: '个体转向性格(±比例):有的蚁走直线有的蚁爱扭' },
  { key: 'depositVar', default: 0.35,min: 0, max: 1,   step: 0.05, desc: '个体沉积差异(±比例):信息素路有浓有淡有纹理' },
  { key: 'pauseRate',  default: 0.8, min: 0, max: 5,   step: 0.05, desc: '觅食蚁每秒停下触角扫描的概率(次/秒)' },
  { key: 'pauseTime',  default: 0.4, min: 0, max: 3,   step: 0.05, desc: '触角扫描停顿时长基准(秒),停下时原地转头不移动' },
  { key: 'nestDwell',  default: 1.2, min: 0, max: 10,  step: 0.1,  desc: '卸货后在巢里磨蹭多久再出门(秒)' },

  // ---- 场 ----
  { key: 'diffuseWeight', default: 0.06, min: 0.001, max: 0.25, step: 0.001, desc: '3x3 扩散权重(越大越糊越快)' },
  { key: 'decayRate',     default: 0.97, min: 0.2,   max: 0.999,step: 0.005, desc: '信息素每秒衰减系数,1=永不消失' },
  { key: 'peak',          default: 0.7,  min: 0.01,  max: 2,    step: 0.01,  desc: '渲染色阶:信息素达到该值视为最亮' },
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