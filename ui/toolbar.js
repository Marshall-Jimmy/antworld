// P2.4h · 顶部工具条: 把「换个场景看」与「换个看法」这两类动作从参数面板里搬出来。
//
// 病根(用户第二次点名「不要都堆在一起」): 到 P2.4d 为止, 右上角那一列里同时塞着
//   预设下拉 + 5 个视图按钮 + 过滤框 + 11 个参数夹子(91 行) + 「操作」夹子里 6 个按钮,
// 而 tweakpane 只有一根垂直列表可给 —— 所以「堆」的不是行距, 是【不同种类的东西共用一个视觉槽位】。
//
// 分工按「你在这里干什么」重排, 每一类各占一角:
//   左上 HUD 读数 · 左下 统计曲线 · 右上 91 行参数(tweakpane, 只管参数) · 底部中 toast
//   顶部正中 = 本文件: 场景段(换世界) + 视图段(换看法)
//
// 三条约束:
//  1) 不新增任何行为 —— 每个按钮都是 app.js 里已有那个函数的入口, 快捷键与语义一个字没改;
//  2) 激活态(跟拍中/曲线开/录像中)由 app.js 在**状态变化点**显式推过来, 不轮询 ⇒ 热路径零分配;
//     setOn/setBadge 都自带「值没变就不碰 DOM」的短路, 因为推它的调用点在主循环的邻域里。
//  3) 配色与画面同源: 画面是「白纸 + 墨」(render/look.js 的 PAPER), 浮层就用米白与墨色;
//     深色只留给参数面板(另一类东西: 低频、高密度、读数字而不是找按钮)。
import { PRESETS } from '../core/presets.js';

// key = 快捷键角标(与 app.js 的键盘处理同源, 这里只是把字母显示出来); badge = 按钮右侧那枚状态字。
const BTNS = [
  { sec: 'scene', id: 'seed',   ico: '↻', name: '换种子', key: '',    tip: '重掷随机种子, 造一个全新的世界(蚁数与参数不变)' },
  { sec: 'scene', id: 'share',  ico: '⧉', name: '分享',   key: '',    tip: '复制当前画面的链接(参数 + 预设 + 种子), 别人打开就是同一个世界' },
  { sec: 'scene', id: 'storm',  ico: '☂', name: '起雨',   key: 'R',   tip: '提前让气压下跌起 storm(需要把「天气强度」调到 >0)' },
  { sec: 'scene', id: 'clock',  ico: '☾', name: '昼夜',   key: 'N',   tip: '把时钟推到对面, 昼行↔夜行互换(需要「昼夜节律强度」>0)' },
  { sec: 'view',  id: 'follow', ico: '◎', name: '跟拍',   key: 'G',   tip: '镜头跟住一只蚁(左键点蚁选对象)。跟上去之后能讲出这一只的完整故事' },
  { sec: 'view',  id: 'graph',  ico: '∿', name: '曲线',   key: 'M',   tip: '左下角展开最近 60 秒的卸货率 / 负重数 / 空手返巢曲线' },
  { sec: 'view',  id: 'record', ico: '●', name: '录像',   key: 'V',   tip: '开始录 webm(再按一次停止并落盘)。会把 HUD 与曲线一起合成进去' },
  { sec: 'view',  id: 'hud',    ico: '≡', name: '详略',   key: 'H',   tip: '左上读数三档循环: 精简 / 常用 / 详尽', badge: true },
  { sec: 'view',  id: 'quality', ico: '◐', name: '画质',  key: 'Q',   tip: '出画分辨率 100→75→55→100: 唯一砍得动 GPU 填充率的旋钮', badge: true },
];

