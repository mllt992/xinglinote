import { fail } from "@kb/shared";

/**
 * 上传附件的类型校验。
 *
 * 白名单原来只看浏览器给的 `f.type`——那是客户端随便写的字段，落库后还会原样
 * 当成 `Content-Type` 回显。`X-Content-Type-Options: nosniff` 兜住了 XSS，
 * 但「声明成 image/png 的 HTML」这种事本来就不该存进来。这里按魔数复核一遍。
 */
export const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/zip",
  "video/mp4",
  "video/webm",
]);

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** 二进制格式各自的头。文本类没有魔数，只要求「不是别的已知二进制格式」。 */
function sniff(bytes: Uint8Array): string | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  // mp4 / mov 家族：第 5–8 字节是 ftyp。webm 跟 mkv 都是 EBML 头，声明成 webm 就认。
  if (bytes.length > 12 && starts(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4";
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

/** 文本类附件不能藏着 HTML / SVG 标记——它们是可执行的。 */
function looksLikeMarkup(bytes: Uint8Array) {
  const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<?xml");
}

export function assertAttachmentType(declared: string, bytes: Uint8Array) {
  if (!ALLOWED_MIME.has(declared)) throw fail("VALIDATION", "不支持此文件类型");
  const actual = sniff(bytes);
  const isText = declared === "text/plain" || declared === "text/markdown";
  if (isText) {
    if (actual) throw fail("VALIDATION", `声明是文本，实际是 ${actual}`);
    if (looksLikeMarkup(bytes)) throw fail("VALIDATION", "文本附件里不能是 HTML / SVG");
    return declared;
  }
  if (actual !== declared) throw fail("VALIDATION", `文件内容与声明的类型不符（实际看起来是 ${actual ?? "未知格式"}）`);
  return declared;
}
