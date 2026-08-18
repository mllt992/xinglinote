import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils";
export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;
export function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof Dropdown.Content>) { return <Dropdown.Portal><Dropdown.Content sideOffset={sideOffset} className={cn("z-50 min-w-44 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl outline-none", className)} {...props} /></Dropdown.Portal>; }
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Dropdown.Item>) { return <Dropdown.Item className={cn("flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none focus:bg-muted data-[disabled]:opacity-50", className)} {...props} />; }
export const DropdownMenuSeparator = (props: React.ComponentProps<typeof Dropdown.Separator>) => <Dropdown.Separator className="-mx-1 my-1 h-px bg-border" {...props} />;
