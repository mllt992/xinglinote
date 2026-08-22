import { createHash } from "node:crypto";
import { join } from "node:path";

/** 内容寻址相对路径。正斜杠入库，Windows 上 join 也能吃。 */
export function blobRelPath(sha256: string) {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`;
}

export function hashBytes(bytes: Buffer | Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isBlobPath(storedName: string) {
  return storedName.replaceAll("\\", "/").startsWith("blobs/");
}

/**
 * 把附件行上的 stored_name 收成相对 DATA_DIR 的路径。
 * 新文件是 `blobs/{前两位}/{sha256}`；老文件仍在 attachments/{ws}/ 或 feed/{id}/ 下。
 */
export function resolveStoredRel(input: { storedName: string; workspaceId?: string; postAssetId?: string }) {
  const name = input.storedName.replaceAll("\\", "/");
  if (isBlobPath(name)) return name;
  if (input.postAssetId) return `feed/${input.postAssetId}/${input.storedName}`;
  if (input.workspaceId) return `attachments/${input.workspaceId}/${input.storedName}`;
  return name;
}

export function storedFilePath(dataDir: string, input: { storedName: string; workspaceId?: string; postAssetId?: string }) {
  return join(dataDir, resolveStoredRel(input));
}
