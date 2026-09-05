import type { Plugin } from "vite";

/**
 * Issue #36：把编辑区大标题收进笔记顶栏。
 * 改动以源码变换形式挂在构建链上，避免 MCP 单次重写 160KB 的 App.tsx。
 * 变换幂等：已含 note-title-chrome 时直接跳过。
 */
export function compactNoteTitlePlugin(): Plugin {
  return {
    name: "compact-note-title",
    enforce: "pre",
    transform(code, id) {
      const norm = id.replace(/\\/g, "/");
      if (!norm.endsWith("/src/App.tsx")) return;
      if (code.includes('from "./components/note-title-chrome"')) return;

      let next = code.replace(
        'import { NoteConflictBanner } from "./components/note-conflict-banner";\n',
        'import { NoteConflictBanner } from "./components/note-conflict-banner";\nimport { NoteTitleChrome } from "./components/note-title-chrome";\n',
      );

      if (!next.includes("async function copyNoteTitle()")) {
        next = next.replace(
          `    else toast.error("复制失败", "浏览器没有授予剪贴板权限，请选中正文后手动复制。");
  }

  async function exportCurrentNote()`,
          `    else toast.error("复制失败", "浏览器没有授予剪贴板权限，请选中正文后手动复制。");
  }

  async function copyNoteTitle() {
    const current = noteRef.current;
    if (!current) return;
    const done = await copyPlainText(current.title || "");
    if (done) toast.success("已复制标题");
    else toast.error("复制失败", "浏览器没有授予剪贴板权限，请手动选择标题后复制。");
  }

  async function exportCurrentNote()`,
        );
      }

      if (!next.includes('id: "copy-title"')) {
        next = next.replace(
          '{ id: "copy-markdown", group: "笔记", label: "复制 Markdown 正文", icon: <Copy />, run: () => void copyCurrentNote("markdown") },',
          '{ id: "copy-title", group: "笔记", label: "复制标题", icon: <Copy />, run: () => void copyNoteTitle() },\n      { id: "copy-markdown", group: "笔记", label: "复制 Markdown 正文", icon: <Copy />, run: () => void copyCurrentNote("markdown") },',
        );
      }

      const oldChrome =
        '<div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4"><div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><span className="shrink-0">{activeNb?.title}</span>{folderAncestorIds(folders, tree.find(n => n.id === note.id)?.folderId ?? null).slice().reverse().map(id => { const f = folders.find(x => x.id === id); return f ? <span key={f.id} className="flex min-w-0 items-center gap-1.5"><ChevronRight className="size-3 shrink-0" /><span className="truncate">{f.title}</span></span> : null; })}<ChevronRight className="size-3 shrink-0" /><span className="truncate text-foreground">{note.title || "未命名"}</span>{note.moderation?.held && <Badge className={note.moderation.status === "rejected" ? "border-transparent bg-destructive/10 text-destructive" : "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]"}>{note.moderation.queued ? "审核中" : note.moderation.status === "rejected" ? "未通过审核" : "待人工审核"}</Badge>}</div><div className="ml-auto flex items-center gap-1">';

      const newChrome =
        '<div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4"><div className="flex min-w-0 flex-1 items-center gap-2"><div className="hidden min-w-0 max-w-[38%] items-center gap-1.5 text-xs text-muted-foreground sm:flex"><span className="shrink-0 truncate">{activeNb?.title}</span>{folderAncestorIds(folders, tree.find(n => n.id === note.id)?.folderId ?? null).slice().reverse().map(id => { const f = folders.find(x => x.id === id); return f ? <span key={f.id} className="flex min-w-0 items-center gap-1.5"><ChevronRight className="size-3 shrink-0" /><span className="truncate">{f.title}</span></span> : null; })}</div><NoteTitleChrome title={note.title} canEdit={note.canEdit} onChange={value => changeNote({ title: value })} onCopy={() => void copyNoteTitle()} />{note.moderation?.held && <Badge className={note.moderation.status === "rejected" ? "border-transparent bg-destructive/10 text-destructive" : "border-transparent bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]"}>{note.moderation.queued ? "审核中" : note.moderation.status === "rejected" ? "未通过审核" : "待人工审核"}</Badge>}</div><div className="ml-auto flex shrink-0 items-center gap-1">';

      if (next.includes(oldChrome)) next = next.replace(oldChrome, newChrome);

      const oldInput =
        '<input className="mb-3 w-full border-0 bg-transparent font-[var(--font-title)] text-2xl font-semibold tracking-[-.045em] outline-none placeholder:text-muted-foreground/40 sm:mb-4 sm:text-3xl md:text-4xl" value={note.title} onChange={e => changeNote({ title: e.target.value })} placeholder="无标题" />';
      if (next.includes(oldInput)) next = next.replace(oldInput, "");

      return next === code ? undefined : next;
    },
  };
}
