import { Button } from "./ui/button";

/** 设计 03 §3.3：409 之后停自动保存，让人在「加载对方 / 强制覆盖」里选。 */
export function NoteConflictBanner({
  editor,
  onLoadTheirs,
  onOverwrite,
}: {
  editor: string;
  onLoadTheirs: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
      <span className="min-w-0 flex-1">{editor} 刚保存了更新。继续自动保存会拿旧版本号连打冲突，先选一边。</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onLoadTheirs}>加载对方版本</Button>
        <Button size="sm" variant="destructive" onClick={onOverwrite}>强制覆盖</Button>
      </div>
    </div>
  );
}
