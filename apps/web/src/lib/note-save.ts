export type NoteDraft = {
  id: string;
  title: string;
  bodyMd: string;
  version: number;
  aiIndex: boolean;
  published: boolean;
  tags?: string[];
};

function sameTags(left: string[] | undefined, right: string[] | undefined) {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
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
