// P2.4 个体路线记忆 验收台。
//
// 为什么必须自带一把"与机制无关"的保真尺子: memA 是机制自己的记忆, 拿它量"蚂蚁走不走熟路"
// 等于用结论证明结论。所以 checker 另记一份**每只蚁上一趟成功出门的实际折线**(纯观测, 不参与
// sim), 再量这一趟贴着它走多少——这才是 ANT_BIOLOGY §二 里 L. niger "开放场沿线保真 87.4%"
// 的同款测法。两组(K_mem 开/关)用同一把尺子, 数字才可比。
//
// 用法: node memory_check.mjs
//       SUB=identity,stable,night,abandon node memory_check.mjs   (分组跑, 全跑约 6 分钟)
//       SEED=xxx 换种子
import { values } from './core/config.js';
import { rng, hashSeed } from './core/rng.js';
import { Field } from './sim/fields.js';
import { World } from './sim/world.js';
import { Colony, MEM_WPTS } from './sim/colony.js';
import { Weather, weatherActive } from './core/weather.js';

const DEF = { ...values };
const DT = 1 / 60;
const SEED = process.env.SEED || 'memcheck';
const SUB = (process.env.SUB || 'identity,stable,night,abandon,weak').split(',').map((x) => x.trim()).filter(Boolean);
const BAND = 20;         // 保真判据: 离参考折线 ≤20 世界单位(=2.5 格)算"走在线上"
const SAMPLE_EVERY = 6;  // 每 6 步(0.1s)取一个观测点
const WATCH = 400;       // 只给前 400 只蚁装尺子(全群 5000 会拖慢 checker, 不影响结论)
const REF_MAX = 96;      // 参考折线最多存 96 个点

