import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, lt, or } from "drizzle-orm";
import { db } from "../db/client.ts";
import { mcpAttachmentUploads } from "../db/schema.ts";
import { env } from "../env.ts";

export const MCP_BASE64_COMPAT_MAX_BYTES = 512 * 1024;
export const MCP_UPLOAD_TTL_MS = 15 * 60_000;

function uploadPath(id:string){return join(env.dataDir,"mcp-uploads",`${id}.bin`);}
async function removeFile(id:string){try{await unlink(uploadPath(id));}catch{}}

export async function storeMcpUpload(id:string,bytes:Buffer){const target=uploadPath(id);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
export async function readMcpUpload(id:string){return readFile(uploadPath(id));}
export async function removeMcpUpload(id:string){await removeFile(id);}

export async function cleanupExpiredMcpUploads(){const rows=await db.select({id:mcpAttachmentUploads.id}).from(mcpAttachmentUploads).where(lt(mcpAttachmentUploads.expiresAt,new Date()));for(const row of rows)await removeFile(row.id);if(rows.length)await db.delete(mcpAttachmentUploads).where(lt(mcpAttachmentUploads.expiresAt,new Date()));return rows.length;}

export async function markUploadCompleted(id:string,attachmentId:string){await db.update(mcpAttachmentUploads).set({status:"completed",attachmentId,updatedAt:new Date()}).where(eq(mcpAttachmentUploads.id,id));await removeFile(id);}
export async function claimMcpUpload(id:string,tokenId:string){const[row]=await db.update(mcpAttachmentUploads).set({status:"completing",updatedAt:new Date()}).where(and(eq(mcpAttachmentUploads.id,id),eq(mcpAttachmentUploads.tokenId,tokenId),or(eq(mcpAttachmentUploads.status,"uploaded"),and(eq(mcpAttachmentUploads.status,"completing"),lt(mcpAttachmentUploads.updatedAt,new Date(Date.now()-2*60_000)))))).returning();return row;}
export async function releaseMcpUpload(id:string){await db.update(mcpAttachmentUploads).set({status:"uploaded",updatedAt:new Date()}).where(and(eq(mcpAttachmentUploads.id,id),eq(mcpAttachmentUploads.status,"completing")));}
