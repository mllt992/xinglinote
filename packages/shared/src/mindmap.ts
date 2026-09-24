/**
 * 思维导图（设计 25）的纯数据逻辑：web 与 api 共用。
 *
 * 数据形状沿用 mind-elixir 的 `{ nodeData, direction }`，但**入库前一律白名单清洗**：
 * 导图会被同笔记本的其他成员打开，库里渲染时有几处走 innerHTML（dangerouslySetInnerHTML、
 * 连线/摘要标签），不能让一个人存进去的字段在别人浏览器里变成 HTML。
 */

export type MindMapStyle = Partial<Record<(typeof STYLE_KEYS)[number], string>>;
export type MindMapNode = {
  id: string;
  topic: string;
  children?: MindMapNode[];
  expanded?: boolean;
  direction?: 0 | 1;
  style?: MindMapStyle;
  tags?: string[];
  icons?: string[];
  branchColor?: string;
  /** 只允许站内笔记锚点 `#note:<uuid>` 或 http(s) 外链。 */
  hyperLink?: string;
  metadata?: { noteId?: string };
};
export type MindMapData = { nodeData: MindMapNode; direction: 0 | 1 | 2 | 3 };

export const MIND_MAP_LIMITS = { nodes: 3000, depth: 40, topic: 500, tags: 8, tag: 40, icons: 8, icon: 16, style: 80, link: 2000 } as const;
const STYLE_KEYS = ["fontSize", "fontFamily", "color", "background", "fontWeight", "width", "border", "textDecoration"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_LINK = /^#note:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class MindMapDataError extends Error {}

/** 节点关联笔记时写进 hyperLink 的值。只是个锚点，点击由前端拦截后在站内跳转。 */
export function noteLinkHref(noteId: string) { return `#note:${noteId.toLowerCase()}`; }
export function noteIdFromHref(href: string | undefined | null): string | null {
  const m = href ? NOTE_LINK.exec(href) : null;
  return m ? m[1]!.toLowerCase() : null;
}

/** 新导图：只有一个根节点。 */
export function emptyMindMap(title: string): MindMapData {
  return { nodeData: { id: "root", topic: title.trim() || "中心主题" }, direction: 2 };
}

function str(v: unknown, max: number) { return typeof v === "string" ? v.slice(0, max) : undefined; }
function safeLink(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > MIND_MAP_LIMITS.link) return undefined;
  if (NOTE_LINK.test(v)) return v.toLowerCase();
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined; } catch { return undefined; }
}

/**
 * 把前端传来的任意 JSON 洗成可入库的导图。未知字段（图片、自定义 HTML、连线、摘要……）一律丢掉。
 * 结构不对或超限抛 MindMapDataError，调用方转成 VALIDATION。
 */
