import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { fail } from "@kb/shared";
import { db } from "../db/client.ts";
import { attachments, backgroundJobs, instanceSettings } from "../db/schema.ts";
import { env } from "../env.ts";
import { ALLOWED_MIME, assertAttachmentType } from "./file-type.ts";
import { decodeImageData } from "./image-data.ts";
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
  await assertUserStorage(input.userId, input.bytes.length);
  const name = input.filename.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 180) || "image";
  const stored = `${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const dir = join(env.dataDir, "attachments", input.note.workspaceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, stored), input.bytes);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const [a] = await db.insert(attachments).values({
    workspaceId: input.note.workspaceId,
    noteId: input.note.id,
    filename: name,
    storedName: stored,
    mime: input.declaredMime,
    bytes: input.bytes.length,
    sha256: sha,
    createdBy: input.userId,
  }).returning();
  if (input.declaredMime === "application/pdf") {
    await db.update(attachments).set({ extractStatus: "pending" }).where(eq(attachments.id, a.id));
    await db.insert(backgroundJobs).values({ type: "extract_pdf", payload: { attachmentId: a.id } });
  }
  return {
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    bytes: a.bytes,
    url: `/api/v1/attachments/${a.id}`,
    markdown: attachmentMarkdown(a.filename, a.id, a.mime),
    extractStatus: input.declaredMime === "application/pdf" ? "pending" : "none",
  };
}
