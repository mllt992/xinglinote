import { ArrowUpDown, Check } from "lucide-react";
import { NOTE_SORT_LABELS, NOTE_SORT_MODES, type NoteSortMode } from "@kb/shared";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip } from "./ui/tooltip";

export type TreeNote = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt?: string | Date | null;
  sortKey?: number | null;
};

/** 排序菜单。笔记与笔记本共用——三档口径一样，不该各写一套（`title` 只换个说法）。 */
export function NoteSortMenu({ mode, onChange, title = "笔记排序", size = "size-8" }: {
  mode: NoteSortMode;
  onChange: (mode: NoteSortMode) => void;
  title?: string;
  size?: string;
}) {
  return (
    <DropdownMenu>
      <Tooltip content={`排序：${NOTE_SORT_LABELS[mode]}`}>
        <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={size} aria-label={title}>
              <ArrowUpDown />
            </Button>
          </DropdownMenuTrigger>
        </span>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <p className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">{title}</p>
        {NOTE_SORT_MODES.map((item) => (
          <DropdownMenuItem key={item} onSelect={() => onChange(item)}>
            {NOTE_SORT_LABELS[item]}
            {mode === item && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
