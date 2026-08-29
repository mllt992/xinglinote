import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/** 上传一个文件，回来一段可以直接落进正文的 Markdown。返回 null = 失败，什么都不插。 */
export type FileUploader = (file: File) => Promise<string | null>;

let seq = 0;

type Pending = { id: number; pos: number };

const addUpload = StateEffect.define<Pending>();
const dropUpload = StateEffect.define<number>();

/**
 * 「上传中」是**装饰**，不是正文。
 *
 * 以前这里往文档里插一段 `[⏳ 上传中 1]()` 占位文本，传完再按原文替换回来。问题是那一下
 * 就是一次普通的文档改动：`onChange` 照常触发 → 1.5s 自动保存 → 占位符落进 `notes.body_md`，
 * 还可能单独占一条 `note_versions`；协同开着的话它还会广播给房间里所有人；
 * 传到一半关掉标签页，这段占位符就永久留在正文里了。而**任何一个真实文件都传不完 1.5s**。
 *
 * 现在改成：上传期间文档一个字节都不动，只在插入点画一个小部件；传成功了才把 Markdown
 * 作为一次普通输入插进去。位置随文档改动一起平移，中间用户接着打字也不会插错地方。
 */
class UploadWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-uploading";
    span.textContent = "上传中…";
    return span;
  }
  /** 纯提示，不接任何事件——点它应该跟点旁边的空白一样把光标放过去。 */
  ignoreEvent() { return true; }
}

const uploads = StateField.define<Pending[]>({
  create: () => [],
  update(list, tr) {
    let next = list;
    // assoc = 1：光标停在插入点时接着打字，占位应该留在新字的后面
    if (tr.docChanged) next = next.map(p => ({ ...p, pos: tr.changes.mapPos(p.pos, 1) }));
    for (const effect of tr.effects) {
      if (effect.is(addUpload)) next = [...next, effect.value];
      else if (effect.is(dropUpload)) next = next.filter(p => p.id !== effect.value);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field, list => decorate(list)),
});

function decorate(list: Pending[]): DecorationSet {
  if (!list.length) return Decoration.none;
  return Decoration.set(list.map(p => Decoration.widget({ widget: new UploadWidget(), side: 1 }).range(p.pos)), true);
}

/**
 * 粘贴或拖进来的文件直接存成当前笔记的附件，正文插链接（规格 §9.3、设计 06）。
 */
export function fileDrop(upload?: FileUploader): Extension {
  if (!upload) return [];

  async function ingest(view: EditorView, files: File[], at: number) {
    for (const file of files) {
      const id = ++seq;
      const start = Math.min(Math.max(at, 0), view.state.doc.length);
      view.dispatch({ effects: addUpload.of({ id, pos: start }) });

      let markdown: string | null = null;
      try {
        markdown = await upload!(file);
      } catch {
        markdown = null;                         // 失败的提示归调用方，这里只负责收摊
      }
      // 上传期间用户可能已经换了一篇笔记，编辑器早就拆了；往拆掉的 view 上 dispatch 会炸
      if (!view.dom.isConnected) return;
      const pos = view.state.field(uploads, false)?.find(p => p.id === id)?.pos ?? start;
      const insert = markdown && !view.state.readOnly ? markdown : "";
      view.dispatch({
        ...(insert ? { changes: { from: pos, insert } } : {}),
        effects: dropUpload.of(id),
        userEvent: "input.attachment",
      });
      at = pos + insert.length;
    }
  }

  return [
    uploads,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || view.state.readOnly) return false;
        event.preventDefault();
        void ingest(view, files, view.state.selection.main.from);
        return true;
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || view.state.readOnly) return false;
        event.preventDefault();
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
        void ingest(view, files, at);
        return true;
      },
    }),
  ];
}
