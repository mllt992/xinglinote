import { useEffect, useRef, useState } from "react";
import { Bold, Code, Heading2, Italic, Link2, List, ListTodo, Quote, Strikethrough } from "lucide-react";
import type { EditorAction } from "../editor/markdown-editor";

const BUTTONS: Array<{ action: EditorAction; label: string; icon: React.ReactNode }> = [
  { action: "heading", label: "标题", icon: <Heading2 /> },
  { action: "bold", label: "粗体", icon: <Bold /> },
  { action: "italic", label: "斜体", icon: <Italic /> },
  { action: "strike", label: "删除线", icon: <Strikethrough /> },
  { action: "code", label: "行内代码", icon: <Code /> },
  { action: "bullet", label: "无序列表", icon: <List /> },
  { action: "task", label: "任务项", icon: <ListTodo /> },
  { action: "quote", label: "引用", icon: <Quote /> },
  { action: "wiki", label: "双链", icon: <Link2 /> },
];

/**
 * 手机上的格式工具条（设计 17 §3.8）。
 *
 * 手机没有 `Ctrl+B`，而 Markdown 标记要用系统键盘一个一个戳出来——`**` 得切到符号页按两下。
 * 不给这条工具条，窄屏上的「编辑」页基本只能打纯文本。
 *
 * 三个要点：
 * - **只在键盘真起来的时候出现**。平时它白占一行，还挡着正文。
 * - **按下不抢焦点**（`mousedown` 里 `preventDefault`），否则一点按钮键盘就收了，
 *   点一次要重新点回正文一次。
 * - 位置靠 `visualViewport` 算。iOS 上键盘不改变布局视口，光 `position: fixed; bottom: 0`
 *   会被键盘整个盖住；Android 上布局视口会缩，算出来的偏移正好是 0，同一套代码两边都对。
 */
export function EditorFormatBar({ onAction }: { onAction: (action: EditorAction) => void }) {
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  /** 键盘收起时的视口高度。用它当基线判断键盘起没起，比猜固定像素靠谱。 */
  const baseline = useRef(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      baseline.current = Math.max(baseline.current, vv.height);
      // 掉了一大截才算键盘起来了；小幅变化是地址栏收缩之类的动静
      const keyboard = baseline.current - vv.height > 120;
      setOffset(keyboard ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0);
      setOpen(keyboard && !!document.activeElement?.closest?.(".cm-content"));
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    // 焦点在别的输入框（标题、搜索）时不该冒出正文的格式工具条
    const refocus = () => window.setTimeout(sync, 0);
    document.addEventListener("focusin", refocus);
    document.addEventListener("focusout", refocus);
    // 转屏后基线要重算，否则横过来会一直以为键盘开着
    const reset = () => { baseline.current = 0; sync(); };
    window.addEventListener("orientationchange", reset);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      document.removeEventListener("focusin", refocus);
      document.removeEventListener("focusout", refocus);
      window.removeEventListener("orientationchange", reset);
    };
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-x-0 z-50 flex gap-1 overflow-x-auto border-t border-border bg-background px-2 py-1.5 shadow-[0_-6px_16px_rgb(0_0_0/.08)]"
      style={{ bottom: offset }}
      role="toolbar"
      aria-label="格式工具条"
    >
      {BUTTONS.map(button => (
        <button
          key={button.action}
          type="button"
          aria-label={button.label}
          title={button.label}
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground [&_svg]:size-4 active:bg-accent-ui active:text-foreground"
          onMouseDown={event => event.preventDefault()}
          onClick={() => onAction(button.action)}
        >
          {button.icon}
        </button>
      ))}
    </div>
  );
}
