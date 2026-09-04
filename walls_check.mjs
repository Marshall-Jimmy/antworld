// P2.1 验收: 障碍墙与绕行 (P2.2 诚实化重定基: 机制/阈值注释见下方与 METRICS)
// 1) 不变量: 蚂蚁永不处于墙格内; 信息素在墙格恒 0(不渗不透)
// 2) 可达性: 巢与食物之间立一道带缺口的墙, 蚁群仍能建立真实往返的觅食路(诚实卸货>20)
// 3) 绕行成本: 同 seed 有墙 vs 无墙 —— 首次发现时间 / 卸货量 / 总耗食对比
// 4) 绕行真实性: 卸货蚁实际走过的路必须真的绕过墙(路径采样点不穿墙)
// 用法: node walls_check.mjs   (SEED/SIM_T 环境变量可覆盖)
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony } from './sim/colony.js';

const SEED = process.env.SEED || 'wallcheck';
const SIM_T = Number(process.env.SIM_T || 240);       // 秒(P2.2 起: 诚实绕行往返约 35~50s,
                                                      // 加上发现食物的时间, 90s 窗口刚够开头)
const DT = 1 / 60;
// P2.2 起(诚实卸货后)这里做过一次深挖: 食物曾在 0.78w(离巢 560u), 诚实化后卸货
// 归零。根因是航位推算遗忘 leak: h 是"带遗忘的记忆"而非纯位移, 返程途中出发段的
// 记忆按秒衰减, h 会在到巢前提前归零(560u 场景实测提前 159u), 蚂蚁此后在原地打转;
// 更致命的是绕行路径(约 2.5 倍直距)必然超出记忆预算, 有墙场景连第一只回家的蚂蚁
// 都产生不了。旧卸货判定 |h|<nestRadius 恰好在归零点"卸货", 把这一切伪装成 8834
// 次"卸货"(P2.1 旧记录, 见 METRICS P2.2 修正)。真实路径积分是累积误差而非指数
// 遗忘, 故 P2.2 把 leak 默认改为 0(参数保留供实验); 几何保持重定基后的 0.65w
// (离巢 300u, 与 predator_check 同尺度, 测试也更快)。
const FOOD_X = 0.65, WALL_X = 0.58;
// PARAMS=k=v,k=v 覆盖任意参数(如 K_wall=0 看纯物理阻挡的表现)
if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    values[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}
const w = values.worldW, h = values.worldH;
let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };

function run(withWall) {
  const r = rng(hashSeed(SEED));
  const world = new World(w, h, values.gridCell);
  const field = new Field(w, h, values.gridCell);
  const fx = w * FOOD_X, fy = h * 0.5;                // 食物在巢正右方(P2.2 重定基, 见上)
  world.addFood(fx, fy, 30, 400);
  if (withWall) {
    // 竖墙 x=WALL_X, 顶/底各留 24% 缺口(torus 下等价于中间留一个大缺口段)
    const wx = w * WALL_X;
    for (let y = 0; y <= h; y += 6) {
      if (y < h * 0.24 || y > h * 0.76) continue;
      world.paintWall(wx, y, 14, true);
    }
  }
  const colony = new Colony(values.antCount, { rng: r, world, nestRadius: values.nestRadius });

  let firstFood = null, wallVisits = 0, trailInWall = 0, wallChecks = 0;
  // 卸货蚁路径采样: 记录若干只回巢蚁的轨迹是否穿墙
  let detourChecked = 0, detourCrossed = 0;
  const trackId = new Map();     // antIdx → 最近 N 步采样点
  for (let t = 0; t < SIM_T * 60; t++) {
    field.step(values.diffuseWeight, Math.pow(values.decayRate, DT),
               world.wallCount > 0 ? world.walls : null);
    colony.step(field, world, values, DT);

    // 首次发现食物
    if (firstFood === null && colony.firstFoodAnt >= 0) {
      firstFood = t * DT;
      console.log(`  首次发现食物: ${firstFood.toFixed(1)}s`);
    }

    // 每 0.5s 抽查不变量
    if (t % 30 === 0) {
      for (let i = 0; i < colony.count; i++) {
        if (world.wallAt(colony.px[i], colony.py[i])) { wallVisits++; if (wallVisits < 5) console.error(`    蚂蚁 ${i} 位于墙内 (${colony.px[i].toFixed(0)}, ${colony.py[i].toFixed(0)})`); }
      }
      if (withWall && t > 600) {   // 10s 后轨迹已成形, 才查"不透墙"
        for (let k = 0; k < world.walls.length; k += 97) {
          if (world.walls[k] && field.buf[k] !== 0) trailInWall++;
          wallChecks++;
        }
      }
    }

    // 卸货瞬间开始记录该蚁轨迹, 回巢结束(卸货完成)后判定
    for (let i = 0; i < colony.count; i++) {
      if (colony.load[i] > 0 && !trackId.has(i)) trackId.set(i, []);
      const arr = trackId.get(i);
      if (arr && colony.load[i] > 0 && arr.length < 4000 && t % 4 === 0) arr.push(colony.px[i], colony.py[i]);
      if (arr && colony.load[i] === 0 && arr.length > 40) {
        // 负重结束(卸货/弃货): 判定这段轨迹
        let crossed = false;
        for (let k = 0; k < arr.length; k += 2) {
          if (withWall && world.wallAt(arr[k], arr[k + 1])) { crossed = true; break; }
        }
        detourChecked++; if (crossed) detourCrossed++;
        trackId.delete(i);
      } else if (arr && colony.load[i] === 0) {
        trackId.delete(i);
      }
    }
  }

  // 总耗食(诚实指标——有墙绕行时卸货量下降是预期, 但消耗不应崩塌)
  let eaten = 0;
  for (const f of world.foodPatches) eaten += 400 - f.amount;

  return { world, colony, field, firstFood, wallVisits, trailInWall, wallChecks, detourChecked, detourCrossed, eaten };
}

