import assert from "node:assert/strict";
import test from "node:test";
import { oidcHandleBase, pkceChallenge, readOidcFlow, safeLoginNext, signOidcFlow } from "./oidc-login.ts";

test("OIDC 回跳地址只接受本站绝对路径", () => {
  assert.equal(safeLoginNext("/w/abc?tab=members"), "/w/abc?tab=members");
  for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "relative", ""]) {
    assert.equal(safeLoginNext(unsafe), "/app");
  }
});

test("OIDC 流程 Cookie 可验签，篡改和过期均拒绝", () => {
  const flow = { state: "state", nonce: "nonce", verifier: "verifier", next: "/app", expiresAt: Date.now() + 60_000 };
  const signed = signOidcFlow(flow, "secret");
  assert.deepEqual(readOidcFlow(signed, "secret"), flow);
  assert.equal(readOidcFlow(`${signed}x`, "secret"), null);
  assert.equal(readOidcFlow(signOidcFlow({ ...flow, expiresAt: Date.now() - 1 }, "secret"), "secret"), null);
});

test("PKCE 使用标准 S256 challenge", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("OIDC 用户名会收敛到本地 handle 允许的格式", () => {
  assert.equal(oidcHandleBase("Alice.Smith", "x@example.com"), "alice_smith");
  assert.equal(oidcHandleBase("张三", "张三@example.com"), "user");
  assert.equal(oidcHandleBase("42", "42@example.com"), "u_42");
});
