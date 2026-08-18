import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils";
export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;
/**
 * 菜单关闭时 Radix 会把焦点还给触发按钮。但菜单项常用来开确认弹窗，
 * 这个「还焦点」会在弹窗挂载之后触发，把焦点从弹窗里抢走，键盘就走不下去了。
 * 所以关闭时若已经有弹窗在场，就不抢焦点；没有弹窗时行为不变。
 */
export function DropdownMenuContent({ className, sideOffset = 6, onCloseAutoFocus, ...props }: React.ComponentProps<typeof Dropdown.Content>) {
  return <Dropdown.Portal><Dropdown.Content
    sideOffset={sideOffset}
    onCloseAutoFocus={event => {
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && document.querySelector('[role="alertdialog"],[role="dialog"]')) event.preventDefault();
    }}
    className={cn("z-50 min-w-44 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none", className)}
    {...props}
  /></Dropdown.Portal>;
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Dropdown.Item>) { return <Dropdown.Item className={cn("flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none focus:bg-muted data-[disabled]:opacity-50", className)} {...props} />; }
export const DropdownMenuSeparator = (props: React.ComponentProps<typeof Dropdown.Separator>) => <Dropdown.Separator className="-mx-1 my-1 h-px bg-border" {...props} />;
