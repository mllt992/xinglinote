import assert from "node:assert/strict";
import { test } from "node:test";
import { clampImageOffset, clampImageScale, filenameFromImageUrl, fitImageScale, usefulImageLabel } from "./image-viewer.js";

test("fit 同时覆盖横图、竖图、旋转和超长图", () => {
  assert.equal(fitImageScale(1600, 900, 1000, 700, 0, 0), 0.625);
  assert.equal(fitImageScale(900, 1600, 1000, 700, 0, 0), 0.4375);
  assert.equal(fitImageScale(900, 1600, 1000, 700, 90, 0), 0.625);
  assert.equal(fitImageScale(600, 12000, 1000, 700, 0, 0), 700 / 12000);
});

test("缩放尊重 500% 上限，同时允许超长图低于 10% 的 fit", () => {
  assert.equal(clampImageScale(8, 0.2), 5);
  assert.equal(clampImageScale(0.01, 0.2), 0.1);
  assert.equal(clampImageScale(0.01, 0.04), 0.04);
});

test("平移边界让小图归中、大图最多露到边缘", () => {
  assert.deepEqual(clampImageOffset(80, -90, 0.5, 0, 800, 600, 1000, 700), { x: 0, y: 0 });
  assert.deepEqual(clampImageOffset(900, -900, 2, 0, 800, 600, 1000, 700), { x: 300, y: -250 });
  assert.deepEqual(clampImageOffset(900, 900, 1, 90, 800, 1200, 1000, 700), { x: 100, y: 50 });
});

test("文件名解析兼容编码，并隐藏 UUID/长哈希", () => {
  assert.equal(filenameFromImageUrl("/files/%E5%B0%81%E9%9D%A2.png?x=1"), "封面.png");
  assert.equal(usefulImageLabel("封面.png"), true);
  assert.equal(usefulImageLabel("550e8400-e29b-41d4-a716-446655440000.png"), false);
  assert.equal(usefulImageLabel("ef129ac9912c844f47e9d19cf735fc45.webp"), false);
});