export function sanitizeMindMap(input: unknown): MindMapData {
  if (!input || typeof input !== "object") throw new MindMapDataError("导图数据格式不对");
  const raw = input as { nodeData?: unknown; direction?: unknown };
  let count = 0;
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): MindMapNode => {
    if (!value || typeof value !== "object") throw new MindMapDataError("导图节点格式不对");
    if (depth > MIND_MAP_LIMITS.depth) throw new MindMapDataError(`导图最多 ${MIND_MAP_LIMITS.depth} 层`);
    if (++count > MIND_MAP_LIMITS.nodes) throw new MindMapDataError(`一张导图最多 ${MIND_MAP_LIMITS.nodes} 个节点`);
    const n = value as Record<string, unknown>;
    const id = typeof n.id === "string" && NODE_ID.test(n.id) ? n.id : null;
    if (!id) throw new MindMapDataError("导图节点缺少合法的 id");
    if (seen.has(id)) throw new MindMapDataError("导图里有重复的节点 id");
    seen.add(id);
    const out: MindMapNode = { id, topic: str(n.topic, MIND_MAP_LIMITS.topic) ?? "" };
    if (n.expanded === false) out.expanded = false;
    if (n.direction === 0 || n.direction === 1) out.direction = n.direction;
    if (n.style && typeof n.style === "object") {
      const style: MindMapStyle = {};
      for (const key of STYLE_KEYS) {
        const v = str((n.style as Record<string, unknown>)[key], MIND_MAP_LIMITS.style);
        // CSS 值里不许出现 url(…) / expression(…)，只留颜色、字号这类纯值。
        if (v && !/[;{}<>]|url\s*\(|expression\s*\(/i.test(v)) style[key] = v;
      }
      if (Object.keys(style).length) out.style = style;
    }
    if (Array.isArray(n.tags)) {
      const tags = n.tags.map(t => str(typeof t === "object" && t ? (t as { text?: unknown }).text : t, MIND_MAP_LIMITS.tag)).filter((t): t is string => !!t).slice(0, MIND_MAP_LIMITS.tags);
      if (tags.length) out.tags = tags;
    }
    if (Array.isArray(n.icons)) {
      const icons = n.icons.map(t => str(t, MIND_MAP_LIMITS.icon)).filter((t): t is string => !!t).slice(0, MIND_MAP_LIMITS.icons);
      if (icons.length) out.icons = icons;
    }
    const branchColor = str(n.branchColor, 32);
    if (branchColor && /^#[0-9a-f]{3,8}$/i.test(branchColor)) out.branchColor = branchColor;
    const link = safeLink(n.hyperLink);
    if (link) out.hyperLink = link;
    // 关联笔记以 hyperLink 为准，metadata.noteId 只是它的镜像，避免两处不一致。
    const noteId = noteIdFromHref(link);
    if (noteId) out.metadata = { noteId };
    if (Array.isArray(n.children) && n.children.length) out.children = n.children.map(child => walk(child, depth + 1));
    return out;
  };
  const nodeData = walk(raw.nodeData, 0);
  const direction = raw.direction === 0 || raw.direction === 1 || raw.direction === 3 ? raw.direction : 2;
  return { nodeData, direction };
}

/** 导图里关联了哪些笔记：去重后的 [{ nodeId, noteId }]，同一篇笔记只取第一次出现的节点。 */
export function extractMindMapNoteLinks(data: MindMapData): Array<{ nodeId: string; noteId: string }> {
  const out: Array<{ nodeId: string; noteId: string }> = [];
  const seen = new Set<string>();
  const walk = (n: MindMapNode) => {
    const noteId = noteIdFromHref(n.hyperLink);
    if (noteId && UUID.test(noteId) && !seen.has(noteId)) { seen.add(noteId); out.push({ nodeId: n.id, noteId }); }
    n.children?.forEach(walk);
  };
  walk(data.nodeData);
  return out;
}

export function countMindMapNodes(data: MindMapData) {
  let n = 0;
  const walk = (x: MindMapNode) => { n++; x.children?.forEach(walk); };
  walk(data.nodeData);
  return n;
}

type Outline = Array<{ level: number; text: string }>;

/**
 * 按层级大纲建树：level 越大越深，跳级（# 直接到 ###）挂到最近的上级。
 * 根节点是笔记标题并关联回这篇笔记。
 */
export function mindMapFromOutline(title: string, outline: Outline, opts: { noteId?: string; nextId?: () => string } = {}): MindMapData {
  let seq = 0;
  const nextId = opts.nextId ?? (() => `n${(++seq).toString(36)}`);
  const root: MindMapNode = { id: "root", topic: (title.trim() || "中心主题").slice(0, MIND_MAP_LIMITS.topic) };
  if (opts.noteId) { root.hyperLink = noteLinkHref(opts.noteId); root.metadata = { noteId: opts.noteId.toLowerCase() }; }
  const stack: Array<{ level: number; node: MindMapNode }> = [{ level: 0, node: root }];
  let count = 1;
  for (const item of outline) {
    const text = item.text.trim().slice(0, MIND_MAP_LIMITS.topic);
    if (!text) continue;
    if (++count > MIND_MAP_LIMITS.nodes) break;
    while (stack.length > 1 && stack[stack.length - 1]!.level >= item.level) stack.pop();
    if (stack.length > MIND_MAP_LIMITS.depth) continue;
    const node: MindMapNode = { id: nextId(), topic: text };
    const parent = stack[stack.length - 1]!.node;
    (parent.children ??= []).push(node);
    stack.push({ level: item.level, node });
  }
  return { nodeData: root, direction: 2 };
}

/**
 * 从 Markdown 列表（- / * / + / 1.）读出大纲，缩进决定层级。
 * 给「没有标题的笔记」和「AI 返回的要点列表」共用。代码块里的内容跳过。
 */
export function listOutline(markdown: string): Outline {
  const out: Outline = [];
  let fence = false;
  const indents: number[] = [];
  for (const line of markdown.replace(/\t/g, "  ").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (indents.length && indents[indents.length - 1]! > indent) indents.pop();
    if (!indents.length || indents[indents.length - 1]! < indent) indents.push(indent);
    const text = m[2]!.replace(/\*\*|__|`/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_s, t: string, a?: string) => a ?? t).trim();
    if (text) out.push({ level: indents.length, text });
  }
  return out;
}

/**
 * 把导图里关联的笔记 id 换成新 id（备份恢复时笔记会拿到新主键）。
 * 映射不到的关联直接去掉链接，节点本身保留。输入按不可信处理，先清洗再换。
 */
export function remapMindMapNotes(input: unknown, mapNote: (noteId: string) => string | null | undefined): MindMapData {
  const data = sanitizeMindMap(input);
  const walk = (n: MindMapNode): MindMapNode => {
    const out: MindMapNode = { ...n };
    const noteId = noteIdFromHref(n.hyperLink);
    if (noteId) {
      const next = mapNote(noteId);
      if (next) { out.hyperLink = noteLinkHref(next); out.metadata = { noteId: next.toLowerCase() }; }
      else { delete out.hyperLink; delete out.metadata; }
    }
    if (n.children) out.children = n.children.map(walk);
    return out;
  };
  return { ...data, nodeData: walk(data.nodeData) };
}
