import assert from "node:assert/strict";
import { test } from "node:test";
import { bindLightbox, openLightbox, openLightboxGallery, type LightboxRequest } from "./lightbox.js";

test("旧的单图入口仍生成单项查看请求", () => {
  let received: LightboxRequest | null = null;
  bindLightbox(request => { received = request; });
  openLightbox("/cover.png", "封面");
  assert.deepEqual(received, { items: [{ src: "/cover.png", alt: "封面" }], index: 0 });
  bindLightbox(null);
});

test("画廊过滤无效地址后仍定位到原先选中的图片", () => {
  let received: LightboxRequest | null = null;
  bindLightbox(request => { received = request; });
  const selected = { src: "/second.png", alt: "第二张" };
  openLightboxGallery([{ src: "", alt: "无效" }, selected, { src: "/third.png", alt: "第三张" }], 1);
  assert.deepEqual(received, { items: [selected, { src: "/third.png", alt: "第三张" }], index: 0 });
  bindLightbox(null);
});
