// 固定步长累加器:逻辑步长固定 STEP,渲染每帧一次。
// 逻辑与渲染解耦,支持 1/8 / 64 倍速(仅改变推进速度,不改变步长本身)。

export class Loop {
  constructor({ step = 1 / 60, onStep, onFrame }) {
    this.step = step;         // 固定逻辑步长(秒)
    this.onStep = onStep;     // called once per fixed step
    this.onFrame = onFrame;   // called once per rAF
    this.timeScale = 1.0;     // 1/8 / 1 / 4 / 64 ...
    this.accum = 0;
    this.last = 0;
    this.stepsDone = 0;
    this.fps = 0;             // 单帧渲染调用数/tps
    this.running = false;
    this._raf = 0;
  }

  start() {
    this.running = true;
    this.last = performance.now();
    this._tick = this._tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  setSpeed(x) { this.timeScale = x; }

  _tick(now) {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05; // 失焦后回来别把累积步长一次跑爆

    this.accum += dt * this.timeScale;
    const maxSteps = 240; // 一次最多推进的步数,防止 64x 卡爆
    let guard = 0;
    while (this.accum >= this.step && guard < maxSteps) {
      this.onStep(this.step);
      this.accum -= this.step;
      this.stepsDone++;
      guard++;
    }
    if (guard >= maxSteps) this.accum = 0; // 掉帧太多就丢包袱

    this.onFrame(dt);
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    this._raf = requestAnimationFrame(this._tick);
  }
}