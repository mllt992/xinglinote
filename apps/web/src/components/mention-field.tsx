import { useMemo, useRef, useState } from "react";
import { mentionQuery } from "@kb/shared";
import { cn } from "../lib/utils";
import { Textarea } from "./ui/textarea";
import type { MentionAgent } from "./mention-text";

export function MentionField({
  value, onChange, agents, maxLength, placeholder, className, disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  agents: MentionAgent[];
  maxLength?: number;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const hint = mentionQuery(value, caret);
  const filtered = useMemo(() => {
    if (!hint) return [];
    return agents.filter(a => !hint.query || a.handle.includes(hint.query) || a.displayName.toLowerCase().includes(hint.query)).slice(0, 8);
  }, [agents, hint]);
  const show = open && !!hint && filtered.length > 0;

  function syncCaret() {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function insert(agent: MentionAgent) {
    if (!hint) return;
    const el = ref.current;
    const next = `${value.slice(0, hint.start)}@${agent.handle} ${value.slice(caret)}`;
    onChange(next);
    setOpen(false);
    const pos = hint.start + agent.handle.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
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
        if (!show) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => (i + 1) % filtered.length); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => (i - 1 + filtered.length) % filtered.length); }
        else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        else if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
          e.preventDefault();
          insert(filtered[active] ?? filtered[0]);
        }
      }}
    />
    {show && <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border bg-background p-1 shadow-md">
      {filtered.map((a, i) => <li key={a.id}>
        <button type="button"
          className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")}
          onMouseDown={e => { e.preventDefault(); insert(a); }}
          onMouseEnter={() => setActive(i)}>
          <span className="text-base leading-none">{a.avatarEmoji ?? "🤖"}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{a.displayName} <span className="font-normal text-muted-foreground">@{a.handle}</span></span>
            {a.bio && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{a.bio}</span>}
          </span>
        </button>
      </li>)}
    </ul>}
  </div>;
}
