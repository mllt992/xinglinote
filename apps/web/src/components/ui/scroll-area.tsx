import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "../../lib/utils";
/** Radix 的 viewport 会给内容套一层 display:table，宽度按内容撑开；侧栏里 truncate 的长标题会因此把整行顶宽、
 *  把行尾的按钮挤出可视区。这里改回 block，让内容始终跟着容器宽度走（我们只用纵向滚动）。 */
export function ScrollArea({ className, children, viewportRef, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportRef?: React.Ref<HTMLDivElement> }) { return <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}><ScrollAreaPrimitive.Viewport ref={viewportRef} className="size-full rounded-[inherit] [&>div]:block!">{children}</ScrollAreaPrimitive.Viewport><ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2.5 touch-none select-none p-px"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" /></ScrollAreaPrimitive.Scrollbar><ScrollAreaPrimitive.Corner /></ScrollAreaPrimitive.Root>; }
