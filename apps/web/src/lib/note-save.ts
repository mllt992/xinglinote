export type NoteDraft = {
  id: string;
  title: string;
  bodyMd: string;
  version: number;
  aiIndex: boolean;
  published: boolean;
  tags?: string[];
};

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
    title: live.title,
    bodyMd: live.bodyMd,
    aiIndex: live.aiIndex,
    published: live.published,
    tags: live.tags,
    version: saved.version,
  };
}
