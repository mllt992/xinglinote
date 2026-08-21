/**
 * 图片放大。
 *
 * 触发方有两个：预览里的 `<img>`（普通 React 事件）和编辑器里的图片小部件
 * （CodeMirror 的装饰层，拿不到 React 上下文）。为了不给小部件硬塞一条 props 通道，
 * 这里用一个模块级的单订阅：宿主挂载时登记，谁想放大就喊一嗓子。
 */
export type LightboxImage = { src: string; alt: string };

let listener: ((image: LightboxImage | null) => void) | null = null;

/** 宿主登记接收方。传 null 注销。同一时刻只允许一个宿主——放大层本来就只该有一层。 */
export function bindLightbox(fn: ((image: LightboxImage | null) => void) | null) {
  listener = fn;
}

export function openLightbox(src: string, alt = "") {
  if (src) listener?.({ src, alt });
}
