import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * 居中用 flex，不用 left-1/2 + translate(-50%)：后者要先量到自己的宽高才知道往回挪多少，
 * 首帧拿不到就会先画在偏的位置再跳回来。flex 是同一次布局算出来的，第一帧就在正确位置。
 * 入场动效因此只动 opacity 和 scale——scale 以中心为原点，不会挪动位置。
 */
export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] motion-safe:data-[state=open]:animate-overlay-in" />
    <div className="pointer-events-none fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <DialogPrimitive.Content className={cn("pointer-events-auto relative grid w-full max-w-md gap-4 rounded-2xl border border-border bg-background p-6 shadow-2xl outline-none motion-safe:data-[state=open]:animate-dialog-in", className)} {...props}>
          {children}
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </div>
  </DialogPrimitive.Portal>;
}
export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("space-y-1.5", className)} {...props} />; }
export const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold tracking-tight", className)} {...props} />);
export const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />);
