// P1.9 验收: 食物耗尽后, 死点周围是否还聚着一团徘徊的蚂蚁?
// A/B: forageTimeout=0(旧行为) vs 30(返巢休整)。同种子同场景, 只改这一个参数。
// 场景与 render_png.mjs 一致: 单块食物 amount=200, 很快被吃光 → 死点出现得早。
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

const PROBE_T = [20, 35, 50, 65, 80];   // 采样时刻(秒)
const RADIUS = 80;                       // "还在死点附近"的判定半径(世界单位)
const SCEN = process.env.SCEN || 'single';

for (const fto of [0, 30]) {
  values.forageTimeout = fto;
  const r = rng(hashSeed('render'));
  const w = values.worldW, h = values.worldH;
  const world = new World(w, h);
  const field = new Field(w, h, values.gridCell);
  const fx = w * 0.62, fy = h * 0.62;
  // single: 只有一块食物(耗尽后世界无食) / two: A 先耗尽, B 还在(死点徘徊=产能损失)
  if (SCEN === 'two') {
    world.addFood(fx, fy, 30, 60);                 // A: 很快耗尽 → 死点
    world.addFood(w * 0.35, h * 0.35, 30, 600);    // B: 一直有食物
  } else {
    world.addFood(fx, fy, 30, 200);
  }
  const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });
  const dt = 1 / 60;
  let probe = 0, out = [];
  let foodGoneAt = null;
  for (let t = 0; t < 80 * 60; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, dt));
    colony.step(field, world, values, dt);
    const secs = t / 60;
    if (foodGoneAt === null && world.foodPatches[0].amount <= 0) foodGoneAt = secs;
    if (probe < PROBE_T.length && secs >= PROBE_T[probe]) {
      let near = 0;
      for (let i = 0; i < colony.count; i++) {
        const dx = colony.px[i] - fx, dy = colony.py[i] - fy;
        if (dx * dx + dy * dy < RADIUS * RADIUS) near++;
      }
      out.push(`${PROBE_T[probe]}s: 死点${RADIUS}u内 ${near} 只`);
      probe++;
    }
  }
  console.log(`\n=== forageTimeout=${fto}${fto === 0 ? ' (旧行为)' : ' (返巢休整)'} [${SCEN}] ===`);
  console.log(`食物A耗尽时刻: ${foodGoneAt === null ? '>' : foodGoneAt.toFixed(1) + 's'}  卸货=${colony.deliveries} 弃货=${colony.timeouts} 空手返巢=${colony.aborts}`);
  console.log(out.join('\n'));
}
