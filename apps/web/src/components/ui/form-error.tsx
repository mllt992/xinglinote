import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * 表单与字段级错误。规范 §11.2：错误信息紧邻字段，用文字 + 图标表达，不能只变红；
 * §11.4：这类错误不能用 Toast 代替（Toast 只承载一次性结果）。
 * 页面不要再各自写 {err && <p className="text-destructive">}，统一用这个。
 */
export function FormError({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return <p role="alert" className={cn("flex items-start gap-1.5 text-sm text-destructive", className)}>
    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
    <span className="min-w-0">{children}</span>
  </p>;
}
