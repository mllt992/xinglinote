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
  const [value, setValue] = React.useState("");
  const resolver = React.useRef<((v: Settled) => void) | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /** 关闭路径不止一条（按钮、Esc、遮罩），用 ref 保证只结算一次。 */
  const settle = React.useCallback((v: Settled) => {
    const r = resolver.current;
    resolver.current = null;
    setPending(null);
    r?.(v);
  }, []);

  const api = React.useMemo<Api>(() => ({
    confirm: o => new Promise<boolean>(resolve => {
      resolver.current = resolve as (v: Settled) => void;
      setValue("");
      setPending({ kind: "confirm", options: o });
    }),
    prompt: o => new Promise<string | null>(resolve => {
      resolver.current = resolve as (v: Settled) => void;
      setValue(o.defaultValue ?? "");
      setPending({ kind: "prompt", options: o });
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
    <AlertDialog open={!!pending} onOpenChange={open => { if (!open) settle(isPrompt ? null : false); }}>
      {pending && <AlertDialogContent onOpenAutoFocus={e => { if (hasInput) { e.preventDefault(); inputRef.current?.focus(); } }}>
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
