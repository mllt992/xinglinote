import * as Ctx from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";

export const ContextMenu = Ctx.Root;
export const ContextMenuTrigger = Ctx.Trigger;

/**
 * 和 DropdownMenuContent 同一套外观与焦点规则：菜单项常用来开确认弹窗，
 * 关闭时若已有弹窗在场就不把焦点抢回触发元素，否则键盘走不下去。
 */
export function ContextMenuContent({ className, onCloseAutoFocus, ...props }: React.ComponentProps<typeof Ctx.Content>) {
  return <Ctx.Portal><Ctx.Content
    onCloseAutoFocus={event => {
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && document.querySelector('[role="alertdialog"],[role="dialog"]')) event.preventDefault();
    }}
    className={cn("z-50 min-w-48 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none", className)}
    {...props}
  /></Ctx.Portal>;
}

export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof Ctx.Item>) {
  return <Ctx.Item className={cn("flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props} />;
}

export const ContextMenuSeparator = (props: React.ComponentProps<typeof Ctx.Separator>) => <Ctx.Separator className="-mx-1 my-1 h-px bg-border" {...props} />;

/** 菜单顶部那行「在操作谁」，避免右击后不知道命中的是哪一项。 */
export function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof Ctx.Label>) {
  return <Ctx.Label className={cn("truncate px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground", className)} {...props} />;
}
