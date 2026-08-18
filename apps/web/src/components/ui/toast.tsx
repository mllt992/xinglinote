import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type ToastVariant = "default" | "success" | "destructive";
export type ToastOptions = { title: string; description?: React.ReactNode; variant?: ToastVariant; duration?: number };
type Entry = ToastOptions & { id: number; open: boolean };

type Api = {
  toast: (o: ToastOptions) => void;
  success: (title: string, description?: React.ReactNode) => void;
  error: (title: string, description?: React.ReactNode) => void;
};

const ToastContext = React.createContext<Api | null>(null);

/**
 * 统一的短暂结果提示。只承载「做完了 / 失败了」这类一次性反馈，
 * 字段级错误和必须处理的冲突仍然留在表单或页面里，不要塞进 Toast。
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Entry[]>([]);
  const seq = React.useRef(0);

  const api = React.useMemo<Api>(() => {
    const toast = (o: ToastOptions) => setItems(v => [...v.slice(-3), { ...o, id: ++seq.current, open: true }]);
    return {
      toast,
      success: (title, description) => toast({ title, description, variant: "success" }),
      error: (title, description) => toast({ title, description, variant: "destructive" }),
    };
  }, []);

  return <ToastContext.Provider value={api}>
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      {children}
      {items.map(t => <ToastRow key={t.id} entry={t} onClosed={() => setItems(v => v.filter(x => x.id !== t.id))} />)}
      <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-100 flex w-full max-w-[calc(100%-2rem)] flex-col gap-2 p-4 outline-none sm:max-w-sm" />
    </ToastPrimitive.Provider>
  </ToastContext.Provider>;
}

const tone: Record<ToastVariant, { ring: string; icon: React.ReactNode }> = {
  default: { ring: "border-border", icon: <Info className="size-4 text-muted-foreground" /> },
  success: { ring: "border-border", icon: <CheckCircle2 className="size-4 text-[var(--good)]" /> },
  destructive: { ring: "border-destructive/40", icon: <AlertCircle className="size-4 text-destructive" /> },
};

function ToastRow({ entry, onClosed }: { entry: Entry; onClosed: () => void }) {
  const t = tone[entry.variant ?? "default"];
  return <ToastPrimitive.Root
    duration={entry.duration}
    onOpenChange={open => { if (!open) onClosed(); }}
    className={cn("flex items-start gap-2.5 rounded-xl border bg-background p-3.5 shadow-lg outline-none motion-safe:data-[state=open]:animate-toast-in data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]", t.ring)}
  >
    <span className="mt-0.5 shrink-0">{t.icon}</span>
    <div className="min-w-0 flex-1">
      <ToastPrimitive.Title className="text-sm font-medium">{entry.title}</ToastPrimitive.Title>
      {entry.description && <ToastPrimitive.Description className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{entry.description}</ToastPrimitive.Description>}
    </div>
    <ToastPrimitive.Close aria-label="关闭提示" className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"><X className="size-3.5" /></ToastPrimitive.Close>
  </ToastPrimitive.Root>;
}

export function useToast(): Api {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}
