import { Component, type ComponentProps, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { MarkdownEditor } from "./markdown-editor";

type MarkdownEditorProps = ComponentProps<typeof MarkdownEditor>;

type BoundaryProps = Pick<MarkdownEditorProps, "value" | "onChange" | "onSave" | "resetKey" | "readOnly" | "className"> & {
  children: ReactNode;
};

type BoundaryState = {
  error: Error | null;
  componentStack: string;
};

/**
 * CodeMirror 和它的 Markdown 扩展都运行在同一棵 React 子树里。一篇异常复杂的正文即使只
 * 弄崩编辑器，也不该把导航、预览、保存状态和整页操作一起卸载。这里把故障限制在编辑框，
 * 并留下一个不依赖语法树、装饰器或第三方渲染器的 textarea 作为最后退路。
 */
class EditorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[星璃笔记] 增强编辑器出错，已切换到纯文本模式", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  componentDidUpdate(previous: BoundaryProps) {
    // 换篇后重新尝试增强编辑器。当前这篇仍保持降级，避免每次输入都重新触发同一个崩溃。
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: "" });
    }
  }

  private retry = () => this.setState({ error: null, componentStack: "" });

  private saveHotkey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      this.props.onSave?.();
    }
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const details = [error.stack || `${error.name}: ${error.message}`, componentStack.trim()].filter(Boolean).join("\n\nReact component stack:\n");
    return (
      <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border border-amber-500/30 bg-background", this.props.className)}>
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <p className="min-w-48 flex-1">
            增强编辑器遇到异常，已切换到纯文本模式；正文仍可编辑并保存。
          </p>
          <Button type="button" size="sm" variant="outline" onClick={this.retry}>
            <RotateCcw />重试增强编辑器
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(details)}>
            复制错误详情
          </Button>
        </div>
        <textarea
          className="min-h-0 flex-1 resize-none bg-transparent p-4 font-[var(--font-mono)] text-sm leading-6 outline-none"
          aria-label="笔记正文（纯文本安全模式）"
          value={this.props.value}
          readOnly={this.props.readOnly}
          onChange={event => this.props.onChange(event.target.value)}
          onKeyDown={this.saveHotkey}
          spellCheck
        />
      </div>
    );
  }
}

/** MarkdownEditor 的故障隔离外壳；正常路径不增加 DOM 层级。 */
export function ResilientMarkdownEditor(props: MarkdownEditorProps) {
  return (
    <EditorBoundary
      value={props.value}
      onChange={props.onChange}
      onSave={props.onSave}
      resetKey={props.resetKey}
      readOnly={props.readOnly}
      className={props.className}
    >
      <MarkdownEditor {...props} />
    </EditorBoundary>
  );
}
