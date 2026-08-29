export type NoteDraft = {
  id: string;
  title: string;
  bodyMd: string;
  version: number;
  aiIndex: boolean;
  published: boolean;
  tags?: string[];
};

/** 停键多久才自动保存。失焦 / 切篇 / Ctrl+S 仍立刻。设计 03 §3.3。 */
export const NOTE_AUTOSAVE_MS = 1500;

export type NoteSaveConflict = {
  version: number;
  expectedVersion: number;
  updatedBy: string;
  title: string;
  bodyMd: string;
};

export function parseNoteSaveConflict(error: unknown): NoteSaveConflict | null {
  if (!error || typeof error !== "object") return null;
  const err = error as { code?: string; fields?: Record<string, string> };
  if (err.code !== "CONFLICT_VERSION" || !err.fields) return null;
  const version = Number(err.fields.version ?? err.fields.current_version);
  const expectedVersion = Number(err.fields.expected_version);
  if (!Number.isInteger(version) || version < 1 || err.fields.bodyMd === undefined) return null;
  return {
    version,
    expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : version,
    updatedBy: err.fields.updatedBy?.trim() || "其他人",
    title: err.fields.title ?? "",
    bodyMd: err.fields.bodyMd,
  };
}

export const NOTE_METADATA_KEYS = ["title", "aiIndex", "published", "tags"] as const;
export type NoteMetadataKey = (typeof NOTE_METADATA_KEYS)[number];

export function isSaveHotkey(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s";
}

function sameTags(left: string[] | undefined, right: string[] | undefined) {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** 正文由协同房间保存时，REST 只需要处理这些元数据字段。 */
export function noteMetadataKeys(patch: Partial<NoteDraft>): NoteMetadataKey[] {
  return NOTE_METADATA_KEYS.filter(key => Object.prototype.hasOwnProperty.call(patch, key));
}

export function sameNoteMetadataValue(left: NoteDraft, right: NoteDraft, key: NoteMetadataKey) {
  return key === "tags" ? sameTags(left.tags, right.tags) : left[key] === right[key];
}

export function pickNoteMetadata(note: NoteDraft, keys: Iterable<NoteMetadataKey>) {
  const out: Partial<Pick<NoteDraft, NoteMetadataKey>> = {};
  for (const key of keys) {
    if (key === "tags") out.tags = note.tags ?? [];
    else if (key === "title") out.title = note.title;
    else if (key === "aiIndex") out.aiIndex = note.aiIndex;
    else out.published = note.published;
  }
  return out;
}

/** 请求发出后用户是否又改了草稿；这些字段不能被较旧的响应覆盖。 */
export function noteDraftChanged(live: NoteDraft, sent: NoteDraft) {
  return live.title !== sent.title
    || live.bodyMd !== sent.bodyMd
    || live.aiIndex !== sent.aiIndex
    || live.published !== sent.published
    || !sameTags(live.tags, sent.tags);
}

/** 接收服务端的新版本号和元信息，同时保住请求飞行期间继续输入的草稿。 */
export function reconcileSavedNote<T extends NoteDraft>(live: T, sent: T, saved: T): T {
  if (!noteDraftChanged(live, sent)) return saved;
  return {
    ...saved,
    title: live.title !== sent.title ? live.title : saved.title,
    bodyMd: live.bodyMd !== sent.bodyMd ? live.bodyMd : saved.bodyMd,
    aiIndex: live.aiIndex !== sent.aiIndex ? live.aiIndex : saved.aiIndex,
    published: live.published !== sent.published ? live.published : saved.published,
    tags: sameTags(live.tags, sent.tags) ? saved.tags : live.tags,
    version: saved.version,
  };
}
