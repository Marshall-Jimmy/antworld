// P2.4b · 录像导出: 把「主画布 + 检视覆盖层」合成成一条 webm。
//
// 为什么要自己合成一块画布, 不直接对主画布 captureStream():
//  跟拍的故事全靠覆盖层(面包屑、记忆航点链、事件标记)在讲, 只录主画布 = 录下一堆小黑点,
//  回头看不出刚才是哪一只蚂蚁的故事。合成层只在**录制期间**存在并每帧执行, 平时零成本。
//
// 为什么每帧 drawImage 能读到 WebGL 的画面(主画布并没有开 preserveDrawingBuffer):
//  WebGL 的 drawing buffer 在「本帧任务结束、送去合成」之后才被清空, 所以同一个 rAF 回调里
//  的 drawImage 仍然读得到内容。这就是 onFrame 末尾调 frame() 的原因——**不能**放到微任务/
//  setTimeout 里, 那样读到的就是空画布(这个坑和 P2.3.1「无 warn 不等于活着」是同一类: 静默空图)。
//
// captureStream(0) + requestFrame(): 显式按帧投喂, 视频帧率=真实渲染帧率。
// 用 captureStream(30) 的话浏览器会自己定时采样, 掉帧时录出来是「同一帧重复」的假流畅。
//
// ⚠ P2.4c 补(2026-09-05, 同一天): **帧数不许自己数自己**。在应用内浏览器(iab)里实测
//   「录 4.7s / 175 帧 / 0.0 MB」而落盘文件只有 110 字节——110 字节是一个只有 EBML 文件头、
//   一个 Cluster 都没有的空壳。旧代码错在两处, 都是 P2.3.1 那条病根的复发:
//     ① frames 计数在 drawImage 之后无条件 ++, 量的是「我们画了几次合成」而不是「编码器收进几帧」;
//        而 requestFrame 是否存在从来没被问过(它不存在时旧代码静默不投喂, 计数照加)。
//     ② 成败判据是「chunks 非空」, 而 blob 非空对一个空壳同样成立 ⇒ ok:true 是假的。
//   现在的三条硬规矩: (a) start 时问清楚有没有 requestFrame, 没有就退回 captureStream(30) 并把这个
//   选择写进读数(feedMode); (b) stop 时用「有画面的 webm 不可能小于 2 KiB」这条判失败,
//   失败就 console.warn + 不落盘(不制造 110 字节的假录像); (c) 字节数按档位印, 不许再出现"0.0 MB"。
//   注: 这条判据约束的是【导出是否真的成功】, 不约束画面质量——质量归 glare/glow 那几套。

