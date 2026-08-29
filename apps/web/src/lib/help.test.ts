import assert from "node:assert/strict";
import test from "node:test";
import { resolveHelpTarget } from "./help";

test("默认使用内置帮助", () => {
  assert.deepEqual(resolveHelpTarget({}), { href: "/help", external: false });
  assert.deepEqual(resolveHelpTarget({ helpSource: "builtin", helpUrl: "https://docs.example.com" }), { href: "/help", external: false });
});

test("外部帮助只接受 http(s)", () => {
  assert.deepEqual(resolveHelpTarget({ helpSource: "external", helpUrl: "https://docs.example.com/guide" }), {
    href: "https://docs.example.com/guide",
    external: true,
  });
  assert.deepEqual(resolveHelpTarget({ helpSource: "external", helpUrl: "javascript:alert(1)" }), { href: "/help", external: false });
  assert.deepEqual(resolveHelpTarget({ helpSource: "external", helpUrl: "not a url" }), { href: "/help", external: false });
});
