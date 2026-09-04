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
    this.onStorm = params.onStorm || (() => {});
    this.onJumpClock = params.onJumpClock || (() => {});

    const folderByGroup = {};

    const groupOrder = ['世界', '感知', '转向', '运动 / 记忆', '真实感', '天气 / 昼夜', '场'];
    const groupOf = (key) => {
      if (['foodLoadRate','carryTimeout','forageTimeout','nestRadius','speed','leak'].includes(key)) return '运动 / 记忆';
      if (['sensorAngle','sensorDist','sensorMode','K_steer','saturationMode','K_sat','alarmSens'].includes(key)) return '感知';
      if (['K_chem','K_home','K_out','K_wall','K_alarm','sigma','tumbleAmp','alpha'].includes(key)) return '转向';
      if (['speedVar','turnVar','depositVar','pauseRate','pauseTime','nestDwell','missRecover'].includes(key)) return '真实感';
      if (['dayNight','dayLength','dayPhase','dayCurve','tempBase','tempSwing','tempMin','tempMax',
           'weather','stormEvery','stormLen','preStormRush','rainUrge','rainWash','windWash','rainCooling','rainShelter'].includes(key)) return '天气 / 昼夜';
      if (['diffuseWeight','decayRate','peak','toneMap','alarmDecay','alarmSplash','alarmPeak','emptyDeposit'].includes(key)) return '场';
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
    // 天气与昼夜(P2.3): 与键盘 R / N 等价的入口, 行为完全一致
    ops.addButton({ title: '来一场雨(R)' }).on('click', () => this.onStorm());
    ops.addButton({ title: '推时钟到对面(N)' }).on('click', () => this.onJumpClock());
    ops.addButton({ title: '复制分享链接' }).on('click', () => this.onShare());
  }
}