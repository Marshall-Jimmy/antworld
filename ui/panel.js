// 从 config schema 自动生成 Tweakpane 面板。
// 参数的读写在 core/config.js 上,UI 只是绑定。

import { Pane } from 'tweakpane';
import { SCHEMA, set, values } from '../core/config.js';

export class Panel {
  constructor(params) {
    // params: { onChange(key,value), onShare(), onResetStats() }
    this.p = new Pane({ title: '参数', expanded: true });
    this.onChange = params.onChange || (() => {});
    this.onResetStats = params.onResetStats || (() => {});
    this.onSeed = params.onSeed || (() => {});

    const folderByGroup = {};

    const groupOrder = ['世界', '感知', '转向', '运动 / 记忆', '真实感', '场'];
    const groupOf = (key) => {
      if (['foodLoadRate','carryTimeout','forageTimeout','nestRadius','speed','leak'].includes(key)) return '运动 / 记忆';
      if (['sensorAngle','sensorDist','sensorMode','K_steer','saturationMode','K_sat'].includes(key)) return '感知';
      if (['K_chem','K_home','K_out','sigma','tumbleAmp','alpha'].includes(key)) return '转向';
      if (['speedVar','turnVar','depositVar','pauseRate','pauseTime','nestDwell','missRecover'].includes(key)) return '真实感';
      if (['diffuseWeight','decayRate','peak','emptyDeposit'].includes(key)) return '场';
      return '世界';
    };

    for (const s of SCHEMA) {
      const group = groupOf(s.key);
      if (!folderByGroup[group]) {
        folderByGroup[group] = this.p.addFolder({ title: group, expanded: group === '世界' });
      }
      const bindingOptions = s.options
        ? { view: 'list', options: s.options.map(v => ({ text: String(v), value: v })) }
        : { label: s.desc, min: s.min, max: s.max, step: s.step };
      const binding = folderByGroup[group].addBinding(
        { [s.key]: values[s.key] },
        s.key,
        { label: s.desc, ...bindingOptions }
      );
      binding.on('change', (ev) => {
        const v = set(s.key, ev.value);
        this.onChange(s.key);
      });
    }

    // 操作区
    const ops = this.p.addFolder({ title: '操作', expanded: true });
    ops.addButton({ title: '重置搜索计时' }).on('click', () => this.onResetStats());
    ops.addButton({ title: '生成新世界(换种子)' }).on('click', () => this.onSeed());
    ops.addButton({ title: '复制分享链接' }).on('click', () => this.onShare());
  }
}