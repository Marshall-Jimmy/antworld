// 从 config schema 自动生成 Tweakpane 面板。参数的读写在 core/config.js 上, UI 只是绑定。
//
// P2.4c · 密度整改(用户点名"现在密度太大了")。三条病根与三条改法:
//  ① 原来把整条 `desc` 当 label ⇒ 一行面板写成"信息素场分辨率(每个格子多少世界单位)"这种长度,
//     73 行下来没人读得完。现在 label 用 config 里的短名, `desc` 降级成 hover 提示(原生 title)。
//     ——**信息一个字没少, 只是不再常驻**: 悬停仍然读得到那句"人话"描述。
//  ② 分组表原来手抄在本文件里(`groupOf()` 一串 includes), 抄漏的 key 静默 fallback 进「世界」
//     ⇒ 「世界」一度装着 13 个互不相干的参数, 而其中绝大多数根本不属于世界。现在分组登记搬回
//     `core/config.js`(与参数本体同文件), 那里每次加载自检"漏登记/重复登记/与数组顺序不连续";
//     本文件调用 `groupOf()` 拿不到登记就直接 throw。**静默兜底这个失败模式被删掉了。**
//  ③ 默认只展开「场景与视图」⇒ 首屏从 73 行长句变成 1 个下拉 + 4 个按钮 + 9 个夹子标题。
//     另有「展开全部/收起全部」一键兜底, 免得有人为了找一个数挨个点。
//
// 三条都不碰仿真: 面板只是 config 的绑定层。
//
// P2.4d · 密度整改 II(用户第二次点名「密度太大」)。P2.4c 治的是「一屏塞了多少字」,
// 这一轮治它治不到的两件:
//  ④ 【找一个数】的成本: 91 行分在 11 个夹子里, 想调「蒸发率」得先猜它在哪个夹子,
//     再点开、再逐行扫。加一个过滤框(按 label / desc / key 子串匹配), 命中的留下,
//     没命中的连夹子一起收掉。**空串 = 一个 style 都不改**, 所以默认视图与今天逐像素相同。
//  ⑤ 【装不下】: 点「展开全部参数」后面板顶出视口又没有滚动条 ⇒ 下面的行永远够不着
//     (CSS 侧修, 见 index.html 的 .tp-dfwv)。行高/列宽同时放宽一档。
//  ⑥ 顺手: 场景那一栏四个按钮的标题原来各带一句括号说明(「跟拍一只蚁(G)」),
//     键盘字母才是它们的主信息 ⇒ 换成「跟拍 G」。

import { Pane } from 'tweakpane';
import { SCHEMA, set, values, groupOf } from '../core/config.js';
import { PRESETS } from '../core/presets.js';

