import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./alert-dialog";

export type ConfirmOptions = {
  title: string;
  /** 写清对象和后果，不要只写「确定吗」。 */
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  /** 要求逐字输入这段文字才放行，用于删除工作区这类不可回退的操作。 */
  requireText?: string;
  requireTextLabel?: string;
};

export type PromptOptions = {
  title: string;
  description?: React.ReactNode;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  autoComplete?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  /** 默认空串视为没填、确认按钮禁用；「留空即取消密码」这类场景要打开。 */
  allowEmpty?: boolean;
};

type Pending = { kind: "confirm"; options: ConfirmOptions } | { kind: "prompt"; options: PromptOptions };
type Settled = boolean | string | null;

type Api = {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  /** 取消返回 null，确认返回输入内容（allowEmpty 时可能是空串）。 */
  prompt: (o: PromptOptions) => Promise<string | null>;
};

const ConfirmContext = React.createContext<Api | null>(null);

/**
 * 应用内确认与输入。规范禁止用浏览器原生 confirm() / prompt() / alert() 承载业务交互，
 * 这里把它们收敛成两个 Promise API，调用处写起来和原生一样短，但走统一的 AlertDialog。
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const resolver = React.useRef<((v: Settled) => void) | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Radix 关闭后会把焦点还给 <AlertDialog.Trigger>，而我们是代码里直接开的，没有 Trigger，
   *  所以自己记下打开前的焦点，关闭时还回去（元素已被卸载就放弃，别乱抢）。 */
  const opener = React.useRef<HTMLElement | null>(null);

  /**
   * 关闭路径不止一条（按钮、Esc、遮罩），用 ref 保证只结算一次。
   * 这里只翻 open，不清 pending：内容要留在树里让 Radix 自己走关闭流程，
   * 焦点才会回到触发按钮上。
   */
  const settle = React.useCallback((v: Settled) => {
    const r = resolver.current;
    resolver.current = null;
    setOpen(false);
    r?.(v);
  }, []);

  /**
   * 从菜单项里开弹窗时，菜单项马上就会被卸载，关闭后没法还焦点。
   * 这时往上找到这个菜单的触发按钮（Radix 用 aria-controls 关联），把焦点还给它。
   */
  const captureOpener = () => {
    const active = document.activeElement as HTMLElement | null;
    const menu = active?.closest('[role="menu"]') as HTMLElement | null;
    const trigger = menu?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) : null;
    opener.current = trigger ?? active;
  };

  const api = React.useMemo<Api>(() => ({
    confirm: o => new Promise<boolean>(resolve => {
      resolver.current = resolve as (v: Settled) => void;
      captureOpener();
      setValue("");
      setPending({ kind: "confirm", options: o });
      setOpen(true);
    }),
    prompt: o => new Promise<string | null>(resolve => {
      resolver.current = resolve as (v: Settled) => void;
      captureOpener();
      setValue(o.defaultValue ?? "");
      setPending({ kind: "prompt", options: o });
      setOpen(true);
    }),
  }), []);

  const isPrompt = pending?.kind === "prompt";
  const requireText = pending?.kind === "confirm" ? pending.options.requireText : undefined;
  const hasInput = isPrompt || !!requireText;
  const ready = pending?.kind === "prompt"
    ? (pending.options.allowEmpty === true || value.trim().length > 0)
    : !requireText || value.trim() === requireText.trim();

  return <ConfirmContext.Provider value={api}>
    {children}
    <AlertDialog open={open} onOpenChange={next => { if (!next) settle(isPrompt ? null : false); }}>
      {pending && <AlertDialogContent
        onOpenAutoFocus={e => { if (hasInput) { e.preventDefault(); inputRef.current?.focus(); } }}
        onCloseAutoFocus={e => { const el = opener.current; if (el && document.contains(el)) { e.preventDefault(); el.focus(); } }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{pending.options.title}</AlertDialogTitle>
          <AlertDialogDescription className={pending.options.description ? undefined : "sr-only"}>{pending.options.description ?? pending.options.title}</AlertDialogDescription>
        </AlertDialogHeader>
        <form className="grid gap-4" onSubmit={e => { e.preventDefault(); if (ready) settle(pending.kind === "prompt" ? value : true); }}>
          {hasInput && <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{pending.kind === "prompt" ? pending.options.label : (pending.options.requireTextLabel ?? `请输入「${requireText}」以确认`)}</span>
            <Input
              ref={inputRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              type={pending.kind === "prompt" ? (pending.options.type ?? "text") : "text"}
              autoComplete={pending.kind === "prompt" ? (pending.options.autoComplete ?? "off") : "off"}
              placeholder={pending.kind === "prompt" ? pending.options.placeholder : requireText}
            />
          </label>}
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button type="button" variant="outline">{pending.options.cancelText ?? "取消"}</Button></AlertDialogCancel>
            <Button type="submit" variant={pending.options.destructive ? "destructive" : "default"} disabled={!ready}>{pending.options.confirmText ?? "确定"}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>}
    </AlertDialog>
  </ConfirmContext.Provider>;
}

export function useConfirm() {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm 必须在 <ConfirmProvider> 内使用");
  return ctx.confirm;
}

export function usePrompt() {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("usePrompt 必须在 <ConfirmProvider> 内使用");
  return ctx.prompt;
}