if (process.env.PARAMS) {
  for (const kv of process.env.PARAMS.split(',')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    DEF[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
}
let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function useParams(over) {
  for (const k in DEF) values[k] = DEF[k];
  if (over) for (const k in over) values[k] = over[k];
}
function makeSim(over, seed) {
  useParams(over);
  const world = new World(values.worldW, values.worldH, values.gridCell);
  const field = new Field(values.worldW, values.worldH, values.gridCell);
  world.addFood(values.worldW * 0.62, values.worldH * 0.62, 30, 1e9);   // 管饱单源
  const colony = new Colony(values.antCount, { rng: rng(hashSeed(seed || SEED)), world, nestRadius: values.nestRadius });
  return { world, field, colony, weather: new Weather(seed || SEED) };
}
function stepOnce(S) {
  const env = weatherActive(values) ? S.weather.step(DT, values) : null;
  const wash = env ? env.wash : 1;
  S.field.step(values.diffuseWeight, Math.pow(values.decayRate, DT * wash), null);
  S.colony.step(S.field, S.world, values, DT, null, env);
  return env;
}
function fieldPeak(S) { let m = 0; for (let i = 0; i < S.field.buf.length; i++) if (S.field.buf[i] > m) m = S.field.buf[i]; return m; }
function checksums(S, n) {
  const c = S.colony; let a = 0;
  for (let i = 0; i < n; i++) a += c.px[i] + c.py[i] + c.theta[i] + c.hx[i] + c.hy[i] + c.load[i];
  let f = 0; for (let i = 0; i < S.field.buf.length; i++) f += S.field.buf[i];
  return { a, f };
}

// ---------- 独立保真尺子 ----------
// ref[i] = 上一趟"从出巢到咬到食物"的实际折线(Float32 交替存 xy); cur[i] = 这一趟正在记的
function makeRuler() {
  return { ref: new Array(WATCH).fill(null), cur: new Array(WATCH).fill(null), armed: new Uint8Array(WATCH), hit: 0, tot: 0 };
}
function torus(S, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  const w = S.world.w, h = S.world.h, hw = w / 2, hh = h / 2;
  if (dx > hw) dx -= w; else if (dx < -hw) dx += w;
  if (dy > hh) dy -= h; else if (dy < -hh) dy += h;
  return [dx, dy];
}
// 注意必须按 poly.n(实际点数)截断: 早期版本按 poly.length 遍历, 尾部零填充变成一串
// (0,0) 点, 于是"最后一条真点 → 世界原点"这条假线段被当成参考线的一部分——它恰好穿过
// 巢与食源之间那条走廊, 谁走近都算"保真", 两组一起被刷到 87%。尺子坏了, 结论全废。
function distToPoly(S, poly, x, y) {
  if (!poly || poly.n < 4) return 1e9;
  let best = 1e9;
  for (let k = 0; k + 3 < poly.n; k += 2) {
    const vx = torus(S, poly[k], poly[k + 1], poly[k + 2], poly[k + 3]);
    const px = torus(S, poly[k], poly[k + 1], x, y);
    const L = vx[0] * vx[0] + vx[1] * vx[1];
    let t = L > 0 ? (px[0] * vx[0] + px[1] * vx[1]) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px[0] - vx[0] * t, dy = px[1] - vx[1] * t;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}
// 每步调用: 空手出巢的蚁往 cur 里加点(离上一点 ≥8 单位才加, 免得折线被噪声灌满);
// 咬到食物的瞬间把 cur 提交成 ref; 负重/返巢途中不记。
function rulerStep(S, R, st) {
  const c = S.colony;
  const out = c.forageTimeout || values.forageTimeout;
  for (let i = 0; i < WATCH; i++) {
    const loaded = c.load[i] > 0;
    if (loaded) {
      if (R.cur[i] && R.cur[i].n >= 4) R.ref[i] = R.cur[i];   // 这一趟真的走到了食物 → 成为参考线
      R.cur[i] = null; R.armed[i] = 0;
      continue;
    }
    const returning = out > 0 && c.forageT[i] > out;
    let dn = Math.hypot(...torus(S, S.world.nestX, S.world.nestY, c.px[i], c.py[i]));
    if (dn <= values.nestRadius) { R.armed[i] = 1; if (!returning) R.cur[i] = null; continue; }
    if (returning) { R.cur[i] = null; continue; }
    if (!R.armed[i]) continue;
    let cur = R.cur[i];
    if (!cur) { cur = R.cur[i] = new Float32Array(REF_MAX * 2); cur.n = 0; }
    if (cur.n === 0) { cur[0] = c.px[i]; cur[1] = c.py[i]; cur.n = 2; }
    else {
      const d = Math.hypot(...torus(S, cur[cur.n - 2], cur[cur.n - 1], c.px[i], c.py[i]));
      if (d >= 8) { if (cur.n < REF_MAX * 2) { cur[cur.n] = c.px[i]; cur[cur.n + 1] = c.py[i]; cur.n += 2; } }
    }
    // 量保真: 有参考线才量(成熟段才有), 每 SAMPLE_EVERY 步一个点
    if (R.ref[i] && st % SAMPLE_EVERY === 0) { R.tot++; if (distToPoly(S, R.ref[i], c.px[i], c.py[i]) <= BAND) R.hit++; }
  }
}
function fidelity(R) { return R.tot ? 100 * R.hit / R.tot : 0; }
function routeCoverage(S) {
  const c = S.colony; let n = 0;
  for (let i = 0; i < c.count; i++) if (c.memNA[i] > 0) n++;
  return 100 * n / c.count;
}
function meanRouteLen(S) {
  const c = S.colony; let n = 0, s = 0;
  for (let i = 0; i < c.count; i++) if (c.memNA[i] > 0) { n++; s += c.memLA[i]; }
  return n ? s / n : 0;
}

const T0 = Date.now();
console.log(`=== P2.4 个体路线记忆验收 (seed=${SEED}, 保真带=${BAND}单位) ===`);

// ---------------- ① 恒等回归 ----------------
if (SUB.includes('identity')) {
  console.log('\n--- ① 恒等回归(三组门控基线: dw=0.06 复现 P2.3.1 旧码 / 出厂关 dw=0.02 复现 P2.3.2 / K_route=0 复现 P2.3.2 出厂开) ---');
  // 本布局(单源管饱/seed=memcheck/3600 步)自己的关-门控常量基线。注意: 它**不是** perf_check 的
  // 285.069…——布局与种子都不同。对 P2.3.1 的逐位恒等由 perf_check 单独证明(见 METRICS)。
  // 旧的那两个数不是"跑一遍录下来"的自证——是用 `git worktree add _ant_p231 P2.3.1` 把 P2.3.1 的
  // 旧码(根本没有记忆机制)单独跑同一布局得到的: ants 8271063.288091577 / field 1791.47545048508
  // / del 1035 / to 0 / abort 312, 与新码 K_mem=0 逐位相同。
  //
  // ── P2.3.2 重定基(第 8 次, 2026-09-05) ──
  // diffuseWeight 出厂 0.06→0.02 是 **sim 参数**(由 ℓ=sqrt(D/λ)≤触角 解出的推导值), 校验和必然变。
  // 为了不让"换基线"退化成改考卷凑绿, 这里同时钉两组数, 而且**旧码那一组仍然留在考点上**:
  //   ①b0 把 dw 显式钉回 0.06, K_mem=0 必须逐位复现 P2.3.1 旧码的数 ⇒ 证明本轮只动了 dw 一个自由度;
  //   ①b1 出厂(dw=0.02)下 K_mem=0 必须逐位复现本轮重录的数。
  // REBASE=1 只打印当前出厂配置的全精度校验和供录入, 不参与判定、不改动任何阈值。
  const BASE_A = 8271063.288091577, BASE_F = 1791.47545048508;   // dw=0.06 门控值(P2.3.1 旧码实测)
  const NEW_A = 8363664.351490582, NEW_F = 1031.4224609786145;                                    // 出厂 dw=0.02 重录值(由 REBASE=1 打印后填入)
  // P2.3.2 出厂开(dw=0.02, K_mem=2, 当时还没有成熟度门)的全精度值, 由 REBASE=1 打印后录入。
  const P232_A = 8311038.489231705, P232_F = 1444.9635547870257;
  const run3600 = (over) => {
    const S = makeSim(over, "memcheck");
    for (let st = 0; st < 3600; st++) stepOnce(S);
    return checksums(S, values.antCount);
  };
  const old06 = run3600({ K_mem: 0, diffuseWeight: 0.06 });
  const off1 = run3600({ K_mem: 0 }), off2 = run3600({ K_mem: 0 }), on = run3600({ K_mem: 2 });
  if (process.env.REBASE) console.log('  REBASE 全精度关: ants ' + String(off1.a) + ' field ' + String(off1.f));
  if (process.env.REBASE) console.log('  REBASE 全精度开: ants ' + String(on.a) + ' field ' + String(on.f));
  console.log('  dw钉0.06(旧码基线): ants ' + old06.a.toFixed(6) + ' field ' + old06.f.toFixed(6));
  console.log('  出厂关(两次): ants ' + off1.a.toFixed(6) + ' / ' + off2.a.toFixed(6) + '  field ' + off1.f.toFixed(6) + ' / ' + off2.f.toFixed(6));
  console.log('  出厂开:       ants ' + on.a.toFixed(6) + '  field ' + on.f.toFixed(6));
  check('①a 同种子跑两次逐位相同(整条链路确定性)', Math.abs(off1.a - off2.a) < 1e-9 && Math.abs(off1.f - off2.f) < 1e-12, off1.a.toFixed(6));
  check('①b0 门控: dw 显式钉回 0.06 必须逐位复现 P2.3.1 旧码基线 ⇒ 本轮只动了 dw 一个自由度', Math.abs(old06.a - BASE_A) < 1e-6 && Math.abs(old06.f - BASE_F) < 1e-9, 'ants ' + old06.a.toFixed(9) + ' vs ' + BASE_A.toFixed(9) + ' | field ' + old06.f.toFixed(8) + ' vs ' + BASE_F.toFixed(8));
  check('①b1 出厂 dw=0.02 逐位复现本轮重录基线', Math.abs(off1.a - NEW_A) < 1e-6 && Math.abs(off1.f - NEW_F) < 1e-9, 'ants ' + off1.a.toFixed(6) + ' field ' + off1.f.toFixed(6));
  // ①b2: 门控出厂开之后, "复现 P2.3.2"这句话必须有一个显式的钉子撑着 —— 把新自由度钉回关。
  const on0 = run3600({ K_mem: 2, K_route: 0 });
  check('①b2 门控: K_route 钉回 0 必须逐位复现 P2.3.2 出厂开基线 ⇒ 成熟度门是新增自由度, 没把旧行为改坏', Math.abs(on0.a - P232_A) < 1e-9 && Math.abs(on0.f - P232_F) < 1e-9, 'ants ' + on0.a.toFixed(9) + ' vs ' + P232_A.toFixed(9) + ' | field ' + on0.f.toFixed(10) + ' vs ' + P232_F.toFixed(10));
  check('①c K_mem=2 必须破恒等(门控真的接上了)', Math.abs(on.a - off1.a) > 1e-6, '差 ' + (on.a - off1.a).toFixed(3));
}
// ---------------- ② 稳定单源: 保真↑ 且吞吐零成本 ----------------
if (SUB.includes('stable')) {
  console.log('\n--- ② 稳定单食源 240s (成熟段 120s 起量保真) ---');
  const out = {};
  for (const k of [0, 1, 2, 3]) {
    const S = makeSim({ K_mem: k }, 'stable');
    const R = makeRuler();
    const total = Math.round(240 / DT);
    for (let st = 0; st < total; st++) { stepOnce(S); if (st * DT >= 120) rulerStep(S, R, st); }
    out[k] = { del: S.colony.deliveries, fid: fidelity(R), cov: routeCoverage(S), len: meanRouteLen(S), peak: fieldPeak(S) };
    console.log(`  K_mem=${k}: del=${out[k].del} 保真=${out[k].fid.toFixed(1)}% 有路线蚁=${out[k].cov.toFixed(0)}% 平均路线长=${out[k].len.toFixed(0)} 场峰=${out[k].peak.toFixed(1)}`);
  }
  // 诚实交底(2026-09-05 实测): 稳定单源+5000 蚁下**纯信息素就已经给出 87.3% 的沿线保真**
  // (每只蚁自己的上一趟≈集体走廊), 正好等于真实 L. niger 的 87.4%。所以这里考的不是
  // "记忆能不能提高保真", 而是"记忆会不会帮倒忙": 份额制必须保证它不去盖一条本来更优的走廊。
  // 第一版无条件抢方向盘实测 del 40769→37038(−9.2%), 就是被这条判据拦下来的。
  check('②a 两组保真都达到真实蚁量级(≥70%, L. niger 实测 87.4%)', out[0].fid >= 70 && out[2].fid >= 70, `关 ${out[0].fid.toFixed(1)}% / 开 ${out[2].fid.toFixed(1)}%`);
  check('②b 强场下记忆不抢方向盘: 吞吐 ≥ 基线 97%(第一版在这里 −9.2% 被拦)', out[2].del >= out[0].del * 0.97, `${out[2].del} vs ${out[0].del} (${(100 * out[2].del / out[0].del).toFixed(1)}%)`);
  check('②c 成熟蚁群几乎人人身背一条路线(覆盖率 ≥ 80%)', out[2].cov >= 80, `${out[2].cov.toFixed(0)}%`);
  check('②d 私人路线长度合理(不绕: ≤ 巢–源直线距离 1.35 倍)', out[2].len <= 286 * 1.35, `${out[2].len.toFixed(0)} 单位 vs 直线 286`);
}

// 走廊横向离散度(纯观测, 与机制无关): 每只被观测的蚁取"上一趟成功出门的折线"里最接近
// 走廊中点的那个顶点, 量它离"巢—食源直线"的垂直距离, 再取中位数。
// 为什么量这个: 基线组全场只有一条集体走廊, 记忆组可能长出几千条互相平行的私人线——
// 离散度就是"私人线摊薄沉积"的直接读数, 也是第 2/3 个黎明记忆组倍率掉到 1.07×/0.82× 的
// 头号嫌疑。两组用同一把尺子(都读尺子的 ref, 不读 memA), 数字才可比。
function pathSpread(R, S) {
  const fp = S.world.foodPatches;
  if (!fp.length) return 0;
  let ax = fp[0].x - S.world.nestX, ay = fp[0].y - S.world.nestY;
  const al = Math.hypot(ax, ay) || 1;
  ax /= al; ay /= al;
  const acc = [];
  for (let i = 0; i < WATCH; i++) {
    const p = R.ref[i];
    if (!p || p.n < 6) continue;
    let best = 1e9, off = 0;
    for (let k = 0; k + 1 < p.n; k += 2) {
      const vx = p[k] - S.world.nestX, vy = p[k + 1] - S.world.nestY;
      const d = Math.abs(vx * ax + vy * ay - al * 0.5);
      if (d < best) { best = d; off = Math.abs(-vx * ay + vy * ax); }
    }
    if (best < al * 0.2) acc.push(off);
  }
  if (!acc.length) return 0;
  acc.sort((x, y) => x - y);
  return acc[acc.length >> 1];
}

// ---------------- ③ 昼夜循环: 正常玩法下没有可测红利(负结果), 红利只存在于⑤B ----------------
// 这一段是 P2.4 里被推翻重做两次的部分, 两次的病根都是"拿噪声当结论", 值得完整留在码里。
// 第一版主张 "信息素一夜挥发光, 天亮时记得路的蚁该先跑起来" → 判据 首黎明 40s 吞吐 ≥1.25×,
//   三种子实测 0.995× FAIL。当时的解释是"夜只把场压到峰 0.4~1.8, 走廊没断" —— 这个解释**也是错的**。
// 第二版于是人工在第二黎明把场硬清零, 想"制造"走廊消失 → 读出 6720× 和总账 1.443×。两个都是假的。
// 用三个变体查清(V0 不干预 / V1 第二黎明抹场 / V2 抹场同时把 misses 归零, 诊断台 _wipe2.mjs):
//   · 白天走廊峰 ~59, 每个黎明的走廊峰只有 ~1.2 → 走廊**每晚确实被彻底蒸发**(第一版的解释错了,
//     它把"绝对值还有 1.2"当成"还活着"; 衰减要写成**比值**, 这是教训 21)。
//   · 但群体在黎明后 30~60s 就能从零重新踩出走廊(峰 0.6→47)。第二黎明那一抹只抹掉残值 1.2,
//     等于没抹: **夜本身就是那把刀, 不需要人工干预**(V1 总账 92723→86140, 60s 内完全重建)。
//   · 顺带证伪了一个猜测: 不是 P1.9 的信任折扣(misses→trust 封底 0.1)把群体锁死的, V2 把
//     misses 全归零后曲线与 V1 同形。没有 bug 就不修。
//   · 6720× 的真凶是**上升沿上的相位差**: 天亮后吞吐是一条 35→291/s、跨约 60s 的陡坡, 抹场把
//     第三天早晨的陡坡整体推迟约 25s, 同一个 40s 窗口就从 164/s 读成 0/s。教训 20。
// 所以这一版: (1) 不做任何人工干预; (2) 判据一律落在**整段积分**上(晨间 120s 平均吞吐、
// 达到当日稳定吞吐一半的时刻、全天总账), 不在陡坡上取瞬时窗口; (3) **不再主张红利** ——
// 因为 ③b 这条前提自己就把红利天花板钉死了: 基线 30s 内就恢复半稳, 真空期只有约 30 秒。
// 负结果如实入库, 并给出量化的解释; "记忆什么时候真的有用"交给 ⑤B(集体通道被持续摘走: 2.05×)。
// 生物学落点(ANT_BIOLOGY §二/§三): 真实蚁群天亮第一波工蚁沿**已知路线**直达食源, 不靠当场随机
// 搜索。本模型里这一优势是存在的(晨峰 2.9 vs 0.4、弃航更少), 但因为集体走廊重建得太快, 它兑换不成
// 吞吐。这不是机制的失败, 是**本模拟的走廊重建速度**决定的: 想看到红利, 要么夜更长, 要么衰减更快。
if (SUB.includes('night')) {
  const SEEDS3 = ['night', 'nightB', 'nightC'];
  const DAWNS = [180, 420, 660];
  const RUN = 900;         // 跑到第三个白天结束(黎明 3 的后 240s 必须在窗内, 否则积分被截断)
  const MORN = 120;        // 出工窗口: 黎明后 120s
  const DAYW = 240;        // 一个"白天"的长度(黎明 → 下一个黎明)
  const BK = 10;           // 吞吐观测桶宽(秒): 用来定"达到半稳定吞吐的时刻", 不参与 sim
  const PS = 30;           // 场峰采样周期(秒): 白天平台峰取自这里
  const run3 = [];
  console.log('');
  console.log('--- ③ 昼夜 3 天 × 3 种子 (dayLength=240; 黎明=hour6 → t=180/420/660; 全程不做人工干预) ---');
  for (const sd of SEEDS3) {
    const one = {};
    for (const k of [0, 2]) {
      const S = makeSim({ K_mem: k, dayNight: 1, dayLength: 240 }, sd);
      const R = makeRuler();
      const nb = Math.round(RUN / BK);
      const cum = new Int32Array(nb);        // cum[q] = 第 q 个 10s 桶末的累计卸货(逐步覆盖即得)
      const pk = new Float64Array(Math.round(RUN / PS) + 1);
      const dawn = [0, 0, 0];                // 三个黎明的**当场**场峰(一夜衰减后的残值)
      const total = Math.round(RUN / DT);
      for (let st = 0; st <= total; st++) {
        stepOnce(S);
        const t = st * DT;
        if (t >= 120) rulerStep(S, R, st);
        const q = Math.min(nb - 1, Math.floor(t / BK));
        cum[q] = S.colony.deliveries;
        if (st % Math.round(PS / DT) === 0) pk[Math.round(t / PS)] = fieldPeak(S);
        for (let di = 0; di < 3; di++) if (Math.abs(t - DAWNS[di]) < DT * 0.5) dawn[di] = fieldPeak(S);
      }
      const rate = (q) => (cum[q] - (q > 0 ? cum[q - 1] : 0)) / BK;   // 该 10s 桶的平均 /s
      const integral = (a, n) => { let s = 0; for (let q = a; q < a + n; q++) s += rate(q); return s / n; };
      const dayPeak = (d) => {               // 当日平台峰: 黎明后 60~240s 的最大场峰
        let mx = 0;
        for (let i = Math.ceil((d + 60) / PS); i <= Math.floor((d + DAYW) / PS); i++) if (pk[i] > mx) mx = pk[i];
        return mx;
      };
      const m = []; const short = []; const t50 = []; const share = []; const ero = []; const pl = [];
      for (let di = 0; di < 3; di++) {
        const d = DAWNS[di], a = Math.round(d / BK), nM = Math.round(MORN / BK);
        m.push(integral(a, nM));
        short.push(integral(a, 3));                            // 首 30s: 只作诊断, 不当判据(见上)
        let p = 0; const de = Math.min(nb, a + Math.round(DAYW / BK));
        for (let q = a; q < de; q++) { const v = rate(q); if (v > p) p = v; }
        pl.push(p);
        let tt = DAYW; for (let q = a; q < de; q++) if (rate(q) >= p * 0.5) { tt = (q - a + 1) * BK; break; }
        t50.push(tt);
        share.push(p ? m[di] / p : 0);
        ero.push(dawn[di] ? dayPeak(d) / dawn[di] : 999);
      }
      one[k] = {
        m, short, t50, share, ero, pl, dawn,
        spr: pathSpread(R, S), fid: fidelity(R), cov: routeCoverage(S), len: meanRouteLen(S),
        all: S.colony.deliveries, ab: S.colony.aborts,
      };
      const f = one[k];
      console.log('  [' + sd + '] K_mem=' + k + ': 晨间120s ' + f.m.map((x) => x.toFixed(0)).join('/') + '/s | 首30s ' + f.short.map((x) => x.toFixed(0)).join('/') + '/s(诊断) | 达半稳定 ' + f.t50.map((x) => x.toFixed(0)).join('/') + 's | 晨/昼 ' + f.share.map((x) => x.toFixed(2)).join('/'));
      console.log('        走廊夜削 ' + f.ero.map((x) => x.toFixed(0)).join('/') + '× 晨峰 ' + f.dawn.map((x) => x.toFixed(1)).join('/') + ' | 保真 ' + f.fid.toFixed(1) + '% 覆盖 ' + f.cov.toFixed(0) + '% 路线长 ' + f.len.toFixed(0) + ' 离散度 ' + f.spr.toFixed(0) + ' | 总卸货 ' + f.all + ' 弃航 ' + f.ab);
    }
    const b = one[0], g = one[2];
    console.log('  [' + sd + '] 倍率: 晨间 ' + g.m.map((x, i) => (x / Math.max(1e-9, b.m[i])).toFixed(2)).join('/') + '× | 首30s ' + g.short.map((x, i) => (x / Math.max(1e-9, b.short[i])).toFixed(2)).join('/') + '×(诊断) | 达半稳定快 ' + g.t50.map((x, i) => (b.t50[i] - x).toFixed(0)).join('/') + 's | 总账 ' + (g.all / b.all).toFixed(3) + '× | 弃航 ' + (g.ab / Math.max(1, b.ab)).toFixed(2) + '×');
    run3.push(one);
  }
  const avg = (k, key) => run3.reduce((s, o) => s + o[k][key], 0) / run3.length;
  const avgv = (k, key, i) => run3.reduce((s, o) => s + o[k][key][i], 0) / run3.length;
  const j3 = (k, key, dg) => [0, 1, 2].map((i) => avgv(k, key, i).toFixed(dg)).join('/');
  const morn0 = [0, 1, 2].reduce((s, i) => s + avgv(0, 'm', i), 0) / 3;
  const morn2 = [0, 1, 2].reduce((s, i) => s + avgv(2, 'm', i), 0) / 3;
  const sh0 = [0, 1, 2].reduce((s, i) => s + avgv(0, 'short', i), 0) / 3;
  const sh2 = [0, 1, 2].reduce((s, i) => s + avgv(2, 'short', i), 0) / 3;
  const t500 = [0, 1, 2].reduce((s, i) => s + avgv(0, 't50', i), 0) / 3;
  const t502 = [0, 1, 2].reduce((s, i) => s + avgv(2, 't50', i), 0) / 3;
  const eroMin = Math.min(...[0, 1, 2].map((i) => avgv(0, 'ero', i)));
  // ③a/③b 的布尔判据吃的是**逐种子原始值里的最坏者**, 可明细行原先只印三种子均值 ⇒ 会出现
  // "明细看着挺好、判据却红了"的自我误导(实测: ③b 均值 17s, 判据真正吃到的值是某个种子的 70s)。
  // 下面只把判据实际吃到的那个数也打印出来, 阈值一个字都不改。
  const dawnMax = Math.max(...run3.flatMap((o) => o[0].dawn));
  const t50Max = Math.max(...run3.flatMap((o) => o[0].t50));
  const K0 = avg(0, 'all'), K2 = avg(2, 'all');
  const tot0 = run3.map((o) => o[0].all);
  const spread0 = (Math.max(...tot0) - Math.min(...tot0)) / (K0 || 1);
  console.log('  均值: 晨间 ' + j3(0, 'm', 0) + ' → ' + j3(2, 'm', 0) + '/s = ' + (morn2 / morn0).toFixed(3) + '× | 首30s = ' + (sh2 / sh0).toFixed(3) + '× | 达半稳定 ' + t500.toFixed(0) + '→' + t502.toFixed(0) + 's');
  console.log('        总账 ' + (K2 / K0).toFixed(3) + '× (K0 ' + K0.toFixed(0) + ' vs K2 ' + K2.toFixed(0) + ', 基线自身跨种子极差 ' + (spread0 * 100).toFixed(1) + '%) | 弃航 ' + avg(0, 'ab').toFixed(0) + '→' + avg(2, 'ab').toFixed(0) + ' | 保真 ' + avg(0, 'fid').toFixed(1) + '→' + avg(2, 'fid').toFixed(1) + '%');
  console.log('  [负结果·如实入库] 正常昼夜玩法下记忆**没有可宣称的吞吐红利**: 总账 ' + (K2 / K0).toFixed(3) + '× 晨间 ' + (morn2 / morn0).toFixed(3) + '× —— 机制解释见 ③b: 基线在黎明后 ' + t500.toFixed(0) + 's 就恢复半稳, 集体通道的真空期只有约 ' + (t500 - 10).toFixed(0) + 's, 兑换不出收益; 红利要在集体通道被持续摘走时才出现(⑤B 2.05×)。');
  check('③a 前提1: 夜里集体走廊确实被蒸发(黎明场峰 ≤ 当日平台峰的 1/5) —— 同时推翻上一轮"峰还有 1.2 就是没断"的误判(衰减要按比值判)',
    eroMin >= 5 && Math.max(...run3.flatMap((o) => o[0].dawn)) < 10,
    '基线夜削 ' + j3(0, 'ero', 0) + '× (最小 ' + eroMin.toFixed(0) + '×) | 晨峰·判据取最坏 ' + dawnMax.toFixed(1) + ' (均值 ' + j3(0, 'dawn', 1) + ') | 记忆组均值晨峰 ' + j3(2, 'dawn', 1));
  check('③b 前提2=红利天花板: 基线(纯信息素)在黎明后 ≤60s 就达到当日稳定吞吐的一半 → 正常玩法下记忆**不可能**有显著红利, 本段无权主张收益',
    t50Max <= 60, '基线达半稳定·判据取最坏 ' + t50Max.toFixed(0) + 's (均值 ' + t500.toFixed(0) + 's, 三种子 ' + j3(0, 't50', 0) + 's) | 记忆组 ' + j3(2, 't50', 0) + 's');
  check('③c 不伤害·全天: 三个白天总账(三种子均值) ≥ 基线 0.98 倍 —— 只判不亏; 收益一律不予宣称(基线自身跨种子极差 ' + (spread0 * 100).toFixed(1) + '%)',
    K2 >= K0 * 0.98, K2.toFixed(0) + ' vs ' + K0.toFixed(0) + ' (' + (100 * K2 / K0).toFixed(1) + '%) | 每种子 ' + run3.map((o) => (o[2].all / o[0].all).toFixed(3)).join('/') + '×');
  check('③d 不伤害·清晨: 晨间 120s 平均吞吐(三种子均值) ≥ 基线 0.95 倍 —— 若记忆在最该帮它的时段反而拖慢, 说明双通道份额制失灵',
    morn2 >= morn0 * 0.95, '逐黎明 ' + [0, 1, 2].map((i) => (avgv(2, 'm', i) / Math.max(1e-9, avgv(0, 'm', i))).toFixed(2)).join('/') + '× 合计 ' + (morn2 / morn0).toFixed(3) + '× (' + morn0.toFixed(0) + '→' + morn2.toFixed(0) + '/s) | 每种子 ' + run3.map((o) => ((o[2].m[0] + o[2].m[1] + o[2].m[2]) / Math.max(1, o[0].m[0] + o[0].m[1] + o[0].m[2])).toFixed(3)).join('/') + '×');
  check('③e 沿线保真: 两组都 ≥80%(ANT_BIOLOGY §二 L. niger 开放场 87.4% 同量级), 且记忆组不低于基线 95%',
    avg(0, 'fid') >= 80 && avg(2, 'fid') >= avg(0, 'fid') * 0.95, '基线 ' + avg(0, 'fid').toFixed(1) + '% vs 记忆 ' + avg(2, 'fid').toFixed(1) + '%');
  check('③f 不增加空手而归: 弃航次数均值 ≤ 基线 1.05 倍', avg(2, 'ab') <= avg(0, 'ab') * 1.05,
    '每种子 ' + run3.map((o) => (o[2].ab / Math.max(1, o[0].ab)).toFixed(2)).join('/') + '× 均值 ' + avg(0, 'ab').toFixed(0) + '→' + avg(2, 'ab').toFixed(0));
  check('③g 路线质量: 覆盖率 ≥80% 且平均路线长 ≤ 巢–源直线(226) 的 1.15 倍 —— 记住的必须是近路, 不是绕远的私人弯路',
    avg(2, 'cov') >= 80 && avg(2, 'len') <= 226 * 1.15, '覆盖率 ' + avg(2, 'cov').toFixed(0) + '% | 路线长 ' + avg(2, 'len').toFixed(0) + ' (几何下限 226)');
  check('③h 没有把走廊走散: 记忆组路线离散度 ≤ 基线 2 倍("私人路线摊薄集体走廊"的旧假设已在 ② 否证)',
    avg(2, 'spr') <= avg(0, 'spr') * 2, '离散度 基线 ' + avg(0, 'spr').toFixed(0) + ' vs 记忆 ' + avg(2, 'spr').toFixed(0) + ' 世界单位');
}
// ---------------- ④ 食源消失: 路线要废弃 ----------------
if (SUB.includes('abandon')) {
  console.log('\n--- ④ 建成 200s 后撤掉食源 → 路线必须废弃(不能走到死) ---');
  const S = makeSim({ K_mem: 2 }, 'abandon');
  for (let st = 0; st < 200 / DT; st++) stepOnce(S);
  const cov0 = routeCoverage(S);
  S.world.removeFood(0);
  let cov1 = 0, cov2 = 0;
  for (let st = 0; st < 300 / DT; st++) { stepOnce(S); if (st === Math.round(120 / DT)) cov1 = routeCoverage(S); }
  cov2 = routeCoverage(S);
  console.log(`  覆盖率: 建成 ${cov0.toFixed(0)}% → 撤源后120s ${cov1.toFixed(0)}% → 300s ${cov2.toFixed(0)}% | 扑空 ${S.colony.aborts} 弃货 ${S.colony.timeouts}`);
  check('④a 建成期确实人人有路线', cov0 >= 80, `${cov0.toFixed(0)}%`);
  check('④b 撤源后路线被废弃(覆盖率 ≤ 建成期的一半)', cov2 <= cov0 * 0.5, `${cov2.toFixed(0)}% vs ${cov0.toFixed(0)}%`);
  check('④c 废弃过程靠扑空计数, 不靠抹场(蚁群仍在跑)', S.colony.aborts > 0 && S.colony.deliveries > 0, `abort=${S.colony.aborts}`);
}

// ---------------- ⑤ 摘掉集体通道: 记忆是唯一的定向来源 ----------------
// 这一组最初写的是"400 蚁新群 300s 弱场, 记忆应提高 ≥1.5 倍吞吐", 实测 0.91× 不成立。
// 查下来是**场景没造出条件**: 400 蚁跑到 300s 场峰仍有 5, 走廊其实早就建成了, 集体通道没断,
// 记忆无事可做——不是机制的错, 是考卷出错了。改成把集体通道真的摘掉, 分两个窗口量(单变量, 与
// P2.3.1 同法): 窗口A 抹一次就让它自己长回来(= 一场暴雨之后的自然恢复); 窗口B 每步压平、场峰
// 恒为 0(= 集体通道被整个摘走, 定向信息只剩每只蚁自己那条 A)。只有窗口B 才是"记忆 vs 无记忆"
// 的干净对照, 判据压在 B 上;A 如实报数不判绿——它量到的是"群体重新踩网的快慢", 本来就不该记在记忆头上。
if (SUB.includes('weak')) {
  // P2.3.3 量具升级(改的是尺子不是机制): ⑤ 原来只有 weak 一个种子, 而 §7 早就写明"⑤ 的建成期读数
  // 是单种子观察, 够不上结论"。现在三种子各跑一遍, 判据一律取最坏种子(与 ③a/③b 同一写法),
  // 每个种子的原始行照常打印。顺序要紧: 先在上游门控关闭(K_route=0)下用这把新尺子把债量实,
  // 再用同一把尺子选门槛值 —— 尺子和结论不能同时改, 否则又一次说不清归因。
  console.log('\n--- ⑤ 400 蚁小群 × 3 种子: 建成 240s → 窗口A 抹一次 60s → 窗口B 每步压平 45s ---');
  const SEEDS_W = ['weak', 'weakB', 'weakC'];
  const out = {};
  const winFid = (R, h0, t0) => (R.tot > t0 ? 100 * (R.hit - h0) / (R.tot - t0) : 0);
  for (const sd of SEEDS_W) {
    out[sd] = {};
    for (const k of [0, 1, 2, 3]) {
      const S = makeSim({ K_mem: k, antCount: 400 }, sd);
      const R = makeRuler();
      let st = 0, d0 = 0, h0 = 0, t0 = 0;
      for (; st < 240 / DT; st++) { stepOnce(S); if (st * DT >= 150) rulerStep(S, R, st); }
      const pre = { del: S.colony.deliveries, fid: fidelity(R), cov: routeCoverage(S), len: meanRouteLen(S), peak: fieldPeak(S) };
      S.field.clear();
      d0 = S.colony.deliveries; h0 = R.hit; t0 = R.tot;
      for (; st < 300 / DT; st++) { stepOnce(S); rulerStep(S, R, st); }
      const wash = { del: S.colony.deliveries - d0, fid: winFid(R, h0, t0), peak: fieldPeak(S) };
      d0 = S.colony.deliveries; h0 = R.hit; t0 = R.tot;
      const abort0 = S.colony.aborts;
      for (; st < 345 / DT; st++) { stepOnce(S); S.field.clear(); rulerStep(S, R, st); }
      out[sd][k] = { pre, wash, flat: { del: S.colony.deliveries - d0, fid: winFid(R, h0, t0), abort: S.colony.aborts - abort0 } };
      console.log('  [' + sd + '] K_mem=' + k + ': 建成 del=' + pre.del + ' 保真=' + pre.fid.toFixed(1) + '% 路线长=' +
        pre.len.toFixed(0) + ' 有路线蚁=' + pre.cov.toFixed(0) + '% 场峰=' + pre.peak.toFixed(2) +
        ' | A抹一次60s del=' + wash.del + ' 保真=' + wash.fid.toFixed(1) + '% 场峰回=' + wash.peak.toFixed(1) +
        ' | B压平45s del=' + out[sd][k].flat.del + '(' + (out[sd][k].flat.del / 45).toFixed(2) + '/s) 保真=' +
        out[sd][k].flat.fid.toFixed(1) + '% 弃航=' + out[sd][k].flat.abort);
    }
  }
  // 逐种子算出四条比值, 再按最坏种子下判 —— 与 ③a/③b 的取最坏同一写法。
  const M = SEEDS_W.map((sd) => ({
    sd,
    d: out[sd][2].pre.del / Math.max(1, out[sd][0].pre.del),
    a: out[sd][2].flat.del / Math.max(1, out[sd][0].flat.del),
    b: out[sd][2].flat.fid / Math.max(1, out[sd][0].flat.fid),
    e: out[sd][0].flat.abort / Math.max(1, out[sd][2].flat.abort),
    cOk: out[sd][1].flat.del <= out[sd][2].flat.del + 1e-9 && out[sd][2].flat.del <= out[sd][3].flat.del + 1e-9,
    eOk: out[sd][2].flat.abort <= out[sd][0].flat.abort
  }));
  const worst = (key) => M.reduce((x, y) => (y[key] < x[key] ? y : x));
  const wD = worst('d'), wA = worst('a'), wB = worst('b'), wE = worst('e');
  console.log('  逐种子 ⑤d建成 ' + M.map((m) => m.sd + ' ' + (100 * m.d).toFixed(1) + '%').join(' | ') +
    ' | 判据取最坏 ' + (100 * wD.d).toFixed(1) + '% (' + wD.sd + ')');
  console.log('  逐种子 ⑤a压平 ' + M.map((m) => m.a.toFixed(2) + '×').join(' | ') +
    ' | 判据取最坏 ' + wA.a.toFixed(2) + '× (' + wA.sd + ')');
  check('⑤a 压平期记忆组吞吐 ≥ 基线 1.5 倍(集体通道归零时记忆接管, 三种子取最坏)', wA.a >= 1.5,
    '最坏 ' + wA.sd + ': 开 ' + out[wA.sd][2].flat.del + ' vs 关 ' + out[wA.sd][0].flat.del + ' (' + wA.a.toFixed(2) + '×)');
  check('⑤b 压平期记忆组沿线保真 ≥ 基线 1.2 倍(靠记得的路, 不是靠重新踩网, 三种子取最坏)', wB.b >= 1.2,
    '最坏 ' + wB.sd + ': ' + out[wB.sd][2].flat.fid.toFixed(1) + '% vs ' + out[wB.sd][0].flat.fid.toFixed(1) + '%');
  check('⑤c 权重越大越敢用记忆: 压平期吞吐 1≤2≤3 不下降(三种子全部)', M.every((m) => m.cOk),
    M.map((m) => m.sd + ' ' + out[m.sd][1].flat.del + '≤' + out[m.sd][2].flat.del + '≤' + out[m.sd][3].flat.del).join(' | '));
  check('⑤d 建成期记忆不帮倒忙(集体通道还在: 吞吐 ≥ 基线 95%, 三种子取最坏)', wD.d >= 0.95,
    '最坏 ' + wD.sd + ': ' + out[wD.sd][2].pre.del + ' vs ' + out[wD.sd][0].pre.del + ' (' + (100 * wD.d).toFixed(1) + '%)');
  check('⑤e 压平期记忆组方向感更强: 弃航次数 ≤ 基线(不必重新试探, 三种子全部)', M.every((m) => m.eOk),
    '最不利 ' + wE.sd + ': 开 ' + out[wE.sd][2].flat.abort + ' vs 关 ' + out[wE.sd][0].flat.abort);
}

console.log(`\n=== ${pass + fail} 项断言, ${pass} PASS / ${fail} FAIL ===  耗时 ${((Date.now() - T0) / 1000).toFixed(0)}s`);
process.exit(fail ? 1 : 0);
