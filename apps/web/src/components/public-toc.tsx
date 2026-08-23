import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListTree } from "lucide-react";
import { outlineOf, type OutlineItem } from "@kb/shared/markdown";
import { cn } from "../lib/utils";

function hashSlug() {
  try { return decodeURIComponent(window.location.hash.slice(1)); }
  catch { return window.location.hash.slice(1); }
}

function scrollToHeading(heading: HTMLElement, smooth: boolean) {
  const root = heading.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  if (root) {
    const top = root.scrollTop + heading.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
    root.scrollTo({ top, behavior });
  } else {
    const top = window.scrollY + heading.getBoundingClientRect().top - 64;
    window.scrollTo({ top, behavior });
  }
}

function TocLinks({ items, active, onPick }: { items: OutlineItem[]; active: string; onPick: (slug: string) => void }) {
  const minLevel = items.reduce((value, item) => Math.min(value, item.level), 6);
  return <nav aria-label="本文目录" className="space-y-0.5">
    {items.map(item => <a
      key={item.slug}
      href={`#${encodeURIComponent(item.slug)}`}
      aria-current={active === item.slug ? "location" : undefined}
      title={item.text}
      onClick={event => { event.preventDefault(); onPick(item.slug); }}
      style={{ paddingLeft: 10 + (item.level - minLevel) * 13 }}
      className={cn(
        "block truncate rounded-md py-1.5 pr-2 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
        item.level === minLevel ? "font-medium" : "text-muted-foreground",
        active === item.slug && "bg-accent text-foreground shadow-[inset_2px_0_0_var(--primary)]",
      )}
    >{item.text || "未命名章节"}</a>)}
  </nav>;
}

/** 分享页与文档站共用的正文 + 页内目录阅读壳。 */
export function PublicReadingLayout({ source, children, className }: { source: string; children: ReactNode; className?: string }) {
  const items = useMemo(() => outlineOf(source), [source]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mobileRef = useRef<HTMLDetailsElement | null>(null);
  const [active, setActive] = useState("");

  useEffect(() => {
    const content = contentRef.current;
    if (!content || !items.length) { setActive(""); return; }
    const headings = [...content.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")]
      .filter(heading => items.some(item => item.slug === heading.id));
    if (!headings.length) return;
    const root = content.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
    const chooseCurrent = () => {
      const boundary = (root?.getBoundingClientRect().top ?? 0) + 82;
      let hit = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > boundary) break;
        hit = heading;
      }
      setActive(hit.id);
    };
    const jumpFromHash = (smooth = false) => {
      const slug = hashSlug();
      const heading = headings.find(item => item.id === slug);
      if (!heading) { chooseCurrent(); return; }
      setActive(slug);
      scrollToHeading(heading, smooth);
    };
    const observer = new IntersectionObserver(chooseCurrent, { root, rootMargin: "-72px 0px -72% 0px", threshold: [0, 1] });
    headings.forEach(heading => observer.observe(heading));
    const frame = requestAnimationFrame(() => jumpFromHash(false));
    // 刷新带 hash 的 URL 时，浏览器自己的历史滚动恢复可能晚于首帧；布局稳定后再校准一次。
    const settleTimer = window.setTimeout(() => {
      jumpFromHash(true);
      const slug = hashSlug();
      const heading = headings.find(item => item.id === slug);
      if (!heading || Math.abs(heading.getBoundingClientRect().top - 64) < 48) return;
      // 部分浏览器会在异步正文挂载后再次恢复旧滚动位置。重新触发同文档 hash 导航，
      // 让浏览器用最终布局完成一次原生定位，同时不新增历史记录。
      const hash = window.location.hash;
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
      window.location.replace(hash);
    }, 400);
    const onHistory = () => jumpFromHash(false);
    window.addEventListener("hashchange", onHistory);
    window.addEventListener("popstate", onHistory);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener("hashchange", onHistory);
      window.removeEventListener("popstate", onHistory);
    };
  }, [items, source]);

  const pick = (slug: string) => {
    const heading = [...(contentRef.current?.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]") ?? [])].find(item => item.id === slug);
    if (!heading) return;
    window.history.pushState(null, "", `#${encodeURIComponent(slug)}`);
    setActive(slug);
    scrollToHeading(heading, true);
    if (mobileRef.current) mobileRef.current.open = false;
  };

  if (!items.length) return <div ref={contentRef} className={className}>{children}</div>;
  return <div className={cn("public-reading mx-auto w-full max-w-6xl", className)}>
    <details ref={mobileRef} className="mb-6 rounded-xl border bg-muted/20 p-3 xl:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><ListTree className="size-4" />本文目录 <span className="ml-auto text-xs font-normal text-muted-foreground">{items.length} 节</span></summary>
      <div className="mt-3 max-h-64 overflow-y-auto border-t pt-3"><TocLinks items={items} active={active} onPick={pick} /></div>
    </details>
    <div className="min-w-0 xl:grid xl:grid-cols-[minmax(0,1fr)_240px] xl:gap-10">
      <div ref={contentRef} className="min-w-0">{children}</div>
      <aside className="hidden xl:block" aria-label="文章大纲">
        <div className="sticky top-6 max-h-[calc(100vh-5rem)] overflow-y-auto border-l pl-4">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><ListTree className="size-3.5" />本文目录</p>
          <TocLinks items={items} active={active} onPick={pick} />
        </div>
      </aside>
    </div>
  </div>;
}
