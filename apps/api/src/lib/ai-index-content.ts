import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { attachments } from "../db/schema.ts";
import {
  IMAGE_EMBED_MAX_BYTES,
  INDEX_MAX_IMAGES,
  INDEX_MAX_VIDEOS,
  TEXT_ATTACH_MAX_CHARS,
  VIDEO_EMBED_MAX_BYTES,
  chunks,
  mediaCaption,
  toEmbedDataUrl,
  type EmbedInput,
} from "./ai.ts";
import { readStoredFile } from "./blobs.ts";

type AttachmentRow = typeof attachments.$inferSelect;

export type IndexPiece = { content: string; input: EmbedInput };

function isImage(mime: string) {
  return mime.startsWith("image/");
}
function isVideo(mime: string) {
  return mime.startsWith("video/");
}
function isTextFile(mime: string) {
  return mime === "text/plain" || mime === "text/markdown";
}

function textPieces(title: string, body: string, extra: string[]): IndexPiece[] {
  const joined = extra.filter(Boolean).join("\n");
  return chunks(title, joined ? `${body}\n${joined}` : body).map(content => ({ content, input: content }));
}

async function loadTextAttachment(a: AttachmentRow): Promise<string> {
  try {
    const raw = await readStoredFile(a);
    const text = raw.toString("utf8").slice(0, TEXT_ATTACH_MAX_CHARS).trim();
    return text ? `${mediaCaption("file", a.filename)}\n${text}` : mediaCaption("file", a.filename);
  } catch {
    return mediaCaption("file", a.filename);
  }
}

async function loadMedia(a: AttachmentRow, kind: "image" | "video"): Promise<IndexPiece> {
  const caption = mediaCaption(kind, a.filename);
  const cap = kind === "image" ? IMAGE_EMBED_MAX_BYTES : VIDEO_EMBED_MAX_BYTES;
  if (a.bytes > cap) return { content: caption, input: caption };
  try {
    const bytes = await readStoredFile(a);
    const dataUrl = toEmbedDataUrl(a.mime, bytes);
    return {
      content: caption,
      input: {
        text: caption,
        sha256: a.sha256,
        ...(kind === "image" ? { image: dataUrl } : { video: dataUrl }),
      },
    };
  } catch {
    return { content: caption, input: caption };
  }
}

/** 一篇笔记要打向量的全部块：正文/PDF/文本附件 + 图/视频。 */
export async function noteIndexPieces(note: { id: string; title: string; bodyMd: string }): Promise<IndexPiece[]> {
  const files = await db.select().from(attachments).where(and(eq(attachments.noteId, note.id), isNull(attachments.trashedAt)));
  const extraText: string[] = [];
  const media: IndexPiece[] = [];
  let images = 0;
  let videos = 0;
  for (const a of files) {
    if (a.extractedText) extraText.push(a.extractedText);
    else if (isTextFile(a.mime)) extraText.push(await loadTextAttachment(a));
    else if (isImage(a.mime)) {
      if (images >= INDEX_MAX_IMAGES) { extraText.push(mediaCaption("image", a.filename)); continue; }
      images += 1;
      media.push(await loadMedia(a, "image"));
    } else if (isVideo(a.mime)) {
      if (videos >= INDEX_MAX_VIDEOS) { extraText.push(mediaCaption("video", a.filename)); continue; }
      videos += 1;
      media.push(await loadMedia(a, "video"));
    } else extraText.push(mediaCaption("file", a.filename));
  }
  const text = textPieces(note.title, note.bodyMd, extraText);
  // 只有附件、正文为空时也要留下至少一块，否则搜不到这篇。
  if (!text.length && !media.length) {
    const fallback = note.title.trim() || "未命名笔记";
    return [{ content: fallback, input: fallback }];
  }
  return [...text, ...media];
}

