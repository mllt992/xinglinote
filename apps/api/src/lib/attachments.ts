import { and, eq } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, backgroundJobs, instanceSettings } from "../db/schema.ts";
import { ALLOWED_MIME, assertAttachmentType } from "./file-type.ts";
import { decodeImageData } from "./image-data.ts";
import { putBlob, releaseBlob } from "./blobs.ts";
import { hashBytes } from "./blob-path.ts";
import { enqueueIndexNote } from "./ai-index.ts";
import { assertUserStorage } from "./quota.ts";

export { decodeImageData };

export const MCP_IMAGE_MAX_DEFAULT = 5 * 1024 * 1024;
export const MCP_IMAGE_MAX_MIN = 256 * 1024;
export const MCP_IMAGE_MAX_HARD = 25 * 1024 * 1024;
export const MCP_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function attachmentMarkdown(filename: string, id: string, mime: string) {
  const url = `/api/v1/attachments/${id}`;
  return `${mime.startsWith("image/") ? "!" : ""}[${filename}](${url})`;
}

export async function mcpImageMaxBytes() {
  const [s] = await db.select({ n: instanceSettings.mcpImageMaxBytes }).from(instanceSettings);
  const n = s?.n ?? MCP_IMAGE_MAX_DEFAULT;
  return Math.min(MCP_IMAGE_MAX_HARD, Math.max(MCP_IMAGE_MAX_MIN, n));
}

function attachmentDto(a: typeof attachments.$inferSelect) {
  return {
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    bytes: a.bytes,
    url: `/api/v1/attachments/${a.id}`,
    markdown: attachmentMarkdown(a.filename, a.id, a.mime),
    extractStatus: a.extractStatus,
  };
}

export async function saveNoteAttachment(input: {
  note: { id: string; workspaceId: string };
  userId: string;
  filename: string;
  declaredMime: string;
  bytes: Buffer;
  maxBytes?: number;
}) {
  const cap = input.maxBytes ?? MCP_IMAGE_MAX_HARD;
  if (input.bytes.length > cap) throw fail("QUOTA", `单个文件不能超过 ${Math.round(cap / 1048576)} MB`);
  if (!ALLOWED_MIME.has(input.declaredMime)) throw fail("VALIDATION", "不支持此文件类型");
  assertAttachmentType(input.declaredMime, input.bytes);
  const name = input.filename.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 180) || "image";
  const sha = hashBytes(input.bytes);

  // 同一篇里再传一模一样的文件（含文件名）直接复用行，避免正文里堆两份相同链接。
  const [same] = await db.select().from(attachments).where(and(
    eq(attachments.noteId, input.note.id),
    eq(attachments.sha256, sha),
    eq(attachments.filename, name),
  ));
  if (same) {
    if (same.trashedAt) {
      await db.update(attachments).set({ trashedAt: null }).where(eq(attachments.id, same.id));
      await enqueueIndexNote(db, same.noteId);
      return attachmentDto({ ...same, trashedAt: null });
    }
    return attachmentDto(same);
  }

  await assertUserStorage(input.userId, input.bytes.length);
  const blob = await putBlob(input.bytes);
  try {
    const [a] = await db.insert(attachments).values({
      workspaceId: input.note.workspaceId,
      noteId: input.note.id,
      filename: name,
      storedName: blob.path,
      mime: input.declaredMime,
      bytes: input.bytes.length,
      sha256: sha,
      createdBy: input.userId,
    }).returning();

    if (input.declaredMime === "application/pdf") {
      const [extracted] = await db.select({
        extractedText: attachments.extractedText,
        extractStatus: attachments.extractStatus,
      }).from(attachments).where(and(
        eq(attachments.sha256, sha),
        eq(attachments.extractStatus, "ok"),
      )).limit(1);
      if (extracted?.extractedText) {
        await db.update(attachments).set({
          extractedText: extracted.extractedText,
          extractStatus: "ok",
        }).where(eq(attachments.id, a.id));
        await enqueueIndexNote(db, a.noteId);
        return { ...attachmentDto(a), extractStatus: "ok" };
      }
      await db.update(attachments).set({ extractStatus: "pending" }).where(eq(attachments.id, a.id));
      await db.insert(backgroundJobs).values({ type: "extract_pdf", payload: { attachmentId: a.id } });
      return { ...attachmentDto(a), extractStatus: "pending" };
    }
    await enqueueIndexNote(db, a.noteId);
    return attachmentDto(a);
  } catch (e) {
    await releaseBlob(blob.sha256);
    throw e;
  }
}
