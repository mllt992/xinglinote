import { useEffect, useId, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, BarChart3, BookOpen, CheckCheck, ChevronDown, FileText, FolderOpen, Hash, Link2, LoaderCircle, Paperclip, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { AnalyticsDay, AnalyticsDistribution, WorkspaceAnalytics } from "@kb/shared";
import { api } from "../api";
import { analyticsPercent, trendGeometry } from "../lib/analytics-chart";
import { cn } from "../lib/utils";
import { SettingsShell, cardCls } from "./settings-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const number = (n: number) => n.toLocaleString("zh-CN");
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const dateLabel = (date: string) => date.slice(5).replace("-", "/");
const selectCls = "h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 数据跟随 URL；请求过期即丢弃。旧数据只在同工作区筛选刷新时短暂保留。 */
export function AnalyticsPage() {
  const { wsId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const notebookId = params.get("notebookId") ?? "";
  const days = params.get("days") === "7" ? 7 : 30;
  const [result, setResult] = useState<{ key: string; data: WorkspaceAnalytics } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [reload, setReload] = useState(0);
  const key = `${wsId}/${notebookId}/${days}/${reload}`;
  const data = result?.data.workspace.id === wsId ? result.data : null;
  const error = failure?.key === key ? failure.message : "";
  const refreshing = !error && result?.key !== key;
  const notebookSelectId = useId();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ days: String(days) });
    if (notebookId) query.set("notebookId", notebookId);
    api<WorkspaceAnalytics>(`/api/v1/workspaces/${wsId}/analytics?${query}`, { signal: controller.signal })
      .then(next => {
        if (controller.signal.aborted) return;
        setResult({ key, data: next });
        setFailure(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setResult(null);
        setFailure({ key, message: cause instanceof Error ? cause.message : "暂时无法读取统计，请重试" });
      });
    return () => controller.abort();
  }, [wsId, notebookId, days, key]);

  const selectNotebook = (id: string) => {
    if (id === notebookId) return;
    const next = new URLSearchParams(params);
    id ? next.set("notebookId", id) : next.delete("notebookId");
    setParams(next);
  };
  const selectDays = (nextDays: 7 | 30) => {
    if (nextDays === days) return;
    const next = new URLSearchParams(params);
    next.set("days", String(nextDays));
    setParams(next);
  };
  const activeTitle = data?.scope.title ?? (notebookId ? "笔记本统计" : "全部可读笔记本");

  return <SettingsShell wsId={wsId} current="analytics" workspace={data?.workspace} title="数据统计" subtitle="看看知识如何积累，也找到下一条连接。">
    <div className="space-y-4" data-testid="analytics-page">
      <section className={cn(cardCls, "p-4 sm:p-5")} aria-label="统计筛选">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-primary"><BarChart3 className="size-5" /></span>
            <div className="min-w-0"><p className="text-xs text-muted-foreground">统计范围</p><h2 className="truncate text-base font-semibold" title={activeTitle}>{activeTitle}</h2></div>
          </div>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => setReload(n => n + 1)} aria-label="刷新统计"><RefreshCw className={cn(refreshing && "motion-safe:animate-spin")} />刷新</Button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <label htmlFor={notebookSelectId} className="mb-1.5 block text-xs font-medium text-muted-foreground">笔记本</label>
            <select id={notebookSelectId} value={notebookId} className={cn(selectCls, "w-full")} onChange={e => selectNotebook(e.target.value)}>
              <option value="">整个工作区 · 可读范围</option>
              {notebookId && !data?.notebooks.some(n => n.id === notebookId) && <option value={notebookId}>所选笔记本</option>}
              {data?.notebooks.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
            </select>
          </div>
          <div className="flex h-9 rounded-lg border border-border bg-muted p-0.5" role="group" aria-label="趋势时间范围">
            {([7, 30] as const).map(n => <button key={n} type="button" aria-pressed={days === n} onClick={() => selectDays(n)} className={cn("rounded-md px-3 text-sm outline-none motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-ring", days === n ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>近 {n} 天</button>)}
          </div>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />只统计你当前能读取的内容，不含回收站。每日趋势按 UTC 自然日汇总。</p>
      </section>

      <div role="status" aria-live="polite" className="min-h-5 text-xs text-muted-foreground">
        {refreshing ? <span className="flex items-center gap-1.5"><LoaderCircle className="size-3.5 motion-safe:animate-spin" />{data ? `正在刷新，下面暂为「${data.scope.title}」近 ${data.scope.days} 天的数据` : "正在汇总可读内容…"}</span>
          : data && !error ? `实时聚合 · ${new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新` : ""}
      </div>
      {error ? <section className={cn(cardCls, "p-8 text-center")} role="alert">
        <TriangleAlert className="mx-auto size-7 text-muted-foreground" /><h2 className="mt-3 font-semibold">暂时无法显示统计</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={() => setReload(n => n + 1)}>重试</Button>{notebookId && <Button variant="outline" onClick={() => selectNotebook("")}><ArrowLeft />返回工作区统计</Button>}</div>
      </section> : !data ? <AnalyticsSkeleton /> : <div aria-busy={refreshing} className={cn("space-y-4 motion-safe:transition-opacity motion-safe:duration-200", refreshing && "opacity-60")}>
        {data.notebooks.length === 0 ? <EmptyState title="还没有可读的笔记本" detail="新建一本笔记本，或请工作区管理员为你开放读取权限后，再来看看。" /> : <>
          {data.summary.notes === 0 && <EmptyState title="这片知识库还很安静" detail="当前范围还没有笔记。开始记录后，结构、趋势和内容画像会在这里呈现。" />}
          <div key={`${data.scope.notebookId}/${data.scope.days}`} className="space-y-4 motion-safe:animate-overlay-in">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Metric icon={<FileText />} label="笔记" value={number(data.summary.notes)} hint={`${number(data.summary.notebooks)} 本 · ${number(data.summary.folders)} 个文件夹`} />
              <Metric icon={<Hash />} label="正文字符" value={number(data.summary.characters)} hint="含 Markdown 标记与空白" />
              <Metric icon={<Paperclip />} label="附件" value={number(data.summary.attachments)} hint={`${number(data.summary.images)} 张图片 · ${bytes(data.summary.attachmentBytes)}`} />
              <Metric icon={<ArrowUpRight />} label={`近 ${data.scope.days} 天新建`} value={number(data.summary.created)} hint={`${number(data.summary.edited)} 篇有编辑版本记录`} />
            </div>
            <TrendCard data={data} />
            <div className="grid gap-4 xl:grid-cols-2"><ContentProfile data={data} /><NotebookComparison data={data} onSelect={selectNotebook} /></div>
            <div className="grid gap-4 md:grid-cols-2">
              <Distribution icon={<FolderOpen className="size-4" />} title="文件夹分布" subtitle="按直接所属目录统计" rows={data.folders} total={data.summary.notes} empty="还没有目录中的内容" footer={data.folderOtherNotes > 0 ? `其余目录还有 ${number(data.folderOtherNotes)} 篇笔记` : "根目录包括未放入目录的笔记"} />
              <Distribution icon={<Hash className="size-4" />} title="常用标签" subtitle="最常出现的 8 个标签" rows={data.tags} total={data.summary.notes} empty="还没有使用标签" footer="同一篇可有多个标签，合计可能超过笔记总数" />
            </div>
          </div>
          <details className={cn(cardCls, "px-4 py-3 text-xs text-muted-foreground")}>
            <summary className="cursor-pointer font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">这些数字怎么算？</summary>
            <ul className="mt-3 list-disc space-y-2 pl-4 leading-relaxed">
              <li>每天的「编辑笔记」是当天有版本号大于 1 的留存快照的笔记数，同一天去重。版本快照含初版；5 分钟内合并保存与历史清理会影响统计，因此它不是每次按保存的次数。</li>
              <li>趋势只统计当前可读、未删除的笔记；删除、迁移或权限变化可能改变历史数字。日期范围为 {data.scope.from} 至 {data.scope.through}（UTC）。</li>
              <li>双链只计两端都可读的、已解析且非自身的笔记连接，同一方向的重复链接只计一次。单本统计包含与其它可读笔记本的连接。</li>
              <li>任务只计从当前笔记同步、仍关联正文的复选框，不含手动日历任务或项目任务。已发布笔记需要文档站上线且通过审核。</li>
              <li>附件占用按引用累加，可能高于去重后的物理存储。字符量包括 Markdown 标记和空白，不是自然语言分词结果。</li>
            </ul>
          </details>
        </>}
      </div>}
    </div>
  </SettingsShell>;
}

function Metric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
  return <section className={cn(cardCls, "min-w-0 p-4")}><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="[&>svg]:size-4">{icon}</span>{label}</div><p className="mt-3 break-all text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">{value}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p></section>;
}
function CardTitle({ icon, title, subtitle, action }: { icon: ReactNode; title: string; subtitle: string; action?: ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h3><p className="mt-1 text-xs text-muted-foreground">{subtitle}</p></div>{action}</header>;
}

function TrendCard({ data }: { data: WorkspaceAnalytics }) {
  const [active, setActive] = useState<number | null>(null);
  const clipId = useId();
  const chart = trendGeometry(data.trend);
  const hover = data.trend[active ?? -1];
  const baseline = chart.y(0);
  const daily = (day: AnalyticsDay) => `${day.date}：新建 ${day.created} 篇，编辑 ${day.edited} 篇，版本快照 ${day.versions} 个`;
  const legends = [{ key: "created", title: "新建笔记", value: data.summary.created, cls: "border-primary" }, { key: "edited", title: "编辑笔记", value: data.summary.edited, cls: "border-foreground border-dashed" }, { key: "versions", title: "版本快照", value: data.summary.versions, cls: "border-muted-foreground border-dotted" }];
  return <section className={cn(cardCls, "overflow-hidden")}>
    <CardTitle icon={<BarChart3 className="size-4" />} title="记录的节奏" subtitle={`近 ${data.scope.days} 天 · UTC · 只统计留存的版本快照`} />
    <div className="p-4 sm:p-5">
      <div className="flex flex-wrap gap-x-6 gap-y-3">{legends.map(item => <div key={item.key}><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className={cn("w-5 border-t-2", item.cls)} />{item.title}</div><p className="mt-1 text-xl font-semibold tabular-nums">{number(item.value)}</p></div>)}</div>
      <div className="relative mt-5 pl-7">
        <div aria-hidden="true" className="absolute inset-y-0 left-0 flex flex-col justify-between pb-2 text-[10px] tabular-nums text-muted-foreground"><span>{chart.ceiling}</span><span>{chart.ceiling / 2}</span><span>0</span></div>
        <svg viewBox="0 0 600 180" className="block w-full overflow-visible" role="group" aria-label="每日新建、编辑和版本快照趋势，聚焦日期查看数值" onMouseLeave={() => setActive(null)}>
          <defs><clipPath id={clipId}><rect width="600" height="180" /></clipPath></defs>
          {[0, chart.ceiling / 2, chart.ceiling].map(n => <line key={n} x1="0" x2="600" y1={chart.y(n)} y2={chart.y(n)} stroke="var(--border-ui)" strokeDasharray={n === 0 ? undefined : "3 5"} />)}
          <g clipPath={`url(#${clipId})`}>
            <path d={`${chart.created} L592,${baseline} L8,${baseline} Z`} fill="var(--primary)" opacity="0.06" />
            <path d={chart.versions} fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" />
            <path d={chart.edited} fill="none" stroke="var(--foreground)" strokeWidth="2" strokeDasharray="7 5" strokeLinejoin="round" />
            <path d={chart.created} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          {data.trend.map((day, i) => <g key={day.date} tabIndex={0} role="img" aria-label={daily(day)} className="outline-none" onFocus={() => setActive(i)} onBlur={() => setActive(null)} onMouseEnter={() => setActive(i)}>
            <rect x={chart.x(i) - 8} y="0" width="16" height="180" fill="transparent" />
            {active === i && <line x1={chart.x(i)} x2={chart.x(i)} y1="4" y2="176" stroke="var(--muted-foreground)" strokeDasharray="2 4" />}
            <circle cx={chart.x(i)} cy={chart.y(day.created)} r={active === i ? 5 : 2.5} fill="var(--background)" stroke="var(--primary)" strokeWidth="2" className="motion-safe:transition-[r] motion-safe:duration-150" />
          </g>)}
        </svg>
        <div aria-hidden="true" className="mt-2 flex justify-between text-[10px] tabular-nums text-muted-foreground"><span>{dateLabel(data.scope.from)}</span><span>{dateLabel(data.trend[Math.floor(data.trend.length / 2)]!.date)}</span><span>{dateLabel(data.scope.through)}</span></div>
      </div>
      <p className="mt-3 min-h-8 text-xs leading-relaxed text-muted-foreground" aria-live="polite">{hover ? daily(hover) : data.summary.created + data.summary.versions === 0 ? "这段时间还没有新建或留存的版本记录，下一次记录会从这里开始。" : "将指针或键盘焦点移到日期查看详情；编辑笔记总数在整个时间范围内去重。"}</p>
      <details className="mt-2 border-t border-border pt-3"><summary className="flex w-fit cursor-pointer items-center gap-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">查看每日数据<ChevronDown className="size-3" /></summary><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-right text-xs tabular-nums"><caption className="sr-only">每日新建笔记、编辑笔记与版本快照（UTC）</caption><thead><tr className="border-b border-border text-muted-foreground"><th className="py-2 text-left" scope="col">日期</th><th scope="col">新建</th><th scope="col">编辑</th><th scope="col">版本</th></tr></thead><tbody>{data.trend.map(day => <tr key={day.date} className="border-b border-border/60 last:border-0"><th scope="row" className="py-2 text-left font-normal">{day.date}</th><td>{day.created}</td><td>{day.edited}</td><td>{day.versions}</td></tr>)}</tbody></table></div></details>
    </div>
  </section>;
}

function ContentProfile({ data }: { data: WorkspaceAnalytics }) {
  const s = data.summary;
  const connected = analyticsPercent(s.connectedNotes, s.notes);
  const done = analyticsPercent(s.tasksDone, s.tasks);
  return <section className={cn(cardCls, "overflow-hidden")}>
    <CardTitle icon={<Link2 className="size-4" />} title="内容画像" subtitle="连接、待办与对外发布" />
    <div className="space-y-5 p-4">
      <div className="flex items-center gap-4">
        <div className="relative size-24 shrink-0"><svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true"><circle cx="50" cy="50" r="39" fill="none" stroke="var(--muted)" strokeWidth="9" /><circle cx="50" cy="50" r="39" fill="none" stroke="var(--primary)" strokeWidth="9" pathLength="100" strokeDasharray={`${connected} ${100 - connected}`} strokeLinecap={connected ? "round" : "butt"} className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-300" /></svg><div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-semibold tabular-nums">{connected}%</span><span className="text-[10px] text-muted-foreground">已连接</span></div></div>
        <div className="min-w-0"><p className="text-sm font-medium">{number(s.links)} 条可读双链</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{number(s.connectedNotes)} 篇笔记有连接<br />{number(s.isolatedNotes)} 篇孤立笔记 · {analyticsPercent(s.isolatedNotes, s.notes)}%</p></div>
      </div>
      <div className="border-t border-border pt-4"><div className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-1.5"><CheckCheck className="size-4 text-muted-foreground" />笔记任务完成率</span><span className="tabular-nums">{s.tasks ? `${number(s.tasksDone)} / ${number(s.tasks)} · ${done}%` : "暂无任务"}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="笔记任务完成率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={done}><div className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${done}%` }} /></div><p className="mt-2 text-xs text-muted-foreground">仅计算仍与正文关联的同步复选框</p></div>
      <div className="flex items-center justify-between border-t border-border pt-3 text-xs"><span className="text-muted-foreground">文档站已发布笔记</span><span className="font-medium tabular-nums">{number(s.published)} 篇</span></div>
    </div>
  </section>;
}

function NotebookComparison({ data, onSelect }: { data: WorkspaceAnalytics; onSelect: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [metric, setMetric] = useState<"notes" | "characters" | "edited">("notes");
  const ranked = [...data.notebooks].sort((a, b) => b[metric] - a[metric] || a.title.localeCompare(b.title));
  const rows = expanded ? ranked : ranked.slice(0, 8);
  const max = Math.max(1, ...ranked.map(n => n[metric]));
  const unit = metric === "characters" ? "字符" : "篇";
  return <section className={cn(cardCls, "overflow-hidden")}>
    <CardTitle icon={<BookOpen className="size-4" />} title="笔记本对比" subtitle="工作区可读范围 · 点击下钻" action={data.scope.notebookId ? <Button variant="ghost" size="sm" onClick={() => onSelect("")}>全部</Button> : <Badge>{data.notebooks.length} 本</Badge>} />
    <div className="px-4 pt-3"><select aria-label="笔记本对比指标" value={metric} onChange={e => setMetric(e.target.value as typeof metric)} className={cn(selectCls, "w-full")}><option value="notes">笔记数量</option><option value="characters">正文字符量</option><option value="edited">近 {data.scope.days} 天编辑笔记</option></select></div>
    <div className="max-h-96 space-y-1 overflow-y-auto p-3">
      {rows.map(n => <button key={n.id} type="button" aria-pressed={data.scope.notebookId === n.id} aria-label={`查看 ${n.title} 的统计，${n[metric]} ${unit}`} onClick={() => onSelect(n.id)} className={cn("group block w-full rounded-lg p-2 text-left outline-none motion-safe:transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", data.scope.notebookId === n.id && "bg-muted")}>
        <div className="flex items-center justify-between gap-3 text-xs"><span className="truncate font-medium" title={n.title}>{n.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{number(n[metric])} {unit} <ArrowUpRight className="ml-1 inline size-3" /></span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/70 motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${n[metric] / max * 100}%` }} /></div>
      </button>)}
    </div>
    {data.notebooks.length > 8 && <div className="border-t border-border px-4 py-2"><Button size="sm" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : `查看全部 ${data.notebooks.length} 本`}</Button></div>}
  </section>;
}

