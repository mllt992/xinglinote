import { cn } from "../lib/utils";

export function AgentAvatar({
  emoji, url, label, className,
}: {
  emoji?: string | null;
  url?: string | null;
  label?: string;
  className?: string;
}) {
  if (url) {
    return <img src={url} alt={label ?? ""} className={cn("size-5 rounded-md object-cover", className)} />;
  }
  return <span className={cn("grid place-items-center leading-none", className)}>{emoji || "🤖"}</span>;
}