export class Panel {
  constructor(params) {
    // params: { onChange(key,value), onShare(), onResetStats() }
    this.p = new Pane({ title: '参数', expanded: true });
    this.onChange = params.onChange || (() => {});
    this.onResetStats = params.onResetStats || (() => {});
    // ⚠ 本轮顺手修一个哑按钮: onShare 从 app.js 传进来但【从来没被存下来】, 于是「操作 ▸ 复制分享链接」
    // 一点就抛 this.onShare is not a function。该 bug 早于 P2.4b(HEAD 就带着), 一直没人点过这个按钮所以没暴露。
    this.onShare = params.onShare || (() => {});
    this.onSeed = params.onSeed || (() => {});
    this.onStorm = params.onStorm || (() => {});
    this.onJumpClock = params.onJumpClock || (() => {});
    this.onPreset = params.onPreset || (() => {});
    this.onFollow = params.onFollow || (() => {});
    this.onGraph = params.onGraph || (() => {});
    this.onRecord = params.onRecord || (() => {});
    this.onHud = params.onHud || (() => {});
    // 每条参数绑定的 {key, holder, binding}: syncValues() 靠它把「预设改掉的值」显示回滑杆。
    // 不做这件事的后果很具体: 加载迷宫预设(把 forageTimeout 提到 120)之后面板仍写着 30,
    // 用户会认为预设没生效而再点一次, 而真正在跑仿真的值早就被改了两次。
    this.bindings = [];
    // 每行参数的 {key, label, desc, el, folder, hay}: 过滤框靠它决定「这一行留不留」。
    // hay = 三个字段拼起来的小串 —— 匹配 desc 是有意的: 用户记住的往往是那句人话(「蒸发率」)
    //       而不是参数名(「信息素挥发」)。
    this.rows = [];
    this._needle = '';
    this._syncing = false;

    // 场景控件先建, 于是排在面板最上面: 它是「换个场景看」, 量级高于下面那一大排「调一个数」。
    this.addSceneControls();

    const folderByGroup = {};
    this.folders = [];   // 给「展开全部/收起全部」用

    for (const s of SCHEMA) {
      const group = groupOf(s.key);   // 无登记直接 throw, 见文件头 ②
      if (!folderByGroup[group]) {
        folderByGroup[group] = this.p.addFolder({ title: group, expanded: false });
        this.folders.push(folderByGroup[group]);
      }
      const label = s.label || s.key;
      const bindingOptions = s.options
        ? { view: 'list', options: s.options.map((v) => ({ text: String(v), value: v })) }
        : { min: s.min, max: s.max, step: s.step };
      const holder = { [s.key]: values[s.key] };
      const binding = folderByGroup[group].addBinding(holder, s.key, { label, ...bindingOptions });
      // 长描述降级为 hover: Tweakpane 的 title 只吃 label, 所以直接给这一行的 DOM 挂原生 tooltip。
      const el = binding.element || (binding.controller && binding.controller.view && binding.controller.view.element);
      if (el && el.setAttribute) el.setAttribute('title', s.desc);
      this.bindings.push({ key: s.key, holder, binding });
      this.rows.push({ key: s.key, label, desc: s.desc, el, folder: folderByGroup[group],
        hay: (label + ' ' + s.desc + ' ' + s.key).toLowerCase() });
      binding.on('change', (ev) => {
        if (this._syncing) return;   // syncValues 写回来的不是用户动作, 不能再走 onChange(那会触发 reset)
        set(s.key, ev.value);
        this.onChange(s.key);
      });
    }

    // 操作区
    const ops = this.p.addFolder({ title: '操作', expanded: false });
    this.opsFolder = ops;
    // 过滤框最后建(见下面 addFilterBox 的注释), 但它插在面板最上面 —— 建完就能用。
    this.filterBox = this.addFilterBox();
    this._allOpen = false;
    // 文案跟着状态走: 展开之后再点一次收的是哪 10 个夹子, 不能靠用户自己回忆上一次按了什么。
    this._allBtn = ops.addButton({ title: '展开全部参数' });
    this._allBtn.on('click', () => this.toggleAll());
    ops.addButton({ title: '重置搜索计时' }).on('click', () => this.onResetStats());
    ops.addButton({ title: '生成新世界(换种子)' }).on('click', () => this.onSeed());
    // 天气与昼夜(P2.3): 与键盘 R / N 等价的入口, 行为完全一致
    ops.addButton({ title: '来一场雨(R)' }).on('click', () => this.onStorm());
    ops.addButton({ title: '推时钟到对面(N)' }).on('click', () => this.onJumpClock());
    ops.addButton({ title: '复制分享链接' }).on('click', () => this.onShare());
  }

  // 场景预设(P2.4b) + 视图开关(P2.4c): 一个下拉 + 四个交互按钮。加载预设会重建整个世界
  // (食源/墙/一窝蚁), 和「来一场雨」那种往当前世界上叠事件不是一个量级, 所以单独一栏。
  addSceneControls() {
    const scenes = this.p.addFolder({ title: '场景与视图', expanded: true });
    this.vm = { preset: 'default' };
    this.presetBinding = scenes.addBinding(this.vm, 'preset', {
      label: '预设',
      options: PRESETS.map((p) => ({ text: p.name, value: p.id })),
    }).on('change', (ev) => this.onPreset(ev.value));
    scenes.addButton({ title: '跟拍 G' }).on('click', () => this.onFollow());
    scenes.addButton({ title: '曲线 M' }).on('click', () => this.onGraph());
    scenes.addButton({ title: '录像 V' }).on('click', () => this.onRecord());
    // HUD 详略在键盘 H 上(三档), 这里给个等价的鼠标入口: setLevel 传 undefined 即"切下一档"。
    scenes.addButton({ title: '详略 H' }).on('click', () => this.onHud());
    // 出画分辨率(P2.4d): 唯一砍得动 GPU 填充率的开关。默认 100%=出厂, 循环 100→75→55→100。
    scenes.addButton({ title: '画质 Q' }).on('click', () => this.onQuality && this.onQuality());
    this.sceneFolder = scenes;
  }

  // 过滤框(P2.4d ④)。为什么是原生 <input> 而不是 tweakpane 的文本控件:
  //  ① 它不是参数 —— 绑进 config 会污染 SCHEMA/分享链接/「已偏离出厂 N 项」的计数;
  //  ② 它要插在【夹子列表之外】的最顶上, 而 tweakpane 的控件只能成为某个容器的一个 blade。
  // 插入点实测: .tp-dfwv > .tp-rotv.tp-cntv > .tp-rotv_c > 12 个 .tp-fldv。取不到就退回
  // append 到根元素 —— 退化的表现是过滤框跑到最下面, 而不是抛错把整个面板带走。
  addFilterBox() {
    const root = this.p.element;
    if (!root || !root.querySelector) return null;
    const host = root.querySelector('.tp-rotv_c') || root;
    const box = document.createElement('div');
    box.className = 'tp-filter';
    const inp = document.createElement('input');
    inp.type = "search";
    inp.className = 'tp-filter_i';
    inp.placeholder = '过滤参数(名/说明/key)';
    inp.setAttribute('title', '按参数名、说明或 key 过滤下面所有行; 清空即恢复默认视图');
    const n = document.createElement('span');
    n.className = 'tp-filter_n';
    inp.addEventListener('input', () => this.applyFilter(inp.value));
    // 键盘出口(P2.4d): Esc 第一下清空过滤词(默认视图当场复原), 空串上再按才把焦点交还页面。
    // 为什么要这条: 快捷键现在只认非输入控件(见 app.js 的输入守卫), 用户按 / 跳进来得能按得出去。
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (inp.value) { inp.value = ''; this.applyFilter(''); }
      else inp.blur();
    });
    box.appendChild(inp); box.appendChild(n);
    host.insertBefore(box, host.firstChild);
    this._filterInp = inp; this._filterN = n;
    return box;
  }

  // 应用过滤。返回命中的行数(给自检/测试用)。
  // 三条约定: 空串完全复原(连夹子的展开状态都还原成进入过滤前的样子);
  // 「场景与视图」永远留着(它是换场景的入口, 不是参数); 「操作」在过滤时收掉(里面没有可匹配的行)。
  applyFilter(q) {
    const needle = (q || '').trim().toLowerCase();
    const folders = [this.sceneFolder].concat(this.folders).concat([this.opsFolder]).filter((f) => !!f);
    if (needle && !this._needle) for (const f of folders) f._expBefore = f.expanded;
    this._needle = needle;
    let hits = 0;
    const seen = new Set();
    for (const r of this.rows) {
      const on = !needle || r.hay.indexOf(needle) >= 0;
      if (r.el && r.el.style) r.el.style.display = on ? '' : 'none';
      if (on) { hits++; seen.add(r.folder); }
    }
    for (const f of folders) {
      const el = f.element;
      if (!needle) {
        if (el) el.style.display = '';
        if (f._expBefore !== undefined) { f.expanded = !!f._expBefore; f._expBefore = undefined; }
        continue;
      }
      const keep = f === this.sceneFolder || seen.has(f);
      if (el) el.style.display = keep ? '' : 'none';
      if (keep && f !== this.sceneFolder) f.expanded = true;
    }
    if (this._filterN) this._filterN.textContent = needle ? (hits + '/' + this.rows.length) : '';
    return hits;
  }

  // 「/」的落点: 焦点交给过滤框并选中旧词(直接开打就是换词)。取不到控件就返回 false。
  focusFilter() {
    const inp = this._filterInp;
    if (!inp || typeof inp.focus !== 'function') return false;
    inp.focus();
    if (typeof inp.select === 'function') inp.select();
    return true;
  }


  // 展开/收起全部参数夹子。返回当前是否全展开, 供按钮改文案。
  toggleAll() {
    this._allOpen = !this._allOpen;
    for (const f of this.folders) { f.expanded = this._allOpen; }
    // Tweakpane 4 的 ButtonApi.title 是可直接赋值的 setter, 赋了就会重画那一行。
    if (this._allBtn) this._allBtn.title = this._allOpen ? '收起全部参数' : '展开全部参数';
    return this._allOpen;
  }

  // 让下拉显示"当前真的是哪个预设"(URL 带着 ?preset= 进来时尤其必要)。
  // 用 vm + refresh() 而不是 binding.value =: 后者会派发 change, 于是「同步显示」变成「用户又加载了一次预设」。
  setPreset(id) {
    this.vm.preset = id || 'default';
    this.presetBinding && this.presetBinding.refresh();
  }

  // 把面板读回仿真真正在用的值。用 holder+refresh() 而不是 binding.value=:
  // 后者会派发 change, 于是「同步显示」会变成「用户改了一次参数」, 又触发一次 onChange→reset。
  syncValues() {
    this._syncing = true;
    for (const b of this.bindings) {
      if (b.holder[b.key] !== values[b.key]) {
        b.holder[b.key] = values[b.key];
        b.binding.refresh();
      }
    }
    this._syncing = false;
  }

}
