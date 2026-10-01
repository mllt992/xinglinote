/** 公开 HTML 的唯一元数据出口：密码门与任何失败均使用中性品牌信息。 */
export const PUBLIC_BRAND = "星璃笔记";
export type PublicMeta = { title: string; description: string; allowRobots: boolean };
export const neutralMeta = (): PublicMeta => ({ title: PUBLIC_BRAND, description: "星璃笔记 · 私人知识库与文档分享", allowRobots: false });

/** 不解析双链目标、不抓远程图片；只摘要已经获准公开的正文。 */
export function publicExcerpt(markdown: string, length = 160) {
  const plain = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, "$2")
    .replace(/^[ \t]*(?:#{1,6}\s|[-*+]\s(?:\[[ xX]\]\s)?|>\s)/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > length ? chars.slice(0, length).join("") + "…" : plain;
}
export function escapeMeta(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

/** canonical 的源只允许管理员配置的 PUBLIC_URL，绝不信任 Host / forwarded headers。 */
export function renderPublicMeta(html: string, meta: PublicMeta, publicUrl: string, pathname: string) {
  const url = new URL(publicUrl);
  const canonical = new URL(pathname, url.origin).href;
  const image = new URL("/brand/share-card.png", url.origin).href;
  const title = escapeMeta(Array.from(meta.title.trim() || PUBLIC_BRAND).slice(0, 200).join(""));
  const description = escapeMeta(meta.description || neutralMeta().description);
  const tags = `<title>${title}</title>\n<meta name="description" content="${description}">\n<meta property="og:type" content="article">\n<meta property="og:site_name" content="${PUBLIC_BRAND}">\n<meta property="og:title" content="${title}">\n<meta property="og:description" content="${description}">\n<meta property="og:image" content="${escapeMeta(image)}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:url" content="${escapeMeta(canonical)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="${title}">\n<meta name="twitter:description" content="${description}">\n<meta name="twitter:image" content="${escapeMeta(image)}">\n<meta name="robots" content="${meta.allowRobots ? "index, follow" : "noindex, nofollow"}">`;
  return html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
    .replace(/<meta\b[^>]*(?:name|property)\s*=\s*["'](?:description|robots|og:[^"']*|twitter:[^"']*)["'][^>]*>/gi, "")
    .replace(/<\/head\s*>/i, () => `${tags}\n</head>`);
}
