/**
 * 编辑器光标 / 滚动位置的会话内记忆（issue #39）。
 *
 * 只活在这一次会话里，不进 localStorage：偏移按字符记，MCP / AI / 恢复历史
 * 都会在别处改正文，存到下次打开就是错位。
 *
 * Tab（编辑/预览/分栏）或浏览器把编辑器藏成 display:none 时，浏览器会先把
 * scrollTop 清成 0，再轮到 React effect cleanup——此时不能把假 0 盖掉真位置。
 */
import type { EditorView } from "@codemirror/view";

const spots = new Map<string, { anchor: number; head: number; top: number }>();
const SPOT_LIMIT = 60;

export function rememberSpot(key: string, view: EditorView) {
  if (!key) return;
  const { anchor, head } = view.state.selection.main;
  const measured = view.scrollDOM.scrollTop;
  const prev = spots.get(key);
  const hidden = !view.dom.isConnected || view.scrollDOM.clientHeight < 8;
  const top = measured === 0 && prev && prev.top > 0 && hidden ? prev.top : measured;
  spots.delete(key);
  spots.set(key, { anchor, head, top });
  while (spots.size > SPOT_LIMIT) spots.delete(spots.keys().next().value!);
}

export function restoreSpot(key: string, view: EditorView) {
  if (!key) return;
  const spot = spots.get(key);
  if (!spot || view.scrollDOM.clientHeight < 8) return;
  if (Math.abs(view.scrollDOM.scrollTop - spot.top) > 1) view.scrollDOM.scrollTop = spot.top;
}

export function readSpot(key: string) {
  return key ? spots.get(key) : undefined;
}

/** 在滚动容器上挂持续记忆 + 从 hidden 恢复；返回清理函数。 */
export function attachSpotPersistence(key: string, view: EditorView): () => void {
  const onScroll = () => rememberSpot(key, view);
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

  let wasHidden = view.scrollDOM.clientHeight < 8;
  const onResize = () => {
    const hidden = view.scrollDOM.clientHeight < 8;
    if (wasHidden && !hidden) restoreSpot(key, view);
    else if (!hidden) rememberSpot(key, view);
    wasHidden = hidden;
  };
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(view.scrollDOM);

  const onVisibility = () => {
    if (document.visibilityState === "hidden") rememberSpot(key, view);
    else restoreSpot(key, view);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    view.scrollDOM.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    resizeObserver?.disconnect();
    rememberSpot(key, view);
  };
}
