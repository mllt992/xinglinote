import * as Avatar from "@radix-ui/react-avatar";
import { cn } from "../lib/utils";

export function UserAvatar({ name, url, className }: { name: string; url?: string | null; className?: string }) {
  return <Avatar.Root className={cn("grid shrink-0 place-items-center overflow-hidden rounded-full bg-foreground font-semibold text-background", className)}>
    {url && <Avatar.Image src={url} alt={name} className="size-full object-cover" />}
    <Avatar.Fallback>{name.trim().slice(0, 1) || "U"}</Avatar.Fallback>
  </Avatar.Root>;
}
