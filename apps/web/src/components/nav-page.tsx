import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Compass, ExternalLink, Paintbrush, Search, Settings2, Sparkles } from "lucide-react";
import { api, type Me } from "../api";
import { cn } from "../lib/utils";
import { AppNav, loadLastWorkspace } from "./app-nav";
import { NotificationBell } from "./notifications";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type NavLinkDto = {
  id: string;
  groupId: string;
  title: string;
  url: string;
  description: string | null;
  iconUrl: string | null;
  sortKey: number;
};

export type NavGroupDto = {
  id: string;
  title: string;
  description: string | null;
  sortKey: number;
  links: NavLinkDto[];
};

export type NavCatalog = {
  enabled: boolean;
  public?: boolean;
  title: string;
  subtitle: string;
  groups: NavGroupDto[];
};

function useMe() {
  const [me, setMe] = useState<Me | null | undefined>();
  useEffect(() => { api<Me>("/api/v1/me").then(setMe).catch(() => setMe(null)); }, []);
  return me;
}

function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function hostOf(url: string) {
  if (url.startsWith("/")) return url;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isInternalUrl(url: string) {
  return url.startsWith("/") && !url.startsWith("//");
}

function matches(haystack: string, needle: string) {
  const h = haystack.toLocaleLowerCase();
  const n = needle.toLocaleLowerCase();
  if (h.includes(n)) return true;
  let at = 0;
  for (const ch of n) {
    at = h.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

export function NavIcon({ title, iconUrl, size = "md" }: { title: string; iconUrl: string | null; size?: "sm" | "md" }) {
  const [broken, setBroken] = useState(false);
  const letter = (title.trim()[0] || "#").toLocaleUpperCase();
  const box = size === "sm" ? "size-8 rounded-lg text-[13px]" : "size-10 rounded-[10px] text-sm";
  if (!iconUrl || broken) {
    return <span className={cn("grid shrink-0 place-items-center bg-foreground text-background font-semibold tracking-tight", box)}>{letter}</span>;
  }
  return <span className={cn("grid shrink-0 place-items-center overflow-hidden bg-muted ring-1 ring-inset ring-border", box)}>
    <img src={iconUrl} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
  </span>;
}

function Brand({ onClick }: { onClick?: () => void }) {
  const inner = <><span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-3.5" /></span><span>Knowledge</span></>;
  if (!onClick) return <div className="flex items-center gap-2.5 font-semibold tracking-[-0.03em]">{inner}</div>;
  return <button type="button" className="-mx-1 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 font-semibold tracking-[-0.03em] hover:bg-muted" onClick={onClick}>{inner}</button>;
}

export function NavPage() {
  const nav = useNavigate();
  const me = useMe();
  const searchRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<NavCatalog | null>(null);
  const [err, setErr] = useState<"auth" | "other" | "">("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("all");
  const [spaces, setSpaces] = useState<Array<{ id: string }>>([]);

  useEffect(() => {
    api<NavCatalog>("/api/v1/nav")
      .then(d => { setData(d); setErr(""); })
      .catch(e => {
        setData(null);
        setErr((e as { code?: string }).code === "UNAUTHENTICATED" ? "auth" : "other");
      });
  }, []);

  useEffect(() => {
    if (me) api<{ workspaces: Array<{ id: string }> }>("/api/v1/workspaces").then(d => setSpaces(d.workspaces)).catch(() => setSpaces([]));
  }, [me]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const last = loadLastWorkspace();
  const home = spaces.find(w => w.id === last)?.id ?? me?.personalWorkspaceId ?? spaces[0]?.id;
  const now = new Date();
  const dateLabel = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim();
    return data.groups.map(g => {
      const links = g.links.filter(l => {
        if (active !== "all" && g.id !== active) return false;
        if (!q) return true;
        return matches(`${g.title} ${l.title} ${l.description ?? ""} ${l.url} ${hostOf(l.url)}`, q);
      });
      return { ...g, links };
    }).filter(g => g.links.length > 0);
  }, [data, query, active]);

  const total = data?.groups.reduce((n, g) => n + g.links.length, 0) ?? 0;

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("");
      (e.target as HTMLInputElement).blur();
    }
  }

  return <div className="relative min-h-full bg-background">
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,color-mix(in_srgb,var(--foreground)_7%,transparent),transparent_68%)]" />
      <div className="absolute inset-x-0 top-0 h-[360px] opacity-[0.35] [background-image:linear-gradient(to_right,color-mix(in_srgb,var(--border)_70%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--border)_70%,transparent)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
    </div>

    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {home ? <Brand onClick={() => nav(`/w/${home}`)} /> : <Brand />}
        <AppNav wsId={home} active="nav" />
        <div className="ml-auto flex items-center gap-1">
          {me ? <>
            {me.instanceRole === "admin" && <Button variant="ghost" size="sm" onClick={() => nav("/admin?tab=nav")}><Settings2 />配置</Button>}
            <NotificationBell />
            <Button variant="ghost" size="icon" aria-label="外观设置" onClick={() => nav("/settings/appearance")}><Paintbrush /></Button>
            <Button variant="ghost" size="sm" onClick={() => nav(home ? `/w/${home}` : "/app")}>我的库</Button>
          </> : me === null ? <>
            <Button variant="ghost" size="sm" onClick={() => nav("/login?next=/nav")}>登录</Button>
            <Button size="sm" onClick={() => nav("/register")}>注册</Button>
          </> : null}
        </div>
      </div>
    </header>

    <main className="relative mx-auto w-full max-w-[1180px] px-4 pb-20 pt-10 sm:px-6 sm:pt-14">
      {err === "auth" && <Empty
        icon={<Compass />}
        title="登录后查看导航"
        text="这个实例的导航只对登录用户开放。"
        action={<Button onClick={() => nav("/login?next=/nav")}>登录</Button>}
      />}

      {err === "other" && <Empty icon={<Compass />} title="导航暂时打不开" text="过一会儿再试，或者联系管理员。" />}

      {!err && !data && <div className="space-y-8">
        <div className="h-8 w-28 animate-pulse rounded-md bg-muted" />
        <div className="h-12 w-56 animate-pulse rounded-md bg-muted" />
        <div className="h-12 max-w-xl animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}</div>
      </div>}

      {!err && data && !data.enabled && <Empty
        icon={<Compass />}
        title="导航已关闭"
        text="管理员关掉了这个入口。"
        action={me?.instanceRole === "admin" ? <Button onClick={() => nav("/admin?tab=nav")}>去打开</Button> : undefined}
      />}

      {!err && data && data.enabled && <>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[13px] text-muted-foreground">{greeting()} · {dateLabel}</p>
            <h1 className="mt-2 text-[2rem] font-semibold leading-none tracking-[-0.045em] sm:text-[2.5rem]">{data.title}</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{data.subtitle}</p>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">{total} 个站点 · {data.groups.length} 个分组</p>
        </div>

        <div className="relative mt-8 max-w-xl">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="搜索站点、分组或地址"
            className="h-12 rounded-xl border-border/80 bg-background/80 pl-10 pr-14 shadow-none"
            aria-label="搜索导航"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline">/</kbd>
        </div>

        {total === 0 ? <Empty
          icon={<Compass />}
          title="还没有站点"
          text="管理员把常用去处配进来之后，就会出现在这里。"
          action={me?.instanceRole === "admin" ? <Button onClick={() => nav("/admin?tab=nav")}>去配置</Button> : undefined}
        /> : <div className="mt-10 grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-24 lg:self-start">
            <p className="mb-2 hidden text-[11px] font-medium tracking-[0.14em] text-muted-foreground lg:block">分组</p>
            <nav aria-label="导航分组" className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              <RailButton current={active === "all"} onClick={() => setActive("all")} label="全部" count={total} />
              {data.groups.map(g => <RailButton key={g.id} current={active === g.id} onClick={() => setActive(g.id)} label={g.title} count={g.links.length} />)}
            </nav>
          </aside>

          <div className="min-w-0 space-y-10">
            {filtered.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">没有匹配「{query}」的站点。</p>}
            {filtered.map(g => <section key={g.id} id={`nav-${g.id}`}>
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.03em]">{g.title}</h2>
                  {g.description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{g.description}</p>}
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">{g.links.length}</span>
              </div>
              <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {g.links.map(link => <li key={link.id}><NavCard link={link} /></li>)}
              </ul>
            </section>)}
          </div>
        </div>}
      </>}
    </main>
  </div>;
}

