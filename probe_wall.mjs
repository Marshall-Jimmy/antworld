// 调试探针: 抓"蚂蚁位于墙内"的第一次现场(上一步位置/本步位置/墙格布局)
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    values[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}
values.K_wall = Number(process.env.KW ?? 0);

const DT = 1 / 60;
const w = values.worldW, h = values.worldH;
const world = new World(w, h, values.gridCell);
const field = new Field(w, h, values.gridCell);
world.addFood(w * 0.78, h * 0.5, 30, 400);
const wx = w * 0.62;
for (let y = 0; y <= h; y += 6) {
  if (y < h * 0.24 || y > h * 0.76) continue;
  world.paintWall(wx, y, 14, true);
}
const colony = new Colony(values.antCount, { rng: rng(hashSeed('wallcheck')), world, nestRadius: values.nestRadius });

const prevX = new Float32Array(colony.count);
const prevY = new Float32Array(colony.count);
for (let t = 0; t < 90 * 60; t++) {
  field.step(values.diffuseWeight, Math.pow(values.decayRate, DT), world.walls);
  prevX.set(colony.px); prevY.set(colony.py);
  colony.step(field, world, values, DT);
  for (let i = 0; i < colony.count; i++) {
    if (world.wallAt(colony.px[i], colony.py[i])) {
      const px0 = prevX[i], py0 = prevY[i], px1 = colony.px[i], py1 = colony.py[i];
      console.log(`t=${(t * DT).toFixed(2)}s ant=${i} load=${colony.load[i].toFixed(2)} pauseT=${colony.pauseT[i].toFixed(2)}`);
      console.log(`  prev=(${px0.toFixed(2)}, ${py0.toFixed(2)}) wallAt=${world.wallAt(px0, py0)}`);
      console.log(`  curr=(${px1.toFixed(2)}, ${py1.toFixed(2)}) wallAt=${world.wallAt(px1, py1)} theta=${colony.theta[i].toFixed(2)}`);
      console.log(`  cell=${world.cell} gw=${world.gw} wallCount=${world.wallCount}`);
      // 墙格邻域图(prev→curr 周围 5×5)
      const gxc = Math.floor(px1 / world.cell), gyc = Math.floor(py1 / world.cell);
      let s = '';
      for (let gy = gyc - 2; gy <= gyc + 2; gy++) {
        let row = '';
        for (let gx = gxc - 2; gx <= gxc + 2; gx++) {
          const ix = ((gx % world.gw) + world.gw) % world.gw;
          const iy = ((gy % world.gh) + world.gh) % world.gh;
          row += world.walls[iy * world.gw + ix] ? '#' : (gx === gxc && gy === gyc ? 'A' : '.');
        }
        s += '    ' + row + '\n';
      }
      console.log(s + '    (A=蚂蚁所在格)');
      process.exit(2);
    }
  }
}
console.log('90s 内无违规');
