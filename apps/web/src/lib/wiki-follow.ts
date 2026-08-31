/** 预览里跟随双链：从事件目标找到 [data-wiki]，解码标题。 */
const DRAG_PX = 6;

export function wikiElementFromTarget(target: EventTarget | null): HTMLElement | null {
  const node = target instanceof Node ? target : null;
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest("[data-wiki]") ?? null;
}

export function decodeWikiAttr(value: string | undefined): string {
  if (!value) return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

export function wikiRefFromElement(el: HTMLElement): { title: string; section?: string } | null {
  const title = decodeWikiAttr(el.dataset.wiki);
  if (!title) return null;
  const section = el.dataset.wikiSection ? decodeWikiAttr(el.dataset.wikiSection) : "";
  return { title, section: section || undefined };
}

export function pointerDragged(from: { x: number; y: number }, to: { x: number; y: number }, threshold = DRAG_PX) {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}
