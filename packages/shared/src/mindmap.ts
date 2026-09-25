/**
 * 思维导图 / 画板（设计 25）的纯数据逻辑：web 与 api 共用。
 *
 * 思维导图的数据形状沿用 simple-mind-map 的 `{ layout, root, theme }`，但**入库前一律白名单清洗**：
 * 导图会被同笔记本的其他成员打开，库里个别字段（richText 等）会走 innerHTML，
 * 不能让一个人存进去的字段在别人浏览器里变成 HTML。
 *
 * 第一版（mind-elixir 的 `{ nodeData, direction }`）读到时自动转换，不丢内容。
 */

export const MIND_MAP_FORMAT = 2 as const;
export type BoardKind = "mindmap" | "drawio";
export const BOARD_KINDS: readonly BoardKind[] = ["mindmap", "drawio"];

export const MIND_MAP_LAYOUTS = [
  { value: "mindMap", label: "思维导图（两侧）" },
  { value: "logicalStructure", label: "逻辑图（向右）" },
  { value: "logicalStructureLeft", label: "逻辑图（向左）" },
  { value: "organizationStructure", label: "组织结构图" },
  { value: "catalogOrganization", label: "目录组织图" },
  { value: "timeline", label: "时间轴" },
  { value: "timeline2", label: "时间轴（上下交替）" },
  { value: "verticalTimeline", label: "竖向时间轴" },
  { value: "verticalTimeline2", label: "竖向时间轴（靠左）" },
  { value: "verticalTimeline3", label: "竖向时间轴（靠右）" },
  { value: "fishbone", label: "鱼骨图" },
  { value: "fishbone2", label: "鱼骨图（斜线）" },
  { value: "rightFishbone", label: "鱼骨图（向右）" },
  { value: "rightFishbone2", label: "鱼骨图（向右斜线）" },
] as const;
export type MindMapLayout = (typeof MIND_MAP_LAYOUTS)[number]["value"];
const LAYOUT_VALUES = new Set<string>(MIND_MAP_LAYOUTS.map(l => l.value));

export type MindMapNodeData = { text: string; uid: string; [key: string]: unknown };
export type MindMapNode = { data: MindMapNodeData; children: MindMapNode[] };
export type MindMapTheme = { template: string; config: Record<string, unknown> };
export type MindMapData = { format: typeof MIND_MAP_FORMAT; layout: MindMapLayout; root: MindMapNode; theme: MindMapTheme };
export type DrawioData = { format: "drawio"; xml: string; noteIds: string[] };
export type BoardData = MindMapData | DrawioData;

