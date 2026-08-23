import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@kb/shared";
import { assertQuotaBytes, formatBytes, MAX_QUOTA_BYTES, MIN_QUOTA_BYTES } from "./quota.ts";

test("formatBytes 用人类可读单位", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1_048_576), "1.0 MB");
  assert.equal(formatBytes(1_073_741_824), "1.00 GB");
});

test("assertQuotaBytes 卡在 1MB–1TB", () => {
  assert.equal(assertQuotaBytes(MIN_QUOTA_BYTES), MIN_QUOTA_BYTES);
  assert.equal(assertQuotaBytes(MAX_QUOTA_BYTES), MAX_QUOTA_BYTES);
  assert.throws(() => assertQuotaBytes(1024), (e: unknown) => e instanceof AppError && e.code === "VALIDATION");
  assert.throws(() => assertQuotaBytes(MAX_QUOTA_BYTES + 1), (e: unknown) => e instanceof AppError && e.code === "VALIDATION");
  assert.throws(() => assertQuotaBytes(1.5), (e: unknown) => e instanceof AppError && e.code === "VALIDATION");
});
