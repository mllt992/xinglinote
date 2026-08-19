import { cn } from "../../lib/utils";

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onCheckedChange(!checked)}
    className={cn("relative h-6 w-10 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50", checked ? "bg-primary" : "bg-muted ring-1 ring-inset ring-border")}>
    <span className={cn("pointer-events-none absolute top-0.5 left-0.5 block size-5 rounded-full bg-background shadow-sm transition-transform", checked && "translate-x-4")} />
  </button>;
}