export const MIND_MAP_LIMITS = {
  nodes: 5000, depth: 50, text: 2000, note: 20_000, tags: 10, tag: 40, icons: 20, link: 2000,
  /** 单张节点图片（data URL）字符数上限，前端上传前会先压缩到这个以内。 */
  image: 1_500_000,
  /** 整张导图 JSON 的字节上限（含图片）。 */
  bytes: 12_000_000,
  drawioXml: 8_000_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_LINK = /^#note:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const ICON = /^[a-zA-Z]+_[a-zA-Z0-9]+$/;
const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
/** CSS / SVG 属性值里不许出现的东西：标签、url(…)、expression(…)、javascript:、语句分隔。 */
const UNSAFE_VALUE = /[<>;{}]|url\s*\(|expression\s*\(|javascript:/i;

/** 这些键不是样式，要么单独处理，要么直接丢掉（richText 会让库走 innerHTML）。 */
const HANDLED_KEYS = new Set([
  "text", "uid", "expand", "image", "imageTitle", "imageSize", "icon", "tag", "hyperlink", "hyperlinkTitle", "note",
  "generalization", "associativeLineTargets", "associativeLineText", "associativeLinePoint", "associativeLineTargetControlOffsets",
  "associativeLineStyle", "outerFrame", "customLeft", "customTop", "customTextWidth", "dir",
]);
const DROPPED_KEYS = new Set([
  "richText", "resetRichText", "isActive", "activeStyle", "attachmentUrl", "attachmentName", "needUpdate", "imgMap", "nodeLink",
  "notation", "number", "range", "checkbox", "isCreateByInput", "inserting", "userList", "lineFlow",
]);

export class MindMapDataError extends Error {}

/** 节点关联笔记时写进 hyperlink 的值。只是个锚点，点击由前端拦截后在站内跳转。 */
export function noteLinkHref(noteId: string) { return `#note:${noteId.toLowerCase()}`; }
export function noteIdFromHref(href: unknown): string | null {
  const m = typeof href === "string" ? NOTE_LINK.exec(href) : null;
  return m ? m[1]!.toLowerCase() : null;
}

function newUid() {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 新导图：只有一个根节点，布局默认两侧展开，主题跟随站点。 */
export function emptyMindMap(title: string): MindMapData {
  return { format: MIND_MAP_FORMAT, layout: "mindMap", root: { data: { text: title.trim() || "中心主题", uid: newUid() }, children: [] }, theme: { template: "kb", config: {} } };
}
export function emptyDrawio(): DrawioData {
  return { format: "drawio", xml: "", noteIds: [] };
}

const str = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : undefined;
function safeLink(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > MIND_MAP_LIMITS.link) return undefined;
  if (NOTE_LINK.test(v)) return v.toLowerCase();
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined; } catch { return undefined; }
}
/** 富文本 / 导入内容里的 HTML 退成纯文本。 */
export function htmlToText(html: string) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n").trim();
}
function primitive(v: unknown): string | number | boolean | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= 200 && !UNSAFE_VALUE.test(v) ? v : undefined;
  return undefined;
}
/** 样式值：纯量，或不超过 4 个数字的数组（渐变方向之类）。 */
function styleValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.length <= 4 && v.every(x => typeof x === "number" && Number.isFinite(x)) ? v : undefined;
  return primitive(v);
}
/** 只由纯量、数组、对象组成的小结构（关联线控制点、外框样式……），深度与大小都有限。 */
function plain(v: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => plain(x, depth + 1)).filter(x => x !== undefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (++n > 200 || !/^[A-Za-z0-9_-]{1,64}$/.test(k)) continue;
      const y = plain(x, depth + 1);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v === null ? undefined : primitive(v);
}
function styles(src: Record<string, unknown>, out: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (HANDLED_KEYS.has(k) || DROPPED_KEYS.has(k) || !KEY.test(k) || /^on/i.test(k)) continue;
    const s = styleValue(v);
    if (s !== undefined) out[k] = s;
  }
}
function textOf(d: Record<string, unknown>, max: number) {
  const raw = typeof d.text === "string" ? d.text : typeof d.text === "number" ? String(d.text) : "";
  return (d.richText ? htmlToText(raw) : raw).slice(0, max);
}
function generalization(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const g = v as Record<string, unknown>;
  const out: Record<string, unknown> = { text: textOf(g, 500) };
  if (typeof g.uid === "string" && NODE_ID.test(g.uid)) out.uid = g.uid;
  if (typeof g.expand === "boolean") out.expand = g.expand;
  if (Array.isArray(g.range) && g.range.length === 2 && g.range.every(x => Number.isInteger(x))) out.range = g.range;
  styles(g, out);
  return out;
}

type Legacy = { id?: unknown; topic?: unknown; children?: unknown; expanded?: unknown; hyperLink?: unknown; tags?: unknown; icons?: unknown; style?: unknown; branchColor?: unknown };
/** 第一版 mind-elixir 数据 → simple-mind-map 形状。 */
function fromLegacy(raw: { nodeData?: unknown; direction?: unknown }): unknown {
  const walk = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const n = value as Legacy;
    const icons = Array.isArray(n.icons) ? n.icons.filter((x): x is string => typeof x === "string").join("") : "";
    const data: Record<string, unknown> = { uid: n.id, text: `${icons}${typeof n.topic === "string" ? n.topic : ""}` };
    if (n.expanded === false) data.expand = false;
    if (n.hyperLink) data.hyperlink = n.hyperLink;
    if (Array.isArray(n.tags)) data.tag = n.tags.map(t => typeof t === "object" && t ? (t as { text?: unknown }).text : t);
    const st = n.style && typeof n.style === "object" ? n.style as Record<string, unknown> : {};
    if (typeof st.color === "string") data.color = st.color;
    if (typeof st.background === "string") data.fillColor = st.background;
    if (typeof st.fontSize === "string" && Number.parseInt(st.fontSize)) data.fontSize = Number.parseInt(st.fontSize);
    if (typeof st.fontWeight === "string") data.fontWeight = st.fontWeight;
    if (typeof n.branchColor === "string") data.lineColor = n.branchColor;
    return { data, children: Array.isArray(n.children) ? n.children.map(walk) : [] };
  };
  const layout = raw.direction === 0 ? "logicalStructureLeft" : raw.direction === 1 ? "logicalStructure" : "mindMap";
  return { format: MIND_MAP_FORMAT, layout, root: walk(raw.nodeData), theme: { template: "kb", config: {} } };
}

