// 可播种 PRNG。全项目禁止直接用 Math.random。

// mulberry32：快、简单、可播种、分布尚可。状态是单个 uint32。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 把任意字符串稳定地变成种子数
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// 包一层:返回的 rng 带 state 属性和额外方法
export function rng(seed) {
  const next = mulberry32(seed);
  next.state = seed >>> 0;
  next.gaussian = function gaussian() {
    // Box-Muller
    const u1 = Math.max(next(), 1e-12);
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  next.range = function range(lo, hi) { return lo + (hi - lo) * next(); };
  next.sign = function sign() { return next() < 0.5 ? -1 : 1; };
  return next;
}

export function randomSeed() {
  return (Math.floor(Math.random() * 1e9) + ((Math.random() * 1e9) | 0));
}