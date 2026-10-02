import assert from "node:assert/strict";
import test from "node:test";
import { subscribeDeviceAccount } from "./use-device-account.ts";

test("账号识别、跨标签页变化与恢复焦点通知作用域，卸载后不再通知", () => {
  const target = new EventTarget();
  let updates = 0;
  const unsubscribe = subscribeDeviceAccount(target, () => { updates++; });
  target.dispatchEvent(new Event("kb:device-storage"));
  target.dispatchEvent(new Event("storage"));
  target.dispatchEvent(new Event("focus"));
  assert.equal(updates, 3);
  unsubscribe();
  target.dispatchEvent(new Event("kb:device-storage"));
  target.dispatchEvent(new Event("storage"));
  assert.equal(updates, 3);
});