/**
 * 把前端 / 导入 / 备份里来的任意 JSON 洗成可入库的导图。未知或危险字段一律丢掉。
 * 结构不对或超限抛 MindMapDataError，调用方转成 VALIDATION。
 */
export function sanitizeMindMap(input: unknown): MindMapData {
  if (!input || typeof input !== "object") throw new MindMapDataError("导图数据格式不对");
  let raw = input as Record<string, unknown>;
  if (raw.nodeData && !raw.root) raw = fromLegacy(raw) as Record<string, unknown>;
  let count = 0;
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): MindMapNode => {
    if (!value || typeof value !== "object") throw new MindMapDataError("导图节点格式不对");
    if (depth > MIND_MAP_LIMITS.depth) throw new MindMapDataError(`导图最多 ${MIND_MAP_LIMITS.depth} 层`);
    if (++count > MIND_MAP_LIMITS.nodes) throw new MindMapDataError(`一张导图最多 ${MIND_MAP_LIMITS.nodes} 个节点`);
    const n = value as { data?: unknown; children?: unknown };
    const d = (n.data && typeof n.data === "object" ? n.data : {}) as Record<string, unknown>;
    // 缺 uid 或与前面的节点撞了（复制粘贴、外部导入都可能出现）就换一个新的，不因此拒绝保存。
    let uid = typeof d.uid === "string" && NODE_ID.test(d.uid) && !seen.has(d.uid) ? d.uid : null;
    if (!uid) do uid = newUid(); while (seen.has(uid));
    seen.add(uid);
    const out: MindMapNodeData = { text: textOf(d, MIND_MAP_LIMITS.text), uid };
    if (typeof d.expand === "boolean") out.expand = d.expand;
    if (typeof d.image === "string" && d.image.length <= MIND_MAP_LIMITS.image && IMAGE_DATA.test(d.image)) {
      out.image = d.image;
      const title = str(d.imageTitle, 200);
      if (title) out.imageTitle = title;
      const size = d.imageSize as Record<string, unknown> | undefined;
      if (size && typeof size.width === "number" && typeof size.height === "number" && size.width > 0 && size.height > 0) {
        out.imageSize = { width: Math.min(size.width, 4000), height: Math.min(size.height, 4000), ...(typeof size.custom === "boolean" ? { custom: size.custom } : {}) };
      }
    }
    if (Array.isArray(d.icon)) {
      const icons = d.icon.filter((x): x is string => typeof x === "string" && ICON.test(x) && x.length <= 40).slice(0, MIND_MAP_LIMITS.icons);
      if (icons.length) out.icon = [...new Set(icons)];
    }
    if (Array.isArray(d.tag)) {
      const tags = d.tag.map(t => str(typeof t === "object" && t ? (t as { text?: unknown }).text : t, MIND_MAP_LIMITS.tag)?.trim())
        .filter((t): t is string => !!t).slice(0, MIND_MAP_LIMITS.tags);
      if (tags.length) out.tag = tags;
    }
    const link = safeLink(d.hyperlink);
    if (link) {
      out.hyperlink = link;
      // 库把 hyperlinkTitle 直接拼进 SVG 标记（<title>${…}</title>），尖括号和 & 必须去掉。
      const title = str(d.hyperlinkTitle, 200)?.replace(/[<>&"']/g, "").trim();
      if (title) out.hyperlinkTitle = title;
    }
    const note = str(d.note, MIND_MAP_LIMITS.note);
    if (note && note.trim()) out.note = note;
    if (Array.isArray(d.generalization)) {
      const list = d.generalization.map(generalization).filter((g): g is Record<string, unknown> => !!g).slice(0, 20);
      if (list.length) out.generalization = list;
    } else {
      const g = generalization(d.generalization);
      if (g) out.generalization = g;
    }
    if (Array.isArray(d.associativeLineTargets)) {
      const targets = d.associativeLineTargets.filter((x): x is string => typeof x === "string" && NODE_ID.test(x)).slice(0, 50);
      if (targets.length) {
        out.associativeLineTargets = targets;
        for (const k of ["associativeLineText", "associativeLinePoint", "associativeLineTargetControlOffsets", "associativeLineStyle"] as const) {
          const v = plain(d[k]);
          if (v !== undefined && (typeof v !== "object" || Object.keys(v as object).length)) out[k] = v;
        }
      }
    }
    const frame = plain(d.outerFrame);
    if (frame && typeof frame === "object" && !Array.isArray(frame)) out.outerFrame = frame;
    for (const k of ["customLeft", "customTop", "customTextWidth"] as const) if (typeof d[k] === "number" && Number.isFinite(d[k])) out[k] = d[k];
    if (d.dir === "left" || d.dir === "right") out.dir = d.dir;
    styles(d, out);
    const children = Array.isArray(n.children) ? n.children.map(child => walk(child, depth + 1)) : [];
    return { data: out, children };
  };
  const root = walk(raw.root, 0);
  // 关联线指向的节点被删了就把线也去掉，免得库渲染时找不到目标报错。
  const prune = (node: MindMapNode) => {
    const t = node.data.associativeLineTargets as string[] | undefined;
    if (t) {
      const kept = t.filter(id => seen.has(id));
      if (kept.length) node.data.associativeLineTargets = kept;
      else for (const k of ["associativeLineTargets", "associativeLineText", "associativeLinePoint", "associativeLineTargetControlOffsets", "associativeLineStyle"]) delete node.data[k];
    }
    node.children.forEach(prune);
  };
  prune(root);
  const layout = typeof raw.layout === "string" && LAYOUT_VALUES.has(raw.layout) ? raw.layout as MindMapLayout : "mindMap";
  const t = (raw.theme && typeof raw.theme === "object" ? raw.theme : {}) as Record<string, unknown>;
  const template = typeof t.template === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t.template) ? t.template : "kb";
  const config: Record<string, unknown> = {};
  if (t.config && typeof t.config === "object" && !Array.isArray(t.config)) {
    for (const [k, v] of Object.entries(t.config as Record<string, unknown>)) {
      if (!KEY.test(k) || k === "backgroundImage") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const sub: Record<string, unknown> = {};
        styles(v as Record<string, unknown>, sub);
        if (Object.keys(sub).length) config[k] = sub;
      } else {
        const s = styleValue(v);
        if (s !== undefined) config[k] = s;
      }
    }
  }
  return { format: MIND_MAP_FORMAT, layout, root, theme: { template, config } };
}

