import { useEffect, useState } from "react";
import { FileText, Globe2 } from "lucide-react";
import { api } from "../api";

export type PublicNotebook = {
  id: string;
  title: string;
  workspace: string;
  url: string;
  noteCount: number;
  updatedAt: string;
  accent: string | null;
  kind?: "site" | "folder" | "notebook";
};
export type PublicArticle = {
  id: string;
  title: string;
  notebook: string;
  workspace: string;
  url: string;
  snippet: string;
  updatedAt: string;
};
export type PublicCatalog = { notebooks: PublicNotebook[]; articles: PublicArticle[] };

export function usePublicCatalog() {
  const [data, setData] = useState<PublicCatalog | null>(null);
  useEffect(() => {
    api<PublicCatalog>("/api/v1/feed/public/catalog")
      .then(setData)
      .catch(() => setData({ notebooks: [], articles: [] }));
  }, []);
  return data;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="rounded-2xl border border-dashed py-14 text-center">
    <p className="text-sm font-medium">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">{text}</p>
  </div>;
}

/** 广场「笔记本 / 文章」两个板块的完整列表。 */
export function SquareCatalog({ kind }: { kind: "notebooks" | "articles" }) {
  const data = usePublicCatalog();
  if (!data) return <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>;
  if (kind === "notebooks") {
    if (!data.notebooks.length) return <Empty title="还没有公开的笔记本" text="把笔记本发布成文档站，或把目录 / 整本公开收录后，会出现在这里。" />;
    return <ul className="space-y-3">{data.notebooks.map(nb => <li key={nb.id}>
      <a href={nb.url} className="flex items-start gap-3 rounded-2xl border bg-background p-4 hover:bg-muted/40">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Globe2 className="size-4" /></span>
        <span className="min-w-0">
          <b className="block truncate text-sm font-medium">{nb.title}</b>
          <span className="mt-1 block text-xs text-muted-foreground">{nb.workspace} · {nb.noteCount} 篇{nb.kind === "folder" ? " · 目录分享" : nb.kind === "notebook" ? " · 整本分享" : "公开文章"}</span>
        </span>
      </a>
    </li>)}</ul>;
  }
  if (!data.articles.length) return <Empty title="还没有公开的文章" text="文档站里发布单篇后，会出现在这里。" />;
  return <ul className="space-y-3">{data.articles.map(a => <li key={a.id}>
    <a href={a.url} className="block rounded-2xl border bg-background p-4 hover:bg-muted/40">
      <span className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><FileText className="size-4" /></span>
        <span className="min-w-0">
          <b className="block text-sm font-medium">{a.title}</b>
          <span className="mt-1 block text-xs text-muted-foreground">{a.notebook} · {a.workspace}</span>
        </span>
      </span>
      {a.snippet && <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{a.snippet}</p>}
    </a>
  </li>)}</ul>;
}
