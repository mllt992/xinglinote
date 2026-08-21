import { useEffect, useRef, useState } from "react";

/**
 * 值稳定 `delay` 毫秒后才跟上。
 *
 * 给「正文一变就要整篇重算」的那些地方用：分栏预览（markdown-it + DOMPurify + 公式与图）、
 * 右栏大纲（一次完整的 markdown-it parse）。不挡着就是每敲一个字全跑一遍，长笔记会掉帧。
 *
 * `resetKey` 变了就立刻跟上——换一篇笔记时右边不该还挂着上一篇的内容晃一下。
 */
export function useDebounced<T>(value: T, delay: number, resetKey?: unknown): T {
  const [settled, setSettled] = useState(value);
  const key = useRef(resetKey);
  useEffect(() => {
    if (key.current !== resetKey) { key.current = resetKey; setSettled(value); return; }
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay, resetKey]);
  return settled;
}
