export const NOTE_SLICE_DEFAULT = 2000;
export const NOTE_SLICE_MAX = 20_000;
export const NOTE_SLICE_MIN = 200;
/** get_note(snippet_only=true) 时的摘录上限 */
export const NOTE_SNIPPET_CHARS = 360;

export function sliceNoteBody(body: string, offset = 0, maxChars = NOTE_SLICE_DEFAULT) {
  const total = body.length;
  const cap = Math.min(NOTE_SLICE_MAX, Math.max(NOTE_SLICE_MIN, maxChars));
  const off = Math.max(0, Math.min(Math.floor(offset) || 0, total));
  const text = body.slice(off, off + cap);
  return {
    body_md: text,
    offset: off,
    total_chars: total,
    truncated: off + text.length < total,
  };
}
