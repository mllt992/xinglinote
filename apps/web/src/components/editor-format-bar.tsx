import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bold, Brackets, ChevronDown, Code, FileCode2, FoldHorizontal, Highlighter, Italic, Link2, List,
  ListOrdered, ListTodo, MoreHorizontal, Paperclip, Quote, Redo2, Search, Sigma, Strikethrough,
  Table2, Undo2, UnfoldHorizontal, Workflow,
} from "lucide-react";
import type { EditorAction } from "../editor/markdown-editor";
import { cn } from "../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip } from "./ui/tooltip";

type ActionButton = { action: EditorAction; label: string; shortcut?: string; icon: ReactNode };

const HISTORY: ActionButton[] = [
  { action: "undo", label: "撤销", shortcut: "Ctrl/⌘+Z", icon: <Undo2 /> },
  { action: "redo", label: "重做", shortcut: "Ctrl/⌘+Shift+Z", icon: <Redo2 /> },
];
const TEXT: ActionButton[] = [
  { action: "bold", label: "粗体", shortcut: "Ctrl/⌘+B", icon: <Bold /> },
  { action: "italic", label: "斜体", shortcut: "Ctrl/⌘+I", icon: <Italic /> },
  { action: "strike", label: "删除线", shortcut: "Ctrl/⌘+Shift+X", icon: <Strikethrough /> },
  { action: "code", label: "行内代码", shortcut: "Ctrl/⌘+E", icon: <Code /> },
];
const STRUCTURE: ActionButton[] = [
  { action: "bullet", label: "无序列表", icon: <List /> },
  { action: "ordered", label: "有序列表", icon: <ListOrdered /> },
  { action: "task", label: "任务列表", shortcut: "Ctrl/⌘+Shift+Enter", icon: <ListTodo /> },
  { action: "quote", label: "引用", icon: <Quote /> },
  { action: "codeBlock", label: "代码块", icon: <FileCode2 /> },
];
const INSERT: ActionButton[] = [
  { action: "link", label: "普通链接", shortcut: "Ctrl/⌘+Shift+K", icon: <Link2 /> },
  { action: "wiki", label: "双链", shortcut: "Ctrl/⌘+Shift+L", icon: <Brackets /> },
];
const MORE: ActionButton[] = [
  { action: "table", label: "插入表格", icon: <Table2 /> },
  { action: "inlineMath", label: "插入行内公式", icon: <Sigma /> },
  { action: "blockMath", label: "插入块级公式", icon: <Sigma /> },
  { action: "mermaid", label: "插入 Mermaid 流程图", icon: <Workflow /> },
  { action: "highlight", label: "高亮", icon: <Highlighter /> },
  { action: "horizontalRule", label: "插入分隔线", icon: <span className="text-base leading-none">―</span> },
  { action: "search", label: "查找与替换", shortcut: "Ctrl/⌘+F", icon: <Search /> },
  { action: "fold", label: "折叠全部", icon: <FoldHorizontal /> },
  { action: "unfold", label: "展开全部", icon: <UnfoldHorizontal /> },
];

function ToolButton({ item, active, disabled, onAction }: { item: ActionButton; active: boolean; disabled?: boolean; onAction: (action: EditorAction) => void }) {
  const tip = item.shortcut ? `${item.label}（${item.shortcut}）` : item.label;
  return <Tooltip content={tip}><button
    type="button"
    aria-label={item.label}
    aria-pressed={active || undefined}
    title={tip}
    disabled={disabled}
    onMouseDown={event => event.preventDefault()}
    onClick={() => onAction(item.action)}
    className={cn(
      "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors [&_svg]:size-4",
      "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-35",
      active && "bg-accent text-foreground shadow-[inset_0_-2px_0_var(--primary)]",
    )}
  >{item.icon}</button></Tooltip>;
}

function Divider() { return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />; }

function HeadingMenu({ active, onAction }: { active: ReadonlySet<EditorAction>; onAction: (action: EditorAction) => void }) {
  const current = ([1, 2, 3, 4, 5, 6] as const).find(level => active.has(`heading${level}` as EditorAction));
  return <DropdownMenu modal={false}>
    <Tooltip content="标题级别"><span className="inline-flex shrink-0"><DropdownMenuTrigger asChild><button
      type="button"
      aria-label="标题级别"
      title="标题级别"
      onMouseDown={event => event.preventDefault()}
      className={cn("flex h-8 min-w-[4.5rem] items-center justify-between gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", current && "bg-accent text-foreground")}
    >{current ? `标题 ${current}` : "正文"}<ChevronDown className="size-3.5" /></button></DropdownMenuTrigger></span></Tooltip>
    <DropdownMenuContent align="start" onCloseAutoFocus={event => event.preventDefault()}>
      <DropdownMenuItem onSelect={() => onAction("paragraph")}><span className="w-6 text-center text-xs">P</span>正文</DropdownMenuItem>
      {([1, 2, 3, 4, 5, 6] as const).map(level => <DropdownMenuItem key={level} onSelect={() => onAction(`heading${level}` as EditorAction)}><span className="w-6 text-center text-xs font-semibold">H{level}</span>{level} 级标题</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function MobileHeadingButtons({ active, onAction }: { active: ReadonlySet<EditorAction>; onAction: (action: EditorAction) => void }) {
  const choices: Array<{ action: EditorAction; label: string }> = [
    { action: "paragraph", label: "正文" },
    ...([1, 2, 3, 4, 5, 6] as const).map(level => ({ action: `heading${level}` as EditorAction, label: `H${level}` })),
  ];
  const hasHeading = choices.slice(1).some(item => active.has(item.action));
  return <>{choices.map(item => {
    const pressed = item.action === "paragraph" ? !hasHeading : active.has(item.action);
    return <button key={item.action} type="button" aria-label={item.action === "paragraph" ? "正文" : `${item.label} 标题`} aria-pressed={pressed} title={item.action === "paragraph" ? "正文" : `${item.label} 标题`} onMouseDown={event => event.preventDefault()} onClick={() => onAction(item.action)} className={cn("flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", pressed && "bg-accent text-foreground shadow-[inset_0_-2px_0_var(--primary)]")}>{item.label}</button>;
  })}</>;
}

function MoreMenu({ active, spellcheck, onAction, onToggleSpellcheck }: { active: ReadonlySet<EditorAction>; spellcheck: boolean; onAction: (action: EditorAction) => void; onToggleSpellcheck: () => void }) {
  return <DropdownMenu modal={false}>
    <Tooltip content="更多格式与编辑工具"><span className="inline-flex shrink-0"><DropdownMenuTrigger asChild><button type="button" aria-label="更多格式与编辑工具" title="更多格式与编辑工具" onMouseDown={event => event.preventDefault()} className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger></span></Tooltip>
    <DropdownMenuContent align="end" onCloseAutoFocus={event => event.preventDefault()}>
      {MORE.map((item, index) => <Fragment key={item.action}>{index === 6 && <DropdownMenuSeparator />}<DropdownMenuItem onSelect={() => onAction(item.action)} className={cn(active.has(item.action) && "bg-muted text-foreground")}>{item.icon}<span>{item.label}</span>{item.shortcut && <span className="ml-auto text-[11px] text-muted-foreground">{item.shortcut}</span>}</DropdownMenuItem></Fragment>)}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onToggleSpellcheck}><span className="grid size-4 place-items-center text-xs font-semibold">Aa</span>拼写检查<span className="ml-auto text-xs text-muted-foreground">{spellcheck ? "开" : "关"}</span></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

type EditorFormatBarProps = {
  onAction: (action: EditorAction) => void;
  activeActions?: EditorAction[];
  history: { canUndo: boolean; canRedo: boolean };
  onUpload: () => void;
  spellcheck: boolean;
  onToggleSpellcheck: () => void;
};

function ToolbarContents({ active, history, spellcheck, onAction, onUpload, onToggleSpellcheck, mobile = false }: EditorFormatBarProps & { active: ReadonlySet<EditorAction>; mobile?: boolean }) {
  return <>
    {HISTORY.map(item => <ToolButton key={item.action} item={item} active={false} disabled={item.action === "undo" ? !history.canUndo : !history.canRedo} onAction={onAction} />)}
    <Divider />{mobile ? <MobileHeadingButtons active={active} onAction={onAction} /> : <HeadingMenu active={active} onAction={onAction} />}<Divider />
    {TEXT.map(item => <ToolButton key={item.action} item={item} active={active.has(item.action)} onAction={onAction} />)}
    <Divider />{STRUCTURE.map(item => <ToolButton key={item.action} item={item} active={active.has(item.action)} onAction={onAction} />)}
    <Divider />{INSERT.map(item => <ToolButton key={item.action} item={item} active={false} onAction={onAction} />)}
    <Tooltip content="上传图片或附件"><button type="button" aria-label="上传图片或附件" title="上传图片或附件" onMouseDown={event => event.preventDefault()} onClick={onUpload} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"><Paperclip className="size-4" /></button></Tooltip>
    <Divider />{mobile ? <>{MORE.map(item => <ToolButton key={item.action} item={item} active={active.has(item.action)} onAction={onAction} />)}<Tooltip content={`拼写检查：${spellcheck ? "开" : "关"}`}><button type="button" aria-label="拼写检查" aria-pressed={spellcheck} title={`拼写检查：${spellcheck ? "开" : "关"}`} onMouseDown={event => event.preventDefault()} onClick={onToggleSpellcheck} className={cn("flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", spellcheck && "bg-accent text-foreground shadow-[inset_0_-2px_0_var(--primary)]")}>Aa</button></Tooltip></> : <MoreMenu active={active} spellcheck={spellcheck} onAction={onAction} onToggleSpellcheck={onToggleSpellcheck} />}
  </>;
}

/** 桌面常驻、移动端贴软键盘的同一套响应式编辑工具栏。 */
export function EditorFormatBar(props: EditorFormatBarProps) {
  const [offset, setOffset] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const baseline = useRef(0);
  const active = useMemo(() => new Set(props.activeActions ?? []), [props.activeActions]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      baseline.current = Math.max(baseline.current, viewport.height);
      const keyboard = baseline.current - viewport.height > 120;
      setOffset(keyboard ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
      setMobileOpen(keyboard && !!document.activeElement?.closest?.(".cm-content"));
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    const refocus = () => window.setTimeout(sync, 0);
    document.addEventListener("focusin", refocus);
    document.addEventListener("focusout", refocus);
    const reset = () => { baseline.current = 0; sync(); };
    window.addEventListener("orientationchange", reset);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      document.removeEventListener("focusin", refocus);
      document.removeEventListener("focusout", refocus);
      window.removeEventListener("orientationchange", reset);
    };
  }, []);

  return <>
    <div role="toolbar" aria-label="Markdown 格式工具栏" className="mb-3 hidden min-h-10 shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-muted/20 px-1.5 py-1 md:flex">
      <ToolbarContents {...props} active={active} />
    </div>
    {mobileOpen && <div role="toolbar" aria-label="Markdown 格式工具栏" className="fixed inset-x-0 z-50 flex gap-0.5 overflow-x-auto border-t border-border bg-background px-2 py-1.5 shadow-[0_-6px_16px_rgb(0_0_0/.08)] md:hidden" style={{ bottom: offset }}>
      <ToolbarContents {...props} active={active} mobile />
    </div>}
  </>;
}
