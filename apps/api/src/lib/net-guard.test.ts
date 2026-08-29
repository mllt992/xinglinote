import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress } from "./client-ip.ts";
import { assertSafeOutboundUrl, classifyOutboundFailure, privateOutboundAllowed } from "./net-guard.ts";

test("私网、环回、链路本地都算内网", () => {
  for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.16.3.1", "172.31.255.254", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "localhost"]) {
    assert.ok(isPrivateAddress(ip), `${ip} 应当被当成内网`);
  }
});

test("公网地址不误伤", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888"]) {
    assert.ok(!isPrivateAddress(ip), `${ip} 不该被当成内网`);
  }
});

test("出站护栏挡掉云元数据和环回", async (t) => {
  if (privateOutboundAllowed()) return t.skip("本机开了 ALLOW_PRIVATE_OUTBOUND_ENDPOINTS");
  for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:12099/api/v1/mcp", "http://[::1]:8080/x", "https://192.168.0.10/api"]) {
    await assert.rejects(() => assertSafeOutboundUrl(url), /内网|环回/, url);
  }
});

test("非 http/https 一律拒绝", async () => {
  await assert.rejects(() => assertSafeOutboundUrl("file:///etc/passwd"), /http/);
  await assert.rejects(() => assertSafeOutboundUrl("gopher://x/1"), /http/);
  await assert.rejects(() => assertSafeOutboundUrl("不是 URL"), /URL/);
});

test("公网 IP 字面量放行（不做 DNS）", async (t) => {
  if (privateOutboundAllowed()) return t.skip("本机开了 ALLOW_PRIVATE_OUTBOUND_ENDPOINTS");
  const u = await assertSafeOutboundUrl("https://8.8.8.8/v1");
  assert.equal(u.hostname, "8.8.8.8");
});

function fetchFailed(cause: Error & { code?: string }) {
  return new TypeError("fetch failed", { cause });
}

test("undici 的 fetch failed 从 cause 链分出 DNS / 超时 / 拒连，而不是三个字", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" });
  assert.equal(classifyOutboundFailure(fetchFailed(dns)).kind, "dns");
  assert.match(classifyOutboundFailure(fetchFailed(dns)).message, /域名解析/);

  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  assert.equal(classifyOutboundFailure(fetchFailed(refused)).kind, "refused");

  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(classifyOutboundFailure(fetchFailed(reset)).kind, "reset");

  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(classifyOutboundFailure(timeout).kind, "timeout");

  assert.equal(classifyOutboundFailure(new TypeError("fetch failed")).kind, "network");
  assert.equal(classifyOutboundFailure(new TypeError("fetch failed")).message, "网络请求失败");

  const nested = Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" });
  const aggregate = Object.assign(new Error("fetch failed"), { errors: [nested] });
  assert.equal(classifyOutboundFailure(aggregate).kind, "dns");
});
