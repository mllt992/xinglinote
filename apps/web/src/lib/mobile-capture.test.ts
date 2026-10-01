import assert from "node:assert/strict";
import { test } from "node:test";
import { appendCapture, appendCapturedNote, captureDraftKey, captureTaskBody, captureWallToIso, isCompletionSwipe, readCaptureDraft, reschedulePresetDate, type CaptureRequest } from "./mobile-capture.js";

test("草稿按用户和工作区隔离，异常缓存不崩溃", () => {
  assert.notEqual(captureDraftKey("a", "w"), captureDraftKey("b", "w"));
  assert.notEqual(captureDraftKey("a", "w"), captureDraftKey("a", "x"));
  assert.equal(readCaptureDraft("broken"), null);
  assert.equal(readCaptureDraft('{"id":"x","text":"稿"}'), null);
  const draft = { id: "capture-1", text: "未保存\n内容", kind: "journal", notebookId: "", noteId: "existing" };
  assert.deepEqual(readCaptureDraft(JSON.stringify(draft)), draft);
});

test("任务保留多行和长文本，超出限制时拒绝而不截断", () => {
  const text = "记下想法\n第二行不能丢";
  const task = captureTaskBody(text, "2026-10-01T15:59:00Z", "Asia/Shanghai");
  assert.equal(task.title, "记下想法");
  assert.equal(task.bodyMd, text);
  assert.equal(captureTaskBody("简短任务", "x", "UTC").bodyMd, "");
  assert.equal(captureTaskBody("长".repeat(201), "x", "UTC").bodyMd.length, 201);
  assert.throws(() => captureTaskBody("字".repeat(2001), "x", "UTC"));
  assert.throws(() => captureTaskBody("  ", "x", "UTC"));
});

test("日记追加保留原文，重复重试不会重复写入", () => {
  const original = "# 今天\n\n原来的正文  \n";
  const result = appendCapture(original, "新想法\n第二行", "one");
  assert.ok(result.startsWith(original));
  assert.ok(result.endsWith("新想法\n第二行\n"));
  assert.equal(appendCapture(result, "新想法\n第二行", "one"), result);
  assert.notEqual(appendCapture(result, "新想法\n第二行", "two"), result);
});

test("日记并发保存冲突会读取最新版本再追加", async () => {
  let reads = 0;
  const patches: Array<{ expectedVersion: number; bodyMd: string }> = [];
  const request = (async (_path: string, init?: RequestInit) => {
    if (!init) return { id: "n", version: ++reads, bodyMd: reads === 1 ? "原文" : "原文\n他人的改动" };
    patches.push(JSON.parse(String(init.body)));
    if (patches.length === 1) throw Object.assign(new Error("冲突"), { code: "CONFLICT_VERSION" });
    return {};
  }) as CaptureRequest;
  await appendCapturedNote(request, "n", "速记", "one");
  assert.equal(patches.length, 2);
  assert.equal(patches[1].expectedVersion, 2);
  assert.ok(patches[1].bodyMd.includes("他人的改动"));
  assert.ok(patches.every(p => !("force" in p)));
});

test("响应丢失后重试读取到标记，不再写入", async () => {
  let writes = 0;
  const request = (async (_path: string, init?: RequestInit) => {
    if (init) writes++;
    return { id: "n", version: 2, bodyMd: appendCapture("原文", "速记", "one") };
  }) as CaptureRequest;
  await appendCapturedNote(request, "n", "速记", "one");
  assert.equal(writes, 0);
});

test("网络错误保留草稿的上层重试权，不盲目重写", async () => {
  let writes = 0;
  const request = (async (_path: string, init?: RequestInit) => {
    if (!init) return { id: "n", version: 1, bodyMd: "原文" };
    writes++;
    throw new Error("离线");
  }) as CaptureRequest;
  await assert.rejects(appendCapturedNote(request, "n", "速记", "one"), /离线/);
  assert.equal(writes, 1);
});

test("今天、明天、周末按工作区墙钟改期且保留时间", () => {
  const now = new Date("2026-10-02T20:00:00Z"); // 上海已经周六
  assert.equal(reschedulePresetDate("weekend", now, "Asia/Shanghai").toISOString(), "2026-10-03T23:59:00.000Z");
  assert.equal(reschedulePresetDate("tomorrow", now, "Asia/Shanghai", "2026-09-01T02:30:00Z").toISOString(), "2026-10-04T10:30:00.000Z");
  assert.equal(reschedulePresetDate("weekend", new Date("2026-10-01T12:00:00Z"), "UTC").toISOString(), "2026-10-03T23:59:00.000Z");
  assert.equal(reschedulePresetDate("weekend", new Date("2026-10-04T12:00:00Z"), "UTC").toISOString(), "2026-10-04T23:59:00.000Z");
});

test("跨夏令时保持当地时刻而非加24小时", () => {
  const wall = reschedulePresetDate("tomorrow", new Date("2026-10-31T16:00:00Z"), "America/New_York", "2026-10-30T13:00:00Z");
  assert.equal(captureWallToIso(wall, "America/New_York"), "2026-11-01T14:00:00.000Z");
});

test("只有明确右滑才完成，纵向滚动与轻触不会误完成", () => {
  assert.equal(isCompletionSwipe(90, 10, 400), true);
  assert.equal(isCompletionSwipe(90, 80, 400), false);
  assert.equal(isCompletionSwipe(-90, 0, 400), false);
  assert.equal(isCompletionSwipe(20, 2, 400), false);
  assert.equal(isCompletionSwipe(90, 0, 2000), false);
});

test('跨挂载请求所有权与新草稿比较，旧响应不能清空新正文', async()=>{
 const {beginCapture,finishCapture,captureIsPending,canReplaceCapture}=await import('./mobile-capture.ts');
 assert.equal(beginCapture('u.w','a'),true);assert.equal(beginCapture('u.w','a'),false);
 assert.equal(captureIsPending('u.w'),true);finishCapture('u.w','different');assert.equal(captureIsPending('u.w'),true);
 finishCapture('u.w','a');assert.equal(captureIsPending('u.w'),false);
 const draft=JSON.stringify({id:'b',text:'新内容',kind:'task',notebookId:''});
 assert.equal(canReplaceCapture(draft,'a'),false);assert.equal(canReplaceCapture(draft,'b'),true);
});

test('请求状态通知不能要求从失败的持久化覆盖内存草稿',async()=>{
 const {subscribeCapture,beginCapture,finishCapture,notifyCaptureChange}=await import('./mobile-capture.ts');
 const events:boolean[]=[];const stop=subscribeCapture(changed=>events.push(changed));
 beginCapture('quota.w','a');finishCapture('quota.w','a');notifyCaptureChange(true);stop();
 assert.deepEqual(events,[false,false,true]);
});
