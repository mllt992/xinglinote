import assert from "node:assert/strict";
import test from "node:test";
import { errorDetails } from "./error-boundary";

test("errorDetails keeps the runtime stack as well as the React component stack", () => {
  const error = new RangeError("Maximum call stack size exceeded");
  error.stack = "RangeError: Maximum call stack size exceeded\n    at decorate (live-preview.ts:1:1)";

  const details = errorDetails(error, "\n    at MarkdownEditor (markdown-editor.tsx:1:1)\n");

  assert.match(details, /at decorate/);
  assert.match(details, /React component stack:/);
  assert.match(details, /at MarkdownEditor/);
});

test("errorDetails still returns useful text when stack capture is unavailable", () => {
  const error = new Error("render failed");
  error.stack = undefined;

  assert.equal(errorDetails(error), "Error: render failed");
});
