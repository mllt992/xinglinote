/** 移动端速记只保存明确选中的类型，不对正文偷偷做自然语言改写。 */
export type CaptureKind = "task" | "journal" | "note";
export type CaptureDraft = { id: string; text: string; kind: CaptureKind; notebookId: string; noteId?: string };
export type CaptureNote = { id: string; version: number; bodyMd: string };
export type CaptureRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export const captureDraftKey = (userId: string, workspaceId: string) => `kb.capture.${userId}.${workspaceId}`;
export function readCaptureDraft(value: string | null): CaptureDraft | null {
  if (!value) return null;
  try {
    const d = JSON.parse(value) as Partial<CaptureDraft>;
    if (typeof d.id !== "string" || !/^[\w-]+$/.test(d.id) || typeof d.text !== "string" || typeof d.notebookId !== "string" || !["task", "journal", "note"].includes(d.kind ?? "")) return null;
    if (d.noteId !== undefined && typeof d.noteId !== "string") return null;
    return d as CaptureDraft;
  } catch { return null; }
}

export function captureTaskBody(text: string, dueAt: string, timezone: string) {
  if (!text.trim()) throw new Error("先写点内容");
  const title = text.trim().split(/\r?\n/)[0].slice(0, 200);
  // 长文本完整留在备注里；不能截掉 200 字以后就当作保存成功。
  const bodyMd = text === title ? "" : text;
  if (bodyMd.length > 2000) throw new Error("任务备注最多 2000 字，请缩短内容或存为日记 / 笔记");
  return { kind: "task", title, bodyMd, dueAt, timezone, allDay: true };
}

export function appendCapture(body: string, text: string, captureId: string) {
  const marker = `<!-- kb-capture:${captureId} -->`;
  if (body.includes(marker)) return body;
  const separator = !body || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${marker}\n${text}\n`;
}

/** 每次冲突重新读取再追加；绝不 force 覆盖。标记让响应丢失后的重试不会重复追加。 */
export async function appendCapturedNote(request: CaptureRequest, noteId: string, text: string, captureId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const note = await request<CaptureNote>(`/api/v1/notes/${noteId}`);
    const bodyMd = appendCapture(note.bodyMd, text, captureId);
    if (bodyMd === note.bodyMd) return;
    try {
      await request(`/api/v1/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: note.version, bodyMd }) });
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "CONFLICT_VERSION" || attempt === 2) throw error;
    }
  }
}

/** 墙钟仅用于日期运算，避免设备时区与工作区时区混算。 */
export function captureCivil(instant: Date | string, timezone: string) {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return new Date(Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute));
}
export function captureWallToIso(wall: Date, timezone: string) {
  const guess = wall.getTime();
  let real = new Date(guess);
  for (let i = 0; i < 3; i++) real = new Date(guess - (captureCivil(real, timezone).getTime() - real.getTime()));
  return real.toISOString();
}
export type ReschedulePreset = "today" | "tomorrow" | "weekend";
export function reschedulePresetDate(preset: ReschedulePreset, now: Date, timezone: string, original?: string | null) {
  const wall = captureCivil(now, timezone);
  const day = wall.getUTCDay();
  const offset = preset === "tomorrow" ? 1 : preset === "weekend" && day !== 0 && day !== 6 ? 6 - day : 0;
  const time = original ? captureCivil(original, timezone) : null;
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + offset, time?.getUTCHours() ?? 23, time?.getUTCMinutes() ?? 59));
}
export function isCompletionSwipe(dx: number, dy: number, elapsedMs: number) {
  return dx >= 72 && Math.abs(dy) <= 32 && dx > Math.abs(dy) * 2 && elapsedMs <= 1200;
}
