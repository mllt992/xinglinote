import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://unit:unit@127.0.0.1:1/unit";
const { INDEX_NOTE_DEBOUNCE_MS, indexNoteDelayMs } = await import("./ai-index.ts");
const { embedEndpoint, mediaCaption, toEmbedDataUrl, IMAGE_EMBED_MAX_BYTES, VIDEO_EMBED_MAX_BYTES } = await import("./ai.ts");

test("没有向量或强制立刻跑时不防抖", () => {
  assert.equal(indexNoteDelayMs({ immediate: true, hasChunks: true }), 0);
  assert.equal(indexNoteDelayMs({ hasChunks: false }), 0);
});

test("已有向量的保存要等五分钟", () => {
  assert.equal(indexNoteDelayMs({ hasChunks: true }), INDEX_NOTE_DEBOUNCE_MS);
  assert.equal(INDEX_NOTE_DEBOUNCE_MS, 5 * 60 * 1000);
});

test("向量地址可独立，没填就继承对话地址", () => {
  assert.deepEqual(embedEndpoint({ baseUrl: "https://chat.example/v1/", embeddingBaseUrl: null, embeddingModel: "e1" }), {
    baseUrl: "https://chat.example/v1",
    model: "e1",
  });
  assert.deepEqual(embedEndpoint({ baseUrl: "https://chat.example/v1", embeddingBaseUrl: "http://embed.example/v1/", embeddingModel: "wemm" }), {
    baseUrl: "http://embed.example/v1",
    model: "wemm",
  });
});

test("图和视频的引用摘要带文件名", () => {
  assert.equal(mediaCaption("image", "截图.png"), "[图片] 截图.png");
  assert.equal(mediaCaption("video", "演示.mp4"), "[视频] 演示.mp4");
  assert.equal(mediaCaption("file", "合同.pdf"), "[附件] 合同.pdf");
});

test("多模态 data URL 带 mime，超限阈值固定", () => {
  assert.equal(toEmbedDataUrl("image/png", Buffer.from("abc")), "data:image/png;base64,YWJj");
  assert.equal(IMAGE_EMBED_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(VIDEO_EMBED_MAX_BYTES, 16 * 1024 * 1024);
});
