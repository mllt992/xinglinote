export const MAX_NOTE_PANES = 3;
export const NOTE_TAB_MIME = "application/x-kb-note-tab";

export function readDraggedNoteTab(dataTransfer: Pick<DataTransfer, "getData">): string {
  return dataTransfer.getData(NOTE_TAB_MIME) || dataTransfer.getData("text/plain");
}

export type WorkbenchTab = {
  id: string;
  title: string;
  notebookId: string;
};

export type NoteWorkbenchState = {
  tabs: WorkbenchTab[];
  paneIds: string[];
  /** 每个窗格占工作台正文区的比例，总和始终为 1。 */
  paneWidths: number[];
};

export const EMPTY_WORKBENCH: NoteWorkbenchState = { tabs: [], paneIds: [], paneWidths: [] };

const KEY_PREFIX = "kb.note-workbench.";
const MIN_PANE_RATIO = 0.16;

function equalWidths(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

function normalizedWidths(raw: unknown, count: number): number[] {
  if (!Array.isArray(raw) || raw.length !== count) return equalWidths(count);
  const values = raw.map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < MIN_PANE_RATIO)) return equalWidths(count);
  const sum = values.reduce((total, value) => total + value, 0);
  return sum > 0 ? values.map((value) => value / sum) : equalWidths(count);
}

/** localStorage 可能来自旧版本或被手改过，入口统一收紧，组件里不再重复防御。 */
export function normalizeWorkbench(raw: Partial<NoteWorkbenchState> | null | undefined): NoteWorkbenchState {
  const tabs: WorkbenchTab[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(raw?.tabs) ? raw.tabs : []) {
    if (!value || typeof value.id !== "string" || !value.id || seen.has(value.id)) continue;
    if (typeof value.notebookId !== "string" || !value.notebookId) continue;
    seen.add(value.id);
    tabs.push({ id: value.id, title: typeof value.title === "string" ? value.title : "", notebookId: value.notebookId });
  }
  const paneIds = [...new Set(Array.isArray(raw?.paneIds) ? raw.paneIds.filter((id): id is string => typeof id === "string" && seen.has(id)) : [])]
    .slice(0, MAX_NOTE_PANES);
  if (!paneIds.length && tabs[0]) paneIds.push(tabs[0].id);
  return { tabs, paneIds, paneWidths: normalizedWidths(raw?.paneWidths, paneIds.length) };
}

export function loadWorkbench(workspaceId?: string): NoteWorkbenchState {
  if (!workspaceId) return EMPTY_WORKBENCH;
  try {
    return normalizeWorkbench(JSON.parse(localStorage.getItem(`${KEY_PREFIX}${workspaceId}`) ?? "null") as Partial<NoteWorkbenchState> | null);
  } catch {
    return EMPTY_WORKBENCH;
  }
}

export function saveWorkbench(workspaceId: string | undefined, state: NoteWorkbenchState) {
  if (!workspaceId) return;
  try { localStorage.setItem(`${KEY_PREFIX}${workspaceId}`, JSON.stringify(normalizeWorkbench(state))); } catch { /* 本机偏好写不进去不影响编辑。 */ }
}

function withPaneIds(state: NoteWorkbenchState, paneIds: string[], widths?: number[]): NoteWorkbenchState {
  const next = paneIds.slice(0, MAX_NOTE_PANES);
  return { ...state, paneIds: next, paneWidths: normalizedWidths(widths, next.length) };
}

/** 普通打开替换当前焦点窗格；从标签或已有窗格取得焦点时不破坏现有并列布局。 */
export function openWorkbenchTab(state: NoteWorkbenchState, tab: WorkbenchTab, focusedId?: string): NoteWorkbenchState {
  const current = normalizeWorkbench(state);
  const at = current.tabs.findIndex((item) => item.id === tab.id);
  const tabs = at < 0
    ? [...current.tabs, tab]
    : current.tabs.map((item, index) => index === at ? { ...item, ...tab } : item);
  if (current.paneIds.includes(tab.id)) return { ...current, tabs };
  if (!current.paneIds.length) return { tabs, paneIds: [tab.id], paneWidths: [1] };
  const paneIds = current.paneIds.slice();
  const replaceAt = Math.max(0, current.paneIds.indexOf(focusedId ?? ""));
  paneIds[replaceAt] = tab.id;
  return { ...current, tabs, paneIds };
}

