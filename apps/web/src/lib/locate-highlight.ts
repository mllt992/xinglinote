let clearTimer: number | null = null;

/** 滚到定位目标并给一个短暂脉冲；不借用文本选区，因此不会改变编辑器渲染状态。 */
export function pulseLocatedElement(element: HTMLElement) {
  document.querySelectorAll(".note-locate-pulse").forEach(item => item.classList.remove("note-locate-pulse"));
  if (clearTimer !== null) window.clearTimeout(clearTimer);
  element.classList.add("note-locate-pulse");
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  clearTimer = window.setTimeout(() => {
    element.classList.remove("note-locate-pulse");
    clearTimer = null;
  }, 1800);
}
