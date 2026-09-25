import {
  MIND_MAP_LIMITS, mindMapFromMarkdown, mindMapToOutline, noteIdFromHref, sanitizeMindMap,
  type MindMapData, type MindMapNode,
} from "@kb/shared";

/**
 * 思维导图的导入 / 导出格式转换（纯前端）。XMind 解析用 simple-mind-map 自带的解析器，
 * 其余（Markdown、OPML、FreeMind、JSON）在这里实现。无论哪种来源，最后都过一遍 sanitizeMindMap。
 */

export const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|&]+/g, "_").trim().slice(0, 80) || "思维导图";

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadText(text: string, name: string, type: string) {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), name);
}

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

/** 导出 Markdown：标题 + 缩进列表，备注写成引用，关联笔记保留成 [[note:…]] 方便再导回来。 */
export function toMarkdown(data: MindMapData) {
  return `${mindMapToOutline(data, { notes: true, noteMarkers: true })}\n`;
}

export function toOpml(data: MindMapData, title: string) {
  const walk = (n: MindMapNode, pad: string): string => {
    const note = typeof n.data.note === "string" && n.data.note.trim() ? ` _note="${escXml(n.data.note)}"` : "";
    const link = typeof n.data.hyperlink === "string" && !noteIdFromHref(n.data.hyperlink) ? ` url="${escXml(n.data.hyperlink)}"` : "";
    const open = `${pad}<outline text="${escXml(n.data.text)}"${note}${link}`;
    if (!n.children.length) return `${open}/>`;
    return `${open}>\n${n.children.map(c => walk(c, `${pad}  `)).join("\n")}\n${pad}</outline>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${escXml(title)}</title></head>\n  <body>\n${walk(data.root, "    ")}\n  </body>\n</opml>\n`;
}

export function toJson(data: MindMapData, title: string) {
  return JSON.stringify({ format: "xinglinote-mindmap", version: 2, title, data }, null, 2);
}

type Tree = { data: Record<string, unknown>; children: Tree[] };

function xmlDoc(text: string) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("文件不是有效的 XML");
  return doc;
}

function fromOpml(text: string): Tree {
  const doc = xmlDoc(text);
  const body = doc.getElementsByTagName("body")[0];
  if (!body) throw new Error("没有找到 OPML 的 body");
  const walk = (el: Element): Tree => {
    const data: Record<string, unknown> = { text: el.getAttribute("text") ?? el.getAttribute("title") ?? "" };
    const note = el.getAttribute("_note");
    if (note) data.note = note;
    const url = el.getAttribute("url") ?? el.getAttribute("htmlUrl");
    if (url) data.hyperlink = url;
    return { data, children: [...el.children].filter(c => c.tagName === "outline").map(walk) };
  };
  const tops = [...body.children].filter(c => c.tagName === "outline").map(walk);
  if (!tops.length) throw new Error("OPML 里没有内容");
  if (tops.length === 1) return tops[0]!;
  const title = doc.getElementsByTagName("title")[0]?.textContent?.trim() || "导入的大纲";
  return { data: { text: title }, children: tops };
}

function fromFreeMind(text: string): Tree {
  const doc = xmlDoc(text);
  const map = doc.getElementsByTagName("map")[0];
  const first = map ? [...map.children].find(c => c.tagName === "node") : undefined;
  if (!first) throw new Error("没有找到 FreeMind 的根节点");
  const walk = (el: Element): Tree => {
    const rich = [...el.children].filter(c => c.tagName === "richcontent");
    const nodeRich = rich.find(r => (r.getAttribute("TYPE") ?? "NODE") === "NODE");
    const noteRich = rich.find(r => r.getAttribute("TYPE") === "NOTE");
    const data: Record<string, unknown> = { text: el.getAttribute("TEXT") ?? nodeRich?.textContent?.trim() ?? "" };
    const note = noteRich?.textContent?.replace(/\n\s+/g, "\n").trim();
    if (note) data.note = note;
    const link = el.getAttribute("LINK");
    if (link) data.hyperlink = link;
    if (el.getAttribute("FOLDED") === "true") data.expand = false;
    const color = el.getAttribute("COLOR");
    if (color && /^#[0-9a-f]{6}$/i.test(color)) data.color = color;
    const bg = el.getAttribute("BACKGROUND_COLOR");
    if (bg && /^#[0-9a-f]{6}$/i.test(bg)) data.fillColor = bg;
    return { data, children: [...el.children].filter(c => c.tagName === "node").map(walk) };
  };
  return walk(first);
}

function fromJson(text: string): unknown {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("文件不是有效的 JSON"); }
  if (!raw || typeof raw !== "object") throw new Error("JSON 内容不对");
  const r = raw as Record<string, unknown>;
  // 我们自己导出的格式 / simple-mind-map 的 .smm / 只有节点树 / 第一版 mind-elixir
  if (r.format === "xinglinote-mindmap" && r.data) return r.data;
  if (r.root || r.nodeData) return r;
  if (r.data && (r as { children?: unknown }).children) return { root: r };
  throw new Error("认不出这份 JSON 的导图格式");
}

export const IMPORT_ACCEPT = ".md,.markdown,.txt,.xmind,.opml,.mm,.json,.smm";
export const IMPORT_HINT = "支持 Markdown（.md）、XMind（.xmind）、OPML、FreeMind（.mm）和 JSON";

/** 读一个文件成导图数据（已清洗）。title 用于没有明确中心主题时给根节点起名。 */
export async function importMindMapFile(file: File): Promise<{ data: MindMapData; title: string }> {
  if (file.size > 30 * 1024 * 1024) throw new Error("文件太大了（超过 30 MB）");
  const name = file.name.replace(/\.[^.]+$/, "") || "导入的导图";
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] ?? "").toLowerCase();
  let raw: unknown;
  if (ext === "xmind") {
    const { default: xmind } = await import("simple-mind-map/src/parse/xmind.js");
    let root: unknown;
    try { root = await xmind.parseXmindFile(file); } catch { throw new Error("没能解析这个 XMind 文件"); }
    raw = { root };
  } else {
    const text = await file.text();
    if (ext === "opml") raw = { root: fromOpml(text) };
    else if (ext === "mm") raw = { root: fromFreeMind(text) };
    else if (ext === "json" || ext === "smm") raw = fromJson(text);
    else {
      const data = mindMapFromMarkdown(text, name);
      if (!data.root.children.length && !text.trim()) throw new Error("文件是空的");
      return { data, title: data.root.data.text || name };
    }
  }
  const data = sanitizeMindMap(raw);
  return { data, title: (data.root.data.text || name).slice(0, 200) };
}

/**
 * 节点图片：统一压成 data URL 存在导图里（CSP 不允许外链图片，也免得附件被删后图裂掉）。
 * 长边压到 maxSide 以内，还超限就降质量 / 缩小，直到满足 MIND_MAP_LIMITS.image。
 */
export async function imageFileToDataUrl(file: Blob, maxSide = 1600): Promise<{ url: string; width: number; height: number }> {
  if (!/^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(file.type)) throw new Error("只支持 PNG、JPG、GIF、WebP 图片");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("这张图片读不出来"); });
  let side = maxSide;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    const png = file.type === "image/png" || file.type === "image/gif";
    const url = png && attempt === 0 ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", attempt < 3 ? 0.85 : 0.7);
    if (url.length <= MIND_MAP_LIMITS.image) { bitmap.close(); return { url, width: w, height: h }; }
    side = Math.round(side * 0.75);
  }
  bitmap.close();
  throw new Error("图片太大了，压缩后仍超过限制");
}