export function reorderWorkbenchTab(state: NoteWorkbenchState, sourceId: string, targetId: string): NoteWorkbenchState {
  const source = state.tabs.findIndex((tab) => tab.id === sourceId);
  const target = state.tabs.findIndex((tab) => tab.id === targetId);
  if (source < 0 || target < 0 || source === target) return state;
  const tabs = state.tabs.slice();
  const [moved] = tabs.splice(source, 1);
  tabs.splice(target, 0, moved!);
  return { ...state, tabs };
}

/** 把标签放到某个窗格位置：已有窗格是排序，新标签是插入，满三篇时替换落点。 */
export function placeWorkbenchPane(state: NoteWorkbenchState, noteId: string, targetIndex: number): NoteWorkbenchState {
  if (!state.tabs.some((tab) => tab.id === noteId)) return state;
  const oldIndex = state.paneIds.indexOf(noteId);
  const paneIds = state.paneIds.filter((id) => id !== noteId);
  let at = Math.max(0, Math.min(Math.trunc(targetIndex), paneIds.length));
  if (oldIndex < 0 && paneIds.length >= MAX_NOTE_PANES) {
    at = Math.min(at, MAX_NOTE_PANES - 1);
    paneIds.splice(at, 1);
  }
  paneIds.splice(at, 0, noteId);
  const next = paneIds.slice(0, MAX_NOTE_PANES);
  return withPaneIds(state, next, next.length === state.paneIds.length ? state.paneWidths : undefined);
}

export function addWorkbenchPane(state: NoteWorkbenchState, noteId: string): NoteWorkbenchState {
  if (state.paneIds.includes(noteId) || state.paneIds.length >= MAX_NOTE_PANES) return state;
  return placeWorkbenchPane(state, noteId, state.paneIds.length);
}

export function removeWorkbenchPane(state: NoteWorkbenchState, noteId: string, activeId?: string): NoteWorkbenchState {
  if (noteId === activeId || !state.paneIds.includes(noteId)) return state;
  return withPaneIds(state, state.paneIds.filter((id) => id !== noteId));
}

export function closeWorkbenchTab(state: NoteWorkbenchState, noteId: string, activeId?: string): { state: NoteWorkbenchState; nextActiveId?: string } {
  const at = state.tabs.findIndex((tab) => tab.id === noteId);
  if (at < 0) return { state, nextActiveId: activeId };
  const tabs = state.tabs.filter((tab) => tab.id !== noteId);
  const paneAt = state.paneIds.indexOf(noteId);
  let paneIds = state.paneIds.filter((id) => id !== noteId);
  // 关闭焦点窗格时优先把焦点交给相邻窗格，不能跳去一个不可见标签再把现有并列布局顶掉。
  const fallback = paneAt >= 0
    ? paneIds[Math.min(paneAt, paneIds.length - 1)] ?? tabs[Math.min(at, tabs.length - 1)]?.id
    : tabs[Math.min(at, tabs.length - 1)]?.id;
  if (!paneIds.length && fallback) paneIds = [fallback];
  const next = withPaneIds({ ...state, tabs }, paneIds);
  return { state: next, nextActiveId: activeId === noteId ? fallback : activeId };
}

/** 批量关闭时逐次传递焦点候选，避免“关闭其他/右侧”后跳到一个也已被关闭的标签。 */
export function closeWorkbenchTabs(state: NoteWorkbenchState, noteIds: Iterable<string>, activeId?: string): { state: NoteWorkbenchState; nextActiveId?: string } {
  const closing = new Set(noteIds);
  let next = state;
  let nextActiveId = activeId;
  for (const tab of state.tabs) {
    if (!closing.has(tab.id)) continue;
    const closed = closeWorkbenchTab(next, tab.id, nextActiveId);
    next = closed.state;
    nextActiveId = closed.nextActiveId;
  }
  return { state: next, nextActiveId };
}

export function updateWorkbenchTab(state: NoteWorkbenchState, tab: WorkbenchTab): NoteWorkbenchState {
  if (!state.tabs.some((item) => item.id === tab.id)) return state;
  return { ...state, tabs: state.tabs.map((item) => item.id === tab.id ? { ...item, ...tab } : item) };
}

export function updatePaneWidths(state: NoteWorkbenchState, widths: number[]): NoteWorkbenchState {
  return { ...state, paneWidths: normalizedWidths(widths, state.paneIds.length) };
}
