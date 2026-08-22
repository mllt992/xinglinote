import { fail } from "@kb/shared";

export function decodeImageData(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) throw fail("VALIDATION", "图片数据为空");
  const payload = trimmed.startsWith("data:") && trimmed.includes(",")
    ? trimmed.slice(trimmed.indexOf(",") + 1)
    : trimmed;
  let buf: Buffer;
  try {
    buf = Buffer.from(payload.replace(/\s/g, ""), "base64");
  } catch {
    throw fail("VALIDATION", "图片数据不是合法的 base64");
  }
  if (!buf.length) throw fail("VALIDATION", "图片数据为空");
  return buf;
}
