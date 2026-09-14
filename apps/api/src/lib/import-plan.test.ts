import assert from "node:assert/strict";
import test from "node:test";
import { importFolderPath,parseFront,resolveTargetFolderSegs } from "./import-plan-path.ts";

const folders=[
  {id:"a",title:"项目",parentId:null as string|null},
  {id:"b",title:"Web",parentId:"a"},
  {id:"c",title:"草稿",parentId:"b"},
];

test("resolveTargetFolderSegs：根与嵌套路径",()=>{
  assert.deepEqual(resolveTargetFolderSegs(folders,null),[]);
  assert.deepEqual(resolveTargetFolderSegs(folders,undefined),[]);
  assert.deepEqual(resolveTargetFolderSegs(folders,"a"),["项目"]);
  assert.deepEqual(resolveTargetFolderSegs(folders,"b"),["项目","Web"]);
  assert.deepEqual(resolveTargetFolderSegs(folders,"c"),["项目","Web","草稿"]);
});

test("resolveTargetFolderSegs：不属于笔记本则校验失败",()=>{
  assert.throws(()=>resolveTargetFolderSegs(folders,"missing"),/目标文件夹/);
});

test("importFolderPath：叠在目标目录下并尊重深度上限",()=>{
  assert.deepEqual(importFolderPath("hello.md",[],true),[]);
  assert.deepEqual(importFolderPath("hello.md",["项目","Web"],true),["项目","Web"]);
  assert.deepEqual(importFolderPath("docs/a/b.md",["项目"],true),["项目","docs","a"]);
  assert.deepEqual(importFolderPath("docs/a/b.md",["项目"],false),["项目"]);
  // 目标已占 7 层时，相对路径只再允许 1 层
  const deep=["1","2","3","4","5","6","7"];
  assert.deepEqual(importFolderPath("x/y/z.md",deep,true),["1","2","3","4","5","6","7","x"]);
});

test("parseFront 取 title 并剥 frontmatter",()=>{
  const r=parseFront("---\ntitle: 你好\n---\n\n正文");
  assert.equal(r.title,"你好");
  assert.equal(r.body,"正文");
});
