import { useMemo, useRef, useState } from "react";
import { hashtagQuery, mentionQuery } from "@kb/shared";
import { cn } from "../lib/utils";
import { Textarea } from "./ui/textarea";
import { AgentAvatar } from "./agent-avatar";
import type { MentionAgent } from "./mention-text";

export function MentionField({
  value, onChange, agents, tags = [], maxLength, placeholder, className, disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  agents: MentionAgent[];
  tags?: string[];
  maxLength?: number;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const mention = mentionQuery(value, caret);
  const hash = mention ? null : hashtagQuery(value, caret);
  const filteredAgents = useMemo(() => {
    if (!mention) return [];
    return agents.filter(a => !mention.query || a.handle.includes(mention.query) || a.displayName.toLowerCase().includes(mention.query)).slice(0, 8);
  }, [agents, mention]);
  const filteredTags = useMemo(() => {
    if (!hash) return [];
    return tags.filter(t => !hash.query || t.includes(hash.query)).slice(0, 8);
  }, [tags, hash]);
  const showAgents = open && !!mention && filteredAgents.length > 0;
  const showTags = open && !!hash && filteredTags.length > 0;

  function syncCaret() {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function insertAt(start: number, text: string) {
    const el = ref.current;
    const next = `${value.slice(0, start)}${text}${value.slice(caret)}`;
    onChange(next);
    setOpen(false);
    const pos = start + text.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }
  function insert(agent: MentionAgent) {
    if (!mention) return;
    insertAt(mention.start, `@${agent.handle} `);
  }
  function insertTag(tag: string) {
    if (!hash) return;
    insertAt(hash.start, `#${tag} `);
  }

  return <div className="relative">
    <Textarea
      ref={ref}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); setActive(0); }}
      onClick={syncCaret}
      onKeyUp={syncCaret}
      onSelect={syncCaret}
      onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      onKeyDown={e => {
        if (!showAgents && !showTags) return;
        const n = showAgents ? filteredAgents.length : filteredTags.length;
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => (i + 1) % n); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => (i - 1 + n) % n); }
        else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        else if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (showAgents) insert(filteredAgents[active] ?? filteredAgents[0]);
          else insertTag(filteredTags[active] ?? filteredTags[0]);
        }
      }}
    />
    {showAgents && <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border bg-background p-1 shadow-md">
      {filteredAgents.map((a, i) => <li key={a.id}>
        <button type="button"
          className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")}
          onMouseDown={e => { e.preventDefault(); insert(a); }}
          onMouseEnter={() => setActive(i)}>
          <AgentAvatar emoji={a.avatarEmoji} url={a.avatarUrl} label={a.displayName} className="size-5 text-base" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{a.displayName} <span className="font-normal text-muted-foreground">@{a.handle}</span></span>
            {a.bio && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{a.bio}</span>}
          </span>
        </button>
      </li>)}
    </ul>}
    {showTags && <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border bg-background p-1 shadow-md">
      {filteredTags.map((t, i) => <li key={t}>
        <button type="button"
          className={cn("flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")}
          onMouseDown={e => { e.preventDefault(); insertTag(t); }}
          onMouseEnter={() => setActive(i)}>
          #{t}
        </button>
      </li>)}
    </ul>}
  </div>;
}