/** draw.io 画板：XML 只在 draw.io 的 iframe 里解析（跨源），这里只管大小和外形。 */
export function sanitizeDrawio(input: unknown): DrawioData {
  if (!input || typeof input !== "object") throw new MindMapDataError("画板数据格式不对");
  const raw = input as Record<string, unknown>;
  const xml = typeof raw.xml === "string" ? raw.xml.trim() : "";
  if (xml.length > MIND_MAP_LIMITS.drawioXml) throw new MindMapDataError("画板太大了，请拆成几张");
  if (xml && !/^<(mxfile|mxGraphModel)[\s>]/.test(xml)) throw new MindMapDataError("画板内容不是 draw.io 格式");
  const noteIds = Array.isArray(raw.noteIds) ? [...new Set(raw.noteIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).map(x => x.toLowerCase()))].slice(0, 200) : [];
  return { format: "drawio", xml, noteIds };
}

export function sanitizeBoard(kind: BoardKind, input: unknown): BoardData {
  return kind === "drawio" ? sanitizeDrawio(input) : sanitizeMindMap(input);
}
export function emptyBoard(kind: BoardKind, title: string): BoardData {
  return kind === "drawio" ? emptyDrawio() : emptyMindMap(title);
}

export function walkMindMap(data: MindMapData, fn: (node: MindMapNode, depth: number, parent: MindMapNode | null) => void) {
  const walk = (n: MindMapNode, depth: number, parent: MindMapNode | null) => { fn(n, depth, parent); n.children.forEach(c => walk(c, depth + 1, n)); };
  walk(data.root, 0, null);
}