function Distribution({ icon, title, subtitle, rows, total, empty, footer }: { icon: ReactNode; title: string; subtitle: string; rows: AnalyticsDistribution[]; total: number; empty: string; footer: string }) {
  return <section className={cn(cardCls, "overflow-hidden")}><CardTitle icon={icon} title={title} subtitle={subtitle} /><div className="space-y-4 p-4">{rows.length ? rows.map(row => <div key={row.id}><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate" title={row.title}>{row.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{number(row.notes)} · {analyticsPercent(row.notes, total)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/60 motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${analyticsPercent(row.notes, total)}%` }} /></div></div>) : <p className="py-5 text-center text-sm text-muted-foreground">{empty}</p>}<p className="text-xs leading-relaxed text-muted-foreground">{footer}</p></div></section>;
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className={cn(cardCls, "flex items-start gap-3 p-5")}><BookOpen className="mt-0.5 size-5 shrink-0 text-muted-foreground" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p></div></section>;
}
function AnalyticsSkeleton() {
  return <div aria-label="正在加载统计" role="status" className="space-y-4"><div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map(n => <div key={n} className={cn(cardCls, "h-32 bg-muted/50 motion-safe:animate-pulse")} />)}</div><div className={cn(cardCls, "h-80 bg-muted/50 motion-safe:animate-pulse")} /><div className="grid gap-4 md:grid-cols-2"><div className={cn(cardCls, "h-64 bg-muted/50 motion-safe:animate-pulse")} /><div className={cn(cardCls, "h-64 bg-muted/50 motion-safe:animate-pulse")} /></div></div>;
}
