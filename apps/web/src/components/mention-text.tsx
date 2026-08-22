import { splitMentions } from "@kb/shared";
import { cn } from "../lib/utils";

export type MentionAgent = {
  id: string;
  handle: string;
  displayName: string;
  avatarEmoji?: string;
  avatarUrl?: string | null;
  bio?: string | null;
};

export function MentionText({
  text, agents, className,
}: {
  text: string;
  agents: MentionAgent[];
  className?: string;
}) {
  const map = new Map(agents.map(a => [a.handle, a]));
  return <p className={cn("whitespace-pre-wrap", className)}>
    {splitMentions(text).map((part, i) => {
      if (part.type === "mention" && map.has(part.handle)) {
        return <span key={i} className="font-medium text-primary">{part.value}</span>;
      }
      return <span key={i}>{part.value}</span>;
    })}
  </p>;
}
