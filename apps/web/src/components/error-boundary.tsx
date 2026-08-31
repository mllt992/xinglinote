/**
 * 渲染期兜底。没有它的话，React 18 遇到未捕获异常会把整棵树卸载掉——
 * 用户看到的是一张纯白页面，控制台之外不留任何线索，报障时只能说「偶尔白屏」。
 *
 * 这里的目标不是「优雅降级」，而是**让错误说得出名字**：把 message 和组件栈摆在页面上，
 * 用户截个图就够定位。所以不做自动重试、不做静默恢复——那只会把问题藏得更深。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null; stack: string };

export function errorDetails(error: Error, componentStack = ""): string {
  const runtimeStack = error.stack || `${error.name}: ${error.message}`;
  const reactStack = componentStack.trim();
  return reactStack ? `${runtimeStack}\n\nReact component stack:\n${reactStack}` : runtimeStack;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 留一份在控制台：有 source map 时这里才看得到真实文件行号。
    console.error("[星璃笔记] 渲染出错", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const details = errorDetails(error, stack);

    return (
      <div className="grid min-h-full place-items-center bg-background p-6">
        <div className="w-full max-w-xl space-y-4">
          <div>
            <h1 className="font-[var(--font-title)] text-2xl font-semibold tracking-[-.03em]">这个页面崩了</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              页面渲染时抛了异常。你的笔记没有丢——正文都在服务端，刷新即可继续。
            </p>
          </div>

          {/* 报障时把下面这段发出来就能定位，不用再复现 */}
          <div className="rounded-xl border border-border bg-muted/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">错误信息</p>
            <p className="mt-1 break-words font-[var(--font-mono)] text-sm text-destructive">
              {error.name}: {error.message}
            </p>
            {details && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">调用栈与组件栈</summary>
                <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words font-[var(--font-mono)] text-[11px] leading-relaxed text-muted-foreground">
                  {details}
                </pre>
              </details>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => window.location.reload()}>重新加载</Button>
            <Button variant="ghost" onClick={() => { window.location.href = "/"; }}>回到首页</Button>
            <Button
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(details)}
            >
              复制错误详情
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