/** 导图 / 画板关联了哪些笔记：去重后的 [{ nodeId, noteId }]。画板的关联挂在整张图上，nodeId 为空串。 */
export function extractBoardNoteLinks(kind: BoardKind, data: BoardData): Array<{ nodeId: string; noteId: string }> {
  if (kind === "drawio") return (data as DrawioData).noteIds.map(noteId => ({ nodeId: "", noteId }));
  const out: Array<{ nodeId: string; noteId: string }> = [];
  const seen = new Set<string>();
  walkMindMap(data as MindMapData, n => {
    const noteId = noteIdFromHref(n.data.hyperlink);
    if (noteId && !seen.has(noteId)) { seen.add(noteId); out.push({ nodeId: n.data.uid, noteId }); }
  });
  return out;
}
export function extractMindMapNoteLinks(data: MindMapData) { return extractBoardNoteLinks("mindmap", data); }

export function countMindMapNodes(data: MindMapData) {
  let n = 0;
  walkMindMap(data, () => { n++; });
  return n;
}

/** draw.io XML 里的文字（单元格 value / label），给搜索用。压缩过的 diagram 读不出来就算了。 */
export function drawioText(xml: string) {
  const out: string[] = [];
  const re = /\s(?:value|label)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < 5000) {
    const t = htmlToText(m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&"));
    if (t) out.push(t);
  }
  const names = /<diagram[^>]*\sname="([^"]*)"/g;
  while ((m = names.exec(xml))) out.push(m[1]!);
  return out.join("\n");
}

/** 搜索用的纯文本：节点文字、备注、标签、概要、关联线文字。 */
export function boardPlainText(kind: BoardKind, data: BoardData) {
  if (kind === "drawio") return drawioText((data as DrawioData).xml).slice(0, 200_000);
  const parts: string[] = [];
  walkMindMap(data as MindMapData, n => {
    const d = n.data;
    parts.push(d.text);
    if (typeof d.note === "string") parts.push(d.note);
    if (Array.isArray(d.tag)) parts.push(...(d.tag as string[]));
    const g = d.generalization;
    for (const x of Array.isArray(g) ? g : g ? [g] : []) if (typeof (x as { text?: unknown }).text === "string") parts.push((x as { text: string }).text);
    if (d.associativeLineText && typeof d.associativeLineText === "object") for (const v of Object.values(d.associativeLineText)) if (typeof v === "string") parts.push(v);
  });
  return parts.filter(Boolean).join("\n").slice(0, 200_000);
}

// —— 大纲（Markdown）互转：AI、MCP、从笔记生成、导入导出共用 ——

export type OutlineNode = { text: string; noteId?: string; note?: string; children: OutlineNode[] };
type Outline = Array<{ level: number; text: string }>;
const NOTE_MARK = /\s*\[\[note:([0-9a-f-]{36})\]\]\s*$/i;

