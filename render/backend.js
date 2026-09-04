// 渲染后端接口：逻辑只管“我要画什么”，具体画由实现者决定。
// app 不需要知道是 WebGL2 还是 2D 兜底。

export class Backend {
  // 生命周期
  init(canvas) { throw new Error('not implemented'); }
  resize(w, h) { throw new Error('not implemented'); }
  destroy() {}

  // 相机：世界坐标的中心 + 缩放(像素/世界单位)
  setCamera(centerX, centerY, zoom) {}

  // 每帧刷新
  render(view) {
    // view = {
    //   field, foodPatches, nestX, nestY, nestRadius,
    //   colony, worldW, worldH
    // }
  }
}