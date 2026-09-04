// 临时冒烟测试：验证 sim 层能 headless 跑，且涌现出觅食/回巢/沉积现象。
import { values, set } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

for (const a of ['gridCell','sensorAngle','sensorDist','K_chem','K_home','sigma','tumbleAmp','alpha','speed','leak','carryTimeout','nestRadius','foodLoadRate','depositRate','diffuseWeight','decayRate','antCount']) {
  // 用默认值
}

const seed = 'headless-test';
const r = rng(hashSeed(seed));
const w = values.worldW, h = values.worldH;
const world = new World(w, h);
const field = new Field(w, h, values.gridCell);
world.addFood(w*0.62, h*0.62, 30, 200);
const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });

const dt = 1/60;
const T = 60*20; // 20 秒
let peakLoaded = 0;
let depositTotal = 0;
let everFound = false;

for (let t = 0; t < T; t++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, dt));
  colony.step(field, world, values, dt);
  if (colony.firstFoodAnt >= 0) everFound = true;
  peakLoaded = Math.max(peakLoaded, colony.loadedCount());
  // 粗略统计沉积总量(每步对所有格子求和太贵,改用采样)
}

// 采样信息素总量
let sum = 0, maxv = 0;
for (let i = 0; i < field.buf.length; i++) { sum += field.buf[i]; maxv = Math.max(maxv, field.buf[i]); }

console.log('=== headless 冒烟 ===');
console.log('蚂蚁', colony.count, '格子', field.gw + 'x' + field.gh);
console.log('在任何步发现食物:', everFound);
console.log('峰值负重蚂蚁数:', peakLoaded);
console.log('信息素总量(20s后):', sum.toFixed(1), '最大单格:', maxv.toFixed(3));
console.log('仍在巢半径内蚂蚁占比:',
  (() => { let c=0; for(let i=0;i<colony.count;i++){ const d=Math.hypot(colony.px[i]-world.nestX, colony.py[i]-world.nestY); if(d<values.nestRadius)c++; } return (c/colony.count*100).toFixed(1); })() + '%');