export class Toolbar {
  constructor(handlers) {
    this.h = handlers || {};
    this.root = document.getElementById('toolbar');
    this.btns = {};
    this.badges = {};
    this.secs = {};
    if (!this.root) throw new Error('Toolbar: 页面上没有 #toolbar(index.html 的分区骨架)');
    this._mkSelect();
    let last = '';
    for (const b of BTNS) {
      if (b.sec !== last) { this._mkSec(b.sec); last = b.sec; }
      this.secs[b.sec].appendChild(this._mkBtn(b));
    }

    // 顶栏是整宽的一条, 但窄窗下它会 flex-wrap 成两行 ⇒ 挂在它下沿的 HUD 与参数面板
    // 不能把栏高写死成一个常量。这里量真实高度并发布成 CSS 变量 --bar-h(index.html 的 :root),
    // 让「谁压在谁上面」这件事由布局自己算, 而不是靠给两侧预留宽度去赌。
    // 用 ResizeObserver 而不是 window resize: 换行也可能由字号/内容长度变化引起, 那些时刻没有 resize。
    this._publishBarH();
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._publishBarH());
      this._ro.observe(this.root);
    }
  }

  // 一段 = 一个标题 + 一排按钮; 段与段之间一根竖线。标题写「这一栏在改什么」, 不写「设置」。
  _mkSec(id) {
    if (id !== 'scene') { const d = document.createElement('i'); d.className = 'tb-div'; this.root.appendChild(d); }
    const s = document.createElement('div');
    s.className = 'tb-sec tb-' + id;
    const c = document.createElement('span');
    c.className = 'tb-cap';
    c.textContent = id === 'scene' ? '场景' : '视图';
    c.title = id === 'scene'
      ? '这一段会动到【世界本身】: 换种子 / 换场景 / 往世界里加事件'
      : '这一段只动【你怎么看】: 镜头、曲线、录像、读数、分辨率 —— 仿真一步都不变';
    s.appendChild(c);
    this.root.appendChild(s);
    this.secs[id] = s;
    return s;
  }

  _mkSelect() {
    const w = document.createElement('label');
    w.className = 'tb-sel';
    w.title = '一键换场景: 重建整个世界(食源 / 墙 / 一窝蚁)。与「起雨」那种往现世界上叠事件不是一个量级';
    const c = document.createElement('span');
    c.className = 'tb-cap';
    c.textContent = '预设';
    const s = document.createElement('select');
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      o.title = p.desc || '';
      s.appendChild(o);
    }
    s.addEventListener('change', () => this.h.preset && this.h.preset(s.value));
    w.appendChild(c); w.appendChild(s);
    this.root.appendChild(w);
    this.sel = s;
  }

  _mkBtn(def) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.title = def.tip;
    const i = document.createElement('i'); i.className = 'tb-ico'; i.textContent = def.ico;
    const n = document.createElement('span'); n.className = 'tb-name'; n.textContent = def.name;
    b.appendChild(i); b.appendChild(n);
    if (def.badge) {
      const g = document.createElement('span'); g.className = 'tb-badge';
      b.appendChild(g);
      this.badges[def.id] = g;
    }
    const k = document.createElement('kbd'); k.className = 'tb-kbd'; k.textContent = def.key;
    b.appendChild(k);
    b.addEventListener('click', () => this.h[def.id] && this.h[def.id]());
    this.btns[def.id] = b;
    return b;
  }

  // ---- 状态入口(app.js 在状态变化点调用; 值没变就一个 DOM 写操作都不做) ----
  setOn(id, on) {
    const b = this.btns[id];
    if (!b) return;
    if (b.classList.contains('is-on') === !!on) return;
    b.classList.toggle('is-on', !!on);
  }
  setBadge(id, text) {
    const g = this.badges[id];
    if (!g || g.textContent === text) return;
    g.textContent = text;
  }
  // 只在高度真的变了时写一次 CSS 变量: 构造期跑一次, 之后每次换行才跑, 主循环一步都不碰。
  _publishBarH() {
    const h = Math.round(this.root.getBoundingClientRect().height);
    if (h > 0 && h !== this._barH) {
      this._barH = h;
      document.documentElement.style.setProperty('--bar-h', h + 'px');
    }
  }

  setPreset(id) {
    const v = id || 'default';
    if (this.sel && this.sel.value !== v) this.sel.value = v;
  }
}