function inlineText(s: string) {
  return s.replace(/\*\*|__|`/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (all, t: string, a?: string) => /^note:/i.test(t) ? all : (a ?? t))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\((?!#note:)[^)]*\)/g, "$1").trim();
}

/**
 * Markdown → 大纲树。# 标题与列表都算层级：列表挂在最近的标题下面，缩进越深层级越深。
 * 节点末尾的 `[[note:<uuid>]]` 表示关联笔记；紧跟在条目下面的 `> ` 行是这个节点的备注。
 * 只有一个顶层条目时返回它做根，否则 root 为 null（调用方自己给根起名）。
 */
export function parseMindMapOutline(markdown: string): { root: OutlineNode | null; items: OutlineNode[] } {
  const top: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  let headingLevel = 0;
  let fence = false;
  const listIndents: number[] = [];
  const state: { last: OutlineNode | null } = { last: null };
  const push = (level: number, rawText: string) => {
    let text = inlineText(rawText);
    let noteId: string | undefined;
    const m = NOTE_MARK.exec(text);
    if (m && UUID.test(m[1]!)) { noteId = m[1]!.toLowerCase(); text = text.slice(0, m.index).trim(); }
    const link = /^\[([^\]]+)\]\(#note:([0-9a-f-]{36})\)$/i.exec(text);
    if (link && UUID.test(link[2]!)) { text = link[1]!; noteId = link[2]!.toLowerCase(); }
    if (!text) return;
    const node: OutlineNode = { text: text.slice(0, MIND_MAP_LIMITS.text), children: [], ...(noteId ? { noteId } : {}) };
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1]!.node.children.push(node);
    else top.push(node);
    stack.push({ level, node });
    state.last = node;
  };
  for (const line of markdown.replace(/\t/g, "  ").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { headingLevel = h[1]!.length * 100; listIndents.length = 0; push(headingLevel, h[2]!); continue; }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (li) {
      const indent = li[1]!.length;
      while (listIndents.length && listIndents[listIndents.length - 1]! > indent) listIndents.pop();
      if (!listIndents.length || listIndents[listIndents.length - 1]! < indent) listIndents.push(indent);
      push(headingLevel + listIndents.length, li[2]!);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q && state.last) { const cur = state.last; cur.note = cur.note ? `${cur.note}\n${q[1]}` : q[1]!; continue; }
  }
  return { root: top.length === 1 ? top[0]! : null, items: top };
}

/** 导图 → Markdown 大纲。根节点是 `# 标题`，关联笔记写成 `[[note:<uuid>]]`，备注写成下一行的 `> `。 */
export function mindMapToOutline(data: MindMapData, opts: { notes?: boolean; noteMarkers?: boolean } = {}) {
  const { notes = true, noteMarkers = true } = opts;
  const lines: string[] = [];
  const one = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
  const mark = (d: MindMapNodeData) => { const id = noteMarkers ? noteIdFromHref(d.hyperlink) : null; return id ? ` [[note:${id}]]` : ""; };
  const noteLines = (d: MindMapNodeData, pad: string) => {
    if (notes && typeof d.note === "string" && d.note.trim()) for (const l of d.note.trim().split(/\r?\n/)) lines.push(`${pad}> ${l}`);
  };
  lines.push(`# ${one(data.root.data.text) || "中心主题"}${mark(data.root.data)}`);
  noteLines(data.root.data, "");
  const walk = (n: MindMapNode, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}- ${one(n.data.text) || "（空）"}${mark(n.data)}`);
    noteLines(n.data, `${pad}  `);
    n.children.forEach(c => walk(c, depth + 1));
  };
  data.root.children.forEach(c => walk(c, 0));
  return lines.join("\n");
}

/**
 * 大纲树 → 导图。给了 base 时尽量复用原节点（同一父节点下文字相同的第一个），
 * 保住 uid、样式、图片、关联线，只按大纲改结构和文字；布局与主题沿用 base。
 */
export function mindMapFromTree(title: string, items: OutlineNode[], opts: { noteId?: string; rootNote?: string; base?: MindMapData; rootNoteId?: string } = {}): MindMapData {
  const base = opts.base;
  let count = 1;
  const build = (item: OutlineNode, pool: MindMapNode[], depth: number): MindMapNode | null => {
    if (++count > MIND_MAP_LIMITS.nodes || depth > MIND_MAP_LIMITS.depth) return null;
    const at = pool.findIndex(p => p.data.text.trim() === item.text.trim());
    const reuse = at >= 0 ? pool.splice(at, 1)[0]! : null;
    const data: MindMapNodeData = reuse ? { ...reuse.data, text: item.text } : { text: item.text, uid: newUid() };
    applyOutlineExtras(data, item);
    const kids = reuse ? [...reuse.children] : [];
    return { data, children: item.children.map(c => build(c, kids, depth + 1)).filter((x): x is MindMapNode => !!x) };
  };
  const rootData: MindMapNodeData = base ? { ...base.root.data, text: (title.trim() || base.root.data.text).slice(0, MIND_MAP_LIMITS.text) } : { text: (title.trim() || "中心主题").slice(0, MIND_MAP_LIMITS.text), uid: newUid() };
  const noteId = opts.rootNoteId ?? opts.noteId;
  if (noteId) rootData.hyperlink = noteLinkHref(noteId);
  if (opts.rootNote !== undefined) { if (opts.rootNote.trim()) rootData.note = opts.rootNote; else delete rootData.note; }
  const pool = base ? [...base.root.children] : [];
  const root: MindMapNode = { data: rootData, children: items.map(i => build(i, pool, 1)).filter((x): x is MindMapNode => !!x) };
  return sanitizeMindMap({ format: MIND_MAP_FORMAT, layout: base?.layout ?? "mindMap", root, theme: base?.theme ?? { template: "kb", config: {} } });
}
function applyOutlineExtras(data: MindMapNodeData, item: OutlineNode) {
  if (item.noteId) data.hyperlink = noteLinkHref(item.noteId);
  else if (noteIdFromHref(data.hyperlink)) { delete data.hyperlink; delete data.hyperlinkTitle; }
  if (item.note !== undefined) { if (item.note.trim()) data.note = item.note; else delete data.note; }
}

/** 把整段 Markdown 大纲变成导图：只有一个顶层条目就拿它当根，否则用 fallbackTitle 当根。 */
export function mindMapFromMarkdown(markdown: string, fallbackTitle: string, opts: { base?: MindMapData; noteId?: string } = {}): MindMapData {
  const { root, items } = parseMindMapOutline(markdown);
  if (root) return mindMapFromTree(root.text, root.children, { base: opts.base, rootNoteId: root.noteId ?? opts.noteId, rootNote: root.note ?? (opts.base ? "" : undefined) });
  return mindMapFromTree(fallbackTitle, items, { base: opts.base, noteId: opts.noteId });
}

/**
 * 按层级大纲建树：level 越大越深，跳级（# 直接到 ###）挂到最近的上级。
 * 根节点是笔记标题并关联回这篇笔记。
 */
export function mindMapFromOutline(title: string, outline: Outline, opts: { noteId?: string } = {}): MindMapData {
  const top: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  for (const item of outline) {
    const text = item.text.trim();
    if (!text) continue;
    const node: OutlineNode = { text, children: [] };
    while (stack.length && stack[stack.length - 1]!.level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1]!.node.children.push(node);
    else top.push(node);
    stack.push({ level: item.level, node });
  }
  return mindMapFromTree(title, top, { noteId: opts.noteId });
}

/**
 * 从 Markdown 列表（- / * / + / 1.）读出大纲，缩进决定层级。
 * 给「没有标题的笔记」用。代码块里的内容跳过。
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
    const text = inlineText(m[2]!);
    if (text) out.push({ level: indents.length, text });
  }
  return out;
}

/**
 * 把导图 / 画板里关联的笔记 id 换成新 id（备份恢复时笔记会拿到新主键）。
 * 映射不到的关联直接去掉链接，节点本身保留。输入按不可信处理，先清洗再换。
 */
export function remapBoardNotes(kind: BoardKind, input: unknown, mapNote: (noteId: string) => string | null | undefined): BoardData {
  if (kind === "drawio") {
    const d = sanitizeDrawio(input);
    return { ...d, noteIds: d.noteIds.map(id => mapNote(id)).filter((x): x is string => !!x).map(x => x.toLowerCase()) };
  }
  const data = sanitizeMindMap(input);
  walkMindMap(data, n => {
    const noteId = noteIdFromHref(n.data.hyperlink);
    if (!noteId) return;
    const next = mapNote(noteId);
    if (next) n.data.hyperlink = noteLinkHref(next);
    else { delete n.data.hyperlink; delete n.data.hyperlinkTitle; }
  });
  return data;
}
export function remapMindMapNotes(input: unknown, mapNote: (noteId: string) => string | null | undefined) { return remapBoardNotes("mindmap", input, mapNote) as MindMapData; }