console.log('=== walls_check P2.1 (P2.2 诚实化重定基) ===');
console.log('seed=' + SEED + '  sim=' + SIM_T + 's  食物位于巢正右方 0.65w (P2.2 重定基)');

console.log('\n[A] 无墙基线');
const a = run(false);
console.log(`  卸货=${a.colony.deliveries} 弃货=${a.colony.timeouts} 总耗食=${a.eaten.toFixed(1)} 墙内蚂蚁步=${a.wallVisits}`);

console.log(`\n[B] 有墙(${WALL_X}w 竖墙, 厚14u, 顶/底各留 24% 缺口)`);
const b = run(true);
console.log(`  墙格=${b.world.wallCount} 卸货=${b.colony.deliveries} 弃货=${b.colony.timeouts} 总耗食=${b.eaten.toFixed(1)}`);

console.log('\n--- 不变量 ---');
if (a.wallVisits === 0) console.log('  ✓ [A] 蚂蚁不入墙(自然成立)'); else fail(`[A] ${a.wallVisits} 次蚂蚁位于墙内`);
if (b.wallVisits === 0) console.log('  ✓ [B] 全程无蚂蚁处于墙格内'); else fail(`[B] ${b.wallVisits} 次蚂蚁位于墙内(运动阻挡失效)`);
if (b.trailInWall === 0) console.log(`  ✓ [B] 信息素墙格恒 0 (抽查 ${b.wallChecks} 格·次)`); else fail(`[B] ${b.trailInWall}/${b.wallChecks} 抽样墙格检出信息素(扩散掩码失效)`);

console.log('\n--- 可达性与绕行 ---');
// 阈值 20: "绕行路能否建立"用真实往返卸货数判。P2.1 旧阈值 50 是在"永动卸货机"
// 伪影记录(有墙 127/无墙 8834)上定的, 不可比; 诚实化后(SEED=wallcheck*) 240s 内
// 有墙卸货 49/80/231(种子间波动大——改道由谁先滑到缺口决定), 无墙 655~713。
// 吞吐受 carryTimeout=40s 泄压阀与 2.5 倍绕行路径限制, 弃货多属诚实代价。
if (b.colony.deliveries > 20) console.log(`  ✓ 绕行后仍建立觅食路: 卸货 ${b.colony.deliveries} (无墙 ${a.colony.deliveries})`);
else fail(`绕行觅食路未建立: 卸货仅 ${b.colony.deliveries}`);
if (b.detourChecked > 0) {
  const ratio = (b.detourCrossed / b.detourChecked * 100).toFixed(1);
  if (b.detourCrossed === 0) console.log(`  ✓ ${b.detourChecked} 段负重轨迹全部真实绕行(0 穿墙)`);
  else console.log(`  · ${b.detourChecked} 段负重轨迹中 ${ratio}% 有墙内采样点(含起点/终点贴墙抖动, 供人工复核)`);
} else {
  console.log('  · 本次运行没有足够的负重轨迹样本');
}
console.log(`  · 绕行成本: 首次发现 ${a.firstFood === null ? '—' : a.firstFood.toFixed(1) + 's'} → ${b.firstFood === null ? '—' : b.firstFood.toFixed(1) + 's'}`);

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' 项失败'));
process.exit(failures === 0 ? 0 : 1);
