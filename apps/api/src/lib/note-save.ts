/**
 * 无变化保存仍要让界面看到一次保存，但不能推进内容版本。
 * 时间保持严格单调，保证同一毫秒里的连续保存也能被客户端观察到。
 */
export function nextNoteSavedAt(previous: Date, now = new Date()) {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}
