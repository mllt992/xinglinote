import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WORKBENCH, MAX_NOTE_PANES, addWorkbenchPane, closeWorkbenchTab, normalizeWorkbench,
  openWorkbenchTab, placeWorkbenchPane, reorderWorkbenchTab, updatePaneWidths,
} from "./note-workbench";

const tab = (id: string, notebookId = `nb-${id}`) => ({ id, title: `笔记 ${id}`, notebookId });

test("打开新笔记会加入标签并替换焦点窗格", () => {
  let state = openWorkbenchTab(EMPTY_WORKBENCH, tab("a"));
  state = addWorkbenchPane({ ...state, tabs: [...state.tabs, tab("b")] }, "b");
  state = openWorkbenchTab(state, tab("c"), "a");
  assert.deepEqual(state.tabs.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(state.paneIds, ["c", "b"]);
});

test("重新取得已有窗格焦点不会破坏并列布局", () => {
  const state = normalizeWorkbench({ tabs: [tab("a"), tab("b")], paneIds: ["a", "b"], paneWidths: [0.4, 0.6] });
  const next = openWorkbenchTab(state, { ...tab("b"), title: "新标题" }, "a");
  assert.deepEqual(next.paneIds, ["a", "b"]);
  assert.deepEqual(next.paneWidths, [0.4, 0.6]);
  assert.equal(next.tabs[1]?.title, "新标题");
});

test("拖入窗格最多三篇，满时替换落点；已有窗格拖动则排序", () => {
  const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
  let state = normalizeWorkbench({ tabs, paneIds: ["a", "b", "c"], paneWidths: [1, 1, 1] });
  state = placeWorkbenchPane(state, "d", 1);
  assert.equal(state.paneIds.length, MAX_NOTE_PANES);
  assert.deepEqual(state.paneIds, ["a", "d", "c"]);
  state = placeWorkbenchPane(state, "c", 0);
  assert.deepEqual(state.paneIds, ["c", "a", "d"]);
});

test("关闭焦点标签选择相邻项并保证至少一个窗格", () => {
  const state = normalizeWorkbench({ tabs: [tab("a"), tab("b"), tab("c")], paneIds: ["b"], paneWidths: [1] });
  const closed = closeWorkbenchTab(state, "b", "b");
  assert.equal(closed.nextActiveId, "c");
  assert.deepEqual(closed.state.paneIds, ["c"]);
});

test("关闭焦点窗格优先聚焦仍在画布里的相邻窗格", () => {
  const state = normalizeWorkbench({ tabs: [tab("a"), tab("b"), tab("c")], paneIds: ["a", "c"], paneWidths: [0.5, 0.5] });
  const closed = closeWorkbenchTab(state, "a", "a");
  assert.equal(closed.nextActiveId, "c");
  assert.deepEqual(closed.state.paneIds, ["c"]);
});

test("损坏的持久化状态会去重、丢弃幽灵窗格并修正宽度", () => {
  const state = normalizeWorkbench({
    tabs: [tab("a"), tab("a"), { id: "bad", title: "坏", notebookId: "" }],
    paneIds: ["ghost", "a", "a"],
    paneWidths: [-1, 2, 3],
  });
  assert.deepEqual(state.tabs.map((item) => item.id), ["a"]);
  assert.deepEqual(state.paneIds, ["a"]);
  assert.deepEqual(state.paneWidths, [1]);
});

test("标签排序不改变窗格，窗格宽度会归一化", () => {
  let state = normalizeWorkbench({ tabs: [tab("a"), tab("b")], paneIds: ["a", "b"] });
  state = reorderWorkbenchTab(state, "a", "b");
  assert.deepEqual(state.tabs.map((item) => item.id), ["b", "a"]);
  assert.deepEqual(state.paneIds, ["a", "b"]);
  state = updatePaneWidths(state, [30, 70]);
  assert.deepEqual(state.paneWidths, [0.3, 0.7]);
});