export function recorderSupported() {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function pickMime() {
  const c = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of c) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

// 字节数读数: 110 字节印成「0.0 MB」就是撒谎, 所以按档位换单位并保留有效位。
export function sizeText(n) {
  if (!(n >= 0)) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export class Recorder {
  // sources: () => [canvas...] (按叠放顺序; 第一块决定尺寸)
  constructor(sources) {
    this.sources = sources;
    this.cv = document.createElement('canvas');
    this.g = this.cv.getContext('2d');
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.frames = 0;        // **编码器被投喂的帧数**: 只在真的 requestFrame() 之后才加
    this.drawn = 0;         // 合成画布被画过的次数(和 frames 不等就说明有一环没接上, 两者都印出来)
    this.lastError = '';
    this.mime = '';
    this.feedMode = '';     // 'requestFrame' | 'auto30'(见文件头 a)
  }

  get active() { return !!this.rec && this.rec.state !== 'inactive'; }

  _makeStream(fps) {
    const stream = this.cv.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    return { stream, track, canFeed: !!(track && typeof track.requestFrame === 'function') };
  }

  start() {
    if (this.active) return { ok: false, reason: '已经在录了' };
    if (!recorderSupported()) return { ok: false, reason: '这个浏览器不支持 MediaRecorder/captureStream' };
    const src = this.sources().filter(Boolean);
    if (!src.length) return { ok: false, reason: '找不到可录的画布' };
    const base = src[0];
    this.cv.width = base.width;
    this.cv.height = base.height;
    const mime = pickMime();
    if (!mime) return { ok: false, reason: '没有可用的 webm 编码器' };
    // 先要显式投喂(视频帧率=真实渲染帧率); 环境不支持 requestFrame 才退回定时采样兜底。
    let s = this._makeStream(0);
    this.feedMode = 'requestFrame';
    if (!s.canFeed) { s = this._makeStream(30); this.feedMode = 'auto30'; }
    this.stream = s.stream;
    this.track = s.track;
    this.canFeed = s.canFeed;
    try {
      this.rec = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch (err) {
      this.rec = new MediaRecorder(this.stream);
    }
    this.mime = this.rec.mimeType || mime;
    this.chunks = [];
    this.lastError = '';
    this.frames = 0;
    this.drawn = 0;
    this.startedAt = performance.now();
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onerror = (e) => { this.lastError = (e && e.error && e.error.name) || '录制出错'; this.abort(); };
    this.rec.start();       // 不给 timeslice: 停止时一次性交回整块 blob(几十秒的录像不需要分片)
    return { ok: true, mime: this.mime, feedMode: this.feedMode };
  }

  // onFrame 末尾调用(渲染完所有层之后)。不在录制时立刻返回, 一帧都不多做。
  frame() {
    if (!this.active) return;
    const src = this.sources();
    const base = src[0];
    if (!base) return;
    if (this.cv.width !== base.width || this.cv.height !== base.height) {
      this.cv.width = base.width; this.cv.height = base.height;   // 窗口改了尺寸: 下一帧起跟上新尺寸
    }
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.cv.width, this.cv.height);
    for (const c of src) if (c) this.g.drawImage(c, 0, 0);
    this.drawn++;
    // 投喂与计数绑在一起: 没投喂就不许记账(auto30 档由浏览器采样, 这一档不计数但会照画)。
    if (this.canFeed) { this.track.requestFrame(); this.frames++; }
  }

  abort() {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch (e) { /* 已经停了 */ }
    this.rec = null;
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    this.stream = null;
    this.track = null;
  }

  // 停止并落盘(浏览器下载)。返回 Promise<{ok, file?, bytes?, reason?, mime?, feedMode?, frames?, drawn?}>
  stop(meta = {}) {
    if (!this.active) return Promise.resolve({ ok: false, reason: '没有正在进行的录制' });
    const rec = this.rec;
    const secs = (performance.now() - this.startedAt) / 1000;
    const frames = this.frames;
    const drawn = this.drawn;
    const mime = this.mime;
    const feedMode = this.feedMode;
    return new Promise((resolve) => {
      const prev = rec.onstop;
      rec.onstop = (e) => {
        prev && prev(e);
        this.abort();
        const bytes = this.chunks.reduce((a, c) => a + c.size, 0);
        const fail = (reason) => {
          // 不许静默: 这是"看起来在录其实没录"唯一的现场证据。
          console.warn('[recorder] 录像没存成: ' + reason, { mime, feedMode, frames, drawn, secs: +secs.toFixed(2), bytes, chunks: this.chunks.length, lastError: this.lastError });
          resolve({ ok: false, reason, mime, feedMode, frames, drawn, secs, bytes });
        };
        if (!this.chunks.length) { fail('没录到任何数据(chunks=0)'); return; }
        // 有画面的 webm 不可能小于 2 KiB(实测空壳 = 110 B)。宁可报失败也不落一个假录像到磁盘上。
        if (bytes < 2048) { fail(`编码器只交了 ${bytes} 字节(只有文件头, 没有画面)`); return; }
        if (this.lastError) { fail(`编码器出错: ${this.lastError}`); return; }
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        const name = 'antworld-' + (meta.preset || 'scene') + '-' + (meta.seed || 'seed').slice(0, 8)
          + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.webm';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 让下载真的开始之后再释放, 否则某些浏览器会拿到一个已失效的 blob
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        resolve({ ok: true, file: name, bytes, secs, frames, drawn, mime, feedMode });
      };
      rec.stop();
    });
  }
}