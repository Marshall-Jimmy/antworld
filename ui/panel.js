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
      binding.on('change', (ev) => {
        if (this._syncing) return;   // syncValues 写回来的不是用户动作, 不能再走 onChange(那会触发 reset)
        set(s.key, ev.value);
        this.onChange(s.key);
      });
    }

    // 操作区
    const ops = this.p.addFolder({ title: '操作', expanded: false });
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
    scenes.addButton({ title: '跟拍一只蚁(G)' }).on('click', () => this.onFollow());
    scenes.addButton({ title: '统计曲线(M)' }).on('click', () => this.onGraph());
    scenes.addButton({ title: '录制 webm(V)' }).on('click', () => this.onRecord());
    // HUD 详略在键盘 H 上(三档), 这里给个等价的鼠标入口: setLevel 传 undefined 即"切下一档"。
    scenes.addButton({ title: '界面详略(H)' }).on('click', () => this.onHud());
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