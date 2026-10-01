import { useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, Folder, FolderTree, Upload } from 'lucide-react';
import { flattenFolders, folderTitlePath, type TreeFolder } from '@kb/shared';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { useToast } from './ui/toast';
import { cn } from '../lib/utils';
import { takeInputFiles } from '../lib/file-input';

type Mode = 'skip' | 'rename' | 'overwrite';
type Source = 'auto' | 'notion' | 'yuque' | 'generic';
type ReportItem = { path: string; title?: string; status: 'success' | 'skipped' | 'degraded' | 'failed'; message: string };
type PlanItem = { sourcePath: string; folder: string; title: string; originalTitle: string; action: 'create' | 'rename' | 'overwrite' | 'skip'; attachments: number; warnings: string[] };
type Plan = { fingerprint: string; source: Source; targetFolder: string | null; newFolders: string[]; items: PlanItem[]; summary: Record<Mode | 'create', number>; report: ReportItem[] };
type Result = { created: unknown[]; overwritten: unknown[]; skipped: unknown[]; foldersCreated: string[]; report: ReportItem[] };
const MODES: Array<{ v: Mode; title: string; desc: string }> = [
  { v: 'rename', title: '改名保留', desc: '另存为「标题 2」，两份都在' },
  { v: 'skip', title: '跳过', desc: '保留库里已有的同名笔记' },
  { v: 'overwrite', title: '覆盖', desc: '覆盖同名笔记，旧正文进版本历史' },
];
const actionLabel = { create: '新建', rename: '改名', overwrite: '覆盖', skip: '跳过' };
const reportLabel = { success: '成功', skipped: '跳过', degraded: '降级', failed: '失败' };

/** 上传原文件并先预览，只有明确确认后才写入；关闭/换文件使旧预览失效。 */
export function ImportDialog({ notebookId, notebookTitle, folders = [], activeFolderId = null, open, onOpenChange, onDone }: {
  notebookId?: string; notebookTitle?: string; folders?: TreeFolder[]; activeFolderId?: string | null;
  open: boolean; onOpenChange: (value: boolean) => void; onDone: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<Mode>('rename');
  const [source, setSource] = useState<Source>('auto');
  const [createFolders, setCreateFolders] = useState(true);
  const [targetFolderId, setTargetFolderId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [report, setReport] = useState<ReportItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [html, setHtml] = useState('');
  const request = useRef(0), abort = useRef<AbortController | null>(null), executing = useRef(false), wasOpen = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null);
  const folderRows = useMemo(() => flattenFolders(folders, 'name'), [folders]);
  const targetLabel = targetFolderId ? folderTitlePath(folders, targetFolderId, ' / ') || '所选文件夹' : '笔记本根目录';

  useEffect(() => {
    if (open && !wasOpen.current) setTargetFolderId(activeFolderId && folderRows.some(({ folder }) => folder.id === activeFolderId) ? activeFolderId : null);
    wasOpen.current = open;
    if (!open && !executing.current) { request.current++; abort.current?.abort(); setFiles([]); setPlan(null); setReport(null); setHtml(''); setBusy(false); }
  }, [open, activeFolderId, folderRows]);
  useEffect(() => () => { request.current++; abort.current?.abort(); }, []);

  async function upload<T>(endpoint: string, selected: File[], options: { mode: Mode; source: Source; createFolders: boolean; targetFolderId: string | null }, fingerprint?: string, signal?: AbortSignal): Promise<T> {
    const body = new FormData();
    for (const file of selected) body.append('files', file, file.name);
    body.set('paths', JSON.stringify(selected.map(file => file.webkitRelativePath || file.name)));
    body.set('options', JSON.stringify(options));
    if (fingerprint) body.set('fingerprint', fingerprint);
    const response = await fetch(`/api/v1/notebooks/${notebookId}/${endpoint}`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'fetch' }, body, signal });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.message || '导入请求失败');
    return result.data as T;
  }
  async function preview(selected = files, m = mode, dirs = createFolders, folderId = targetFolderId, origin = source) {
    if (!notebookId || !selected.length || executing.current) return;
    const version = ++request.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setFiles(selected); setPlan(null); setReport(null); setBusy(true);
    try {
      if (selected.reduce((n, file) => n + file.size, 0) > 100 * 1024 * 1024) throw new Error('一次最多上传 100 MB');
      const next = await upload<Plan>('import-files-preview', selected, { mode: m, source: origin, createFolders: dirs, targetFolderId: folderId }, undefined, controller.signal);
      if (version === request.current) setPlan(next);
    } catch (e) { if (version === request.current && !controller.signal.aborted) toast.error('导入预览失败', (e as Error).message); }
    finally { if (version === request.current) setBusy(false); }
  }
  async function run() {
    if (!plan || !files.length || !notebookId || executing.current) return;
    executing.current = true; setRunning(true); setBusy(true);
    try {
      const result = await upload<Result>('import-files', files, { mode, source, createFolders, targetFolderId }, plan.fingerprint);
      setReport(result.report); setPlan(null);
      const failures = result.report.filter(item => item.status === 'failed').length;
      const summary = `新建 ${result.created.length} 篇，覆盖 ${result.overwritten.length} 篇，跳过 ${result.skipped.length} 篇${failures ? `，失败 ${failures} 项` : ''}`;
      toast.toast({ title: failures ? '导入结束，请查看失败清单' : '导入完成', description: summary });
      onDone();
    } catch (e) { setPlan(null); toast.error('导入未完成，请重新预览', (e as Error).message); }
    finally { executing.current = false; setRunning(false); setBusy(false); }
  }
  const pickFolder = (id: string | null) => { setTargetFolderId(id); if (files.length) void preview(files, mode, createFolders, id); };
  const reportRows = report ?? plan?.report;
  return <Dialog open={open} onOpenChange={value => { if (!executing.current) onOpenChange(value); }}><DialogContent className="max-h-[86vh] max-w-2xl overflow-auto">
    <DialogHeader><DialogTitle className="flex items-center gap-2"><Upload className="size-5"/>迁移导入到《{notebookTitle ?? '笔记本'}》</DialogTitle>
      <DialogDescription>支持 Notion Markdown & CSV、语雀 Markdown 目录、Obsidian ZIP、DOCX、HTML。先预览再确认；图片附件请随 ZIP 或目录一起选择。</DialogDescription></DialogHeader>
    <div className="grid gap-4">
      <label className="flex items-center gap-2 text-sm">来源<select aria-label="导入来源" disabled={busy} value={source} className="rounded-md border bg-background px-2 py-1" onChange={e => { const next = e.target.value as Source; setSource(next); void preview(files, mode, createFolders, targetFolderId, next); }}>
        <option value="auto">自动识别</option><option value="notion">Notion 官方导出</option><option value="yuque">语雀 Markdown 导出</option><option value="generic">通用 / Obsidian / Word / HTML</option>
      </select></label>
      <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">目标文件夹</p>
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border p-1.5">
          <button type="button" disabled={busy} onClick={() => pickFolder(null)} className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm', targetFolderId === null ? 'bg-muted font-medium' : 'hover:bg-muted/60')}><Folder className="size-3.5"/>笔记本根目录</button>
          {folderRows.map(({ folder, depth }) => <button key={folder.id} type="button" disabled={busy} onClick={() => pickFolder(folder.id)} style={{ paddingLeft: 8 + depth * 14 }} className={cn('flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm', targetFolderId === folder.id ? 'bg-muted font-medium' : 'hover:bg-muted/60')}><Folder className="size-3.5 shrink-0"/><span className="truncate">{folder.title}</span></button>)}
        </div><p className="mt-1 text-xs text-muted-foreground">当前目标：{targetLabel}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy || !notebookId} onClick={() => fileInput.current?.click()}><FileDown/>选择文件 / ZIP</Button>
        <Button variant="outline" disabled={busy || !notebookId} onClick={() => directoryInput.current?.click()}><FolderTree/>选择导出目录</Button>
        <input ref={fileInput} type="file" multiple accept=".md,.markdown,.zip,.csv,.docx,.html,.htm,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.mp4,.webm" className="hidden" onChange={e => { const selected = takeInputFiles(e.target); if (selected.length) void preview(selected); }}/>
        <input ref={directoryInput} type="file" multiple {...{ webkitdirectory: '' }} className="hidden" onChange={e => { const selected = takeInputFiles(e.target); if (selected.length) void preview(selected); }}/>
        {files.length > 0 && <span className="text-xs text-muted-foreground">已选 {files.length} 个源文件</span>}
      </div>
      <details><summary className="cursor-pointer text-sm">或粘贴文章 HTML</summary><textarea aria-label="文章 HTML" className="mt-2 h-28 w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder="粘贴 HTML 源码，脚本会被移除，远程图片只保留链接" disabled={busy} value={html} onChange={e => setHtml(e.target.value)}/><Button variant="outline" size="sm" disabled={busy || !html.trim() || !notebookId} onClick={() => void preview([new File([html], '网页摘录.html', { type: 'text/html' })])}>预览 HTML</Button></details>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-3.5 accent-current" disabled={busy} checked={createFolders} onChange={e => { setCreateFolders(e.target.checked); void preview(files, mode, e.target.checked, targetFolderId); }}/><FolderTree className="size-3.5"/>保留包内目录层级，放在目标目录下</label>
      <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">同名笔记</p><div className="grid gap-2 md:grid-cols-3">{MODES.map(option => <button key={option.v} type="button" disabled={busy} onClick={() => { setMode(option.v); void preview(files, option.v); }} className={cn('rounded-lg border p-3 text-left', mode === option.v ? 'border-foreground bg-muted' : 'hover:bg-muted/50')}><span className="text-sm font-medium">{option.title}</span><span className="mt-1 block text-xs text-muted-foreground">{option.desc}</span></button>)}</div></div>
      {busy && <p role="status" className="text-sm text-muted-foreground">{running ? '正在导入，完成后会显示逐项报告…' : '正在安全解析文件并计算预览，不会写入笔记…'}</p>}
      {plan && <div className="rounded-xl border"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-sm"><b>计划</b><Badge>新建 {plan.summary.create}</Badge>{(['rename','overwrite','skip'] as const).filter(key => plan.summary[key] > 0).map(key => <Badge key={key}>{actionLabel[key]} {plan.summary[key]}</Badge>)}{plan.newFolders.length > 0 && <span className="w-full text-xs text-muted-foreground">将新建目录：{plan.newFolders.join('、')}</span>}</div>
        <div className="max-h-64 divide-y overflow-auto">{plan.items.map((item, index) => <div key={`${item.sourcePath}-${index}`} className="space-y-1 px-4 py-2 text-sm"><div className="flex items-center gap-2"><Badge>{actionLabel[item.action]}</Badge><span className="min-w-0 flex-1 break-all">{item.folder ? `${item.folder} / ` : ''}{item.title}</span>{item.attachments > 0 && <span className="text-xs text-muted-foreground">{item.attachments} 附件</span>}</div><p className="break-all text-xs text-muted-foreground">{item.sourcePath}</p>{item.warnings.map((warning, i) => <p key={i} className="text-xs text-amber-700 dark:text-amber-400">降级：{warning}</p>)}</div>)}</div>
        {!plan.items.length && <p className="p-4 text-sm text-muted-foreground">未找到可导入正文，请查看下方报告</p>}
      </div>}
      {!!reportRows?.length && <div className="rounded-xl border"><p className="border-b px-4 py-2 text-sm font-medium">{report ? '导入报告' : '预览提示'}{report && `：成功 ${report.filter(i => i.status === 'success').length}，跳过 ${report.filter(i => i.status === 'skipped').length}，降级 ${report.filter(i => i.status === 'degraded').length}，失败 ${report.filter(i => i.status === 'failed').length}`}</p><div className="max-h-64 divide-y overflow-auto">{reportRows.map((item,index) => <div key={index} className="px-4 py-2 text-xs"><Badge>{reportLabel[item.status]}</Badge><span className="ml-2 break-all">{item.path}</span><p className="mt-1 text-muted-foreground">{item.message}</p></div>)}</div></div>}
      <p className="text-xs text-muted-foreground">每批最多 500 篇 / 100 MB。远程图片不自动下载；不支持的块和缺失资源会列入报告。更深的目录会合并到第 8 层。</p>
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={running} onClick={() => onOpenChange(false)}>{report ? '关闭' : '取消'}</Button>{!report && <Button disabled={busy || !plan || !plan.items.length} onClick={run}>确认导入{plan ? ` ${plan.items.filter(item => item.action !== 'skip').length} 篇` : ''}</Button>}{report && <Button variant="outline" onClick={() => { setReport(null); void preview(); }}>重新预览</Button>}</div>
    </div>
  </DialogContent></Dialog>;
}
