import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temp=await mkdtemp(join(tmpdir(),"xinglinote-mcp-upload-"));
process.env.DATABASE_URL||="postgres://unit:unit@127.0.0.1:1/unit";
process.env.DATA_DIR=temp;
const{readMcpUpload,removeMcpUpload,storeMcpUpload}=await import("./mcp-upload.ts");

test("同一上传会话可覆盖重试",async()=>{
  const id=crypto.randomUUID();
  await storeMcpUpload(id,Buffer.from("first"));
  await storeMcpUpload(id,Buffer.from("second"));
  assert.equal((await readMcpUpload(id)).toString(),"second");
  await removeMcpUpload(id);
});

test.after(async()=>{await rm(temp,{recursive:true,force:true});});