function RailButton({ current, onClick, label, count }: { current: boolean; onClick: () => void; label: string; count: number }) {
  return <button type="button" onClick={onClick} aria-current={current ? "true" : undefined}
    className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
      current ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
    <span className="truncate">{label}</span>
    <span className={cn("ml-auto text-[11px] tabular-nums", current ? "text-background/70" : "text-muted-foreground")}>{count}</span>
  </button>;
}

function NavCard({ link }: { link: NavLinkDto }) {
  const internal = isInternalUrl(link.url);
  const className = "group flex items-center gap-3 rounded-xl border border-border/80 bg-background/70 px-3.5 py-3 outline-none transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50";
  const body = <>
    <NavIcon title={link.title} iconUrl={link.iconUrl} />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium tracking-[-0.01em]">{link.title}</span>
        {!internal && <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{link.description || hostOf(link.url)}</span>
    </span>
  </>;
  if (internal) return <Link to={link.url} className={className}>{body}</Link>;
  return <a href={link.url} target="_blank" rel="noopener noreferrer" className={className}>{body}</a>;
}

function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="mx-auto max-w-md py-24 text-center">
    <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-muted/60 text-muted-foreground">{icon}</span>
    <p className="mt-5 text-base font-medium tracking-[-0.02em]">{title}</p>
    <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{text}</p>
    {action && <div className="mt-6">{action}</div>}
  </div>;
}
