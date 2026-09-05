// P2.4b · 调试 HUD 分层组件(取代原来每帧拼一大块 textContent 的写法)。
//
// 为什么要分层, 而且为什么要"只重画变了的那一层":
//  旧 HUD 把 8 行读数拼成**一个**字符串每帧赋给 textContent。两个后果:
//   ① 密度: 常驻 8 行把画面左上角盖掉一大块, 而里面大部分行(操作提示/seed/工具)几小时才看一次;
//   ② 成本: 只要有任何一个字符变了(每帧都变, 因为 fps 在里面), 整块 8 行文本连同它的
//      `white-space:pre` 布局就得重排一次——倍速时这是纯浪费。
//  于是: 三层 + 每层各自缓存指纹 + 按节流刷新。数字不动的那层一个 DOM 写操作都不发生。
//
// 三层的定义(默认停在「常用」, 按 H 循环 精简→常用→全部→精简):
//   L0 常驻  : 一屏话: 帧率 / 后端 / 倍速 / 种群 / 负重 / 卸货率
//   L1 常用  : + 昼夜天气一行(带活性曲线) + 经济曲线一行(带滑窗 sparkline)
//   L2 全部  : + 曝光 / 事件计数 / 工具与墙 / 操作提示 / seed / 当前预设
import { spark } from '../core/stats.js';

const LEVEL_NAMES = ['精简', '常用', '全部'];

export class Hud {
  constructor(host) {
    this.root = host;
    this.root.innerHTML = '';
    this.root.style.pointerEvents = 'none';
    const mk = (cls) => {
      const d = document.createElement('div');
      d.className = 'hud-' + cls;
      this.root.appendChild(d);
      return d;
    };
    this.l0 = mk('l0');
    this.l1 = mk('l1');
    this.l2 = mk('l2');
    this.level = 1;
    this._cache = { l0: '', l1: '', l2: '' };
    this._t = 0;
    this._interval = 0.15;     // 秒: HUD 刷新节流。人眼读字用不着 60Hz, 倍速时更该省这份预算给 sim
  }

  cycleLevel() { this.setLevel((this.level + 1) % 3); }

  setLevel(n) {
    this.level = Math.min(2, Math.max(0, n | 0));
    this.l1.style.display = this.level >= 1 ? '' : 'none';
    this.l2.style.display = this.level >= 2 ? '' : 'none';
    this._cache = { l0: '', l1: '', l2: '' };   // 换层必须强制重画一次, 否则被隐藏期间变的字永远看不到
    return LEVEL_NAMES[this.level];
  }

  // ctx: app.js 每帧填一次的读数对象(复用同一个对象, 不留 GC 压力)
  update(ctx, dt) {
    this._t += dt;
    if (this._t < this._interval) return;
    const secs = this._t;
    this._t = 0;
    const s = this._compose(ctx, secs);
    if (s.l0 !== this._cache.l0) { this._set(this.l0, s.l0); this._cache.l0 = s.l0; }
    if (this.level >= 1 && s.l1 !== this._cache.l1) { this._set(this.l1, s.l1); this._cache.l1 = s.l1; }
    if (this.level >= 2 && s.l2 !== this._cache.l2) { this._set(this.l2, s.l2); this._cache.l2 = s.l2; }
  }

  _set(el, lines) {
    el.textContent = '';
    for (const ln of lines) {
      const d = document.createElement('div');
      d.textContent = ln;
      el.appendChild(d);
    }
  }

  _compose(c, secs) {
    const f = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '—');
    const l0 = [
      `fps ${c.fps.toFixed(0)} · ${c.backend} · ${c.speed}` +
        (c.preset && c.preset !== 'default' ? ` · ${c.presetName}` : '') +
        (c.pace ? ` · ${c.pace}` : ''),
      c.survOn
        ? `种群 ${c.pop}/${c.popCap} · 巢储 ${c.resNow} · 出生 ${c.births} 死亡 ${c.deaths} (饿 ${c.starved} 竭 ${c.worn})`
        : `蚁 ${c.pop} · 负重 ${c.loaded} · 卸货 ${c.delNow}/秒 · 首次发现 ${c.firstFood}`,
    ];
    const l1 = [];
    if (c.envLine) {
      l1.push(c.envLine);
      l1.push(`${c.actSpark} 活性 ${f(c.act, 2)}×  (最近 ${c.actSpan} 秒)`);
    }
    l1.push(`经济 ${c.sparkDel} 卸货 · ${c.sparkLoad} 负重`);
    l1.push(`     ${c.sparkAb} 空手返巢 · ${c.sparkFood} 存粮`);
    const l2 = [
      `曝光 ${c.effPeak} · 感知 ${c.sensorMode} · 速度档 ${c.speedLevel} (1/2/3/4, 0=暂停) · 工具 ${c.tool} (F/W/E/P)`,
      `墙 ${c.walls} 格(X 清) · 捕食者 ${c.predator} · 卸货累计 ${c.delTot} · 弃货 ${c.tot} · 空手返巢 ${c.abTot} · 被捕杀 ${c.killTot}`,
      `左键 检视/放食物/画墙 · 右键 移除/平移 · 滚轮 缩放 · 点蚁自动跟拍(G 停) · V 录像 · H 界面详略 · M 曲线`,
      `seed ${c.seed} · 预设 ${c.preset} · 参数 ${c.paramCount} 项已偏离出厂`,
      // 生死开着时经济那一行不够用: 出生/死亡/储备三本账必须同屏(它们互相咬合)
      c.survOn ? `经济入库 ${c.inflow} · 取食 ${c.eaten} · 产蚁耗 ${c.birthFood} · 溢出 ${c.overflow}` : null,
      c.survOn ? `蚁 ${c.loaded} 负重 · 田外余粮 ${c.fieldFood} · 全群最低能量 ${c.eMin}` : null,
    ];
    if (c.followLine) l2.unshift(c.followLine);
    return { l0, l1, l2: l2.filter((x) => x !== null) };
  }
}
