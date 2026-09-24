import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import MindElixir, { type MindElixirInstance, type NodeObj, type Theme } from "mind-elixir";
import { zh_CN } from "mind-elixir/i18n";
import "mind-elixir/style.css";
import { noteIdFromHref, noteLinkHref, type MindMapData } from "@kb/shared";

export type MindMapEditorHandle = {
  /** 当前数据（已去掉库内部字段），拿去保存或导出。 */
  getData: () => MindMapData;
  exportPng: () => Promise<Blob | null>;
  addChild: () => void;
  addSibling: () => void;
  removeSelected: () => void;
  center: () => void;
  selectedNode: () => { id: string; topic: string; noteId: string | null; isRoot: boolean } | null;
  /** 给选中节点挂 / 摘笔记关联。noteId 为 null 表示取消关联。 */
  setSelectedNoteLink: (noteId: string | null) => boolean;
  focusNode: (nodeId: string) => void;
};

/** 调色盘在浅色 / 深色底上都要看得清，所以取中等明度。 */
const PALETTE = ["#e5484d", "#f76b15", "#d6a000", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#7c7c85"];

/**
 * 主题跟着站点的 CSS 变量走（换皮肤、切深浅色都能自动跟上），
 * 只有 mind-elixir 自带主题里的 type 用来区分几处它内部写死的对比色。
 */
function themeFor(mode: "light" | "dark"): Theme {
  const base = mode === "dark" ? MindElixir.DARK_THEME : MindElixir.THEME;
  return {
    ...base,
    name: mode === "dark" ? "kb-dark" : "kb-light",
    type: mode,
    palette: PALETTE,
    cssVar: {
      ...base.cssVar,
      "--main-color": "var(--fg)",
      "--main-bgcolor": "var(--bg)",
      "--main-bgcolor-transparent": "color-mix(in srgb, var(--bg) 85%, transparent)",
      "--color": "var(--fg)",
      "--bgcolor": "var(--bg-subtle)",
      "--selected": "var(--accent)",
      "--accent-color": "var(--accent)",
      "--root-color": "var(--accent-fg)",
      "--root-bgcolor": "var(--accent)",
      "--root-border-color": "transparent",
      "--panel-color": "var(--fg)",
      "--panel-bgcolor": "var(--bg)",
      "--panel-border-color": "var(--border)",
    },
  };
}

function currentMode(): "light" | "dark" {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "light";
}

function toPlain(node: NodeObj): MindMapData["nodeData"] {
  const { parent: _parent, children, ...rest } = node;
  const out = { ...rest } as MindMapData["nodeData"];
  if (children?.length) out.children = children.map(toPlain);
  else delete out.children;
  return out;
}

/**
 * mind-elixir 的 React 外壳。库本身是命令式的：这里只在挂载时 init 一次，
 * 之后的改动都从库里读出来往外报，不再从 props 回灌（否则每次保存都会把画布重置）。
 */
export const MindMapEditor = forwardRef<MindMapEditorHandle, {
  data: MindMapData;
  editable: boolean;
  onChange: () => void;
  onOpenNote: (noteId: string) => void;
  onSelect?: () => void;
}>(function MindMapEditor({ data, editable, onChange, onOpenNote, onSelect }, ref) {
  const host = useRef<HTMLDivElement | null>(null);
  const mind = useRef<MindElixirInstance | null>(null);
  const handlers = useRef({ onChange, onOpenNote, onSelect });
  handlers.current = { onChange, onOpenNote, onSelect };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const instance = new MindElixir({
      el,
      direction: data.direction,
      editable,
      toolBar: true,
      keypress: true,
      allowUndo: true,
      // 连线（link）与摘要不入库（见设计 25 §2），菜单里干脆不给。
      contextMenu: editable ? { locale: zh_CN, focus: true, link: false } : false,
      newTopicName: "新节点",
      theme: themeFor(currentMode()),
    });
    instance.init({ nodeData: structuredClone(data.nodeData) as NodeObj, direction: data.direction });
    instance.clearHistory?.();
    mind.current = instance;

    // linkDiv 在每次重新布局后触发：增删改、拖拽、折叠、撤销重做都会走到，拿它当「可能变了」的统一信号，
    // 真正有没有变由外面比对序列化结果决定。
    const changed = () => handlers.current.onChange();
    instance.bus.addListener("linkDiv", changed);
    instance.bus.addListener("operation", changed);
    const selected = () => handlers.current.onSelect?.();
    instance.bus.addListener("selectNodes", selected);
    instance.bus.addListener("unselectNodes", selected);

    // 节点上的 🔗：站内笔记锚点改成应用内跳转，外链补上 noopener。
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a.hyper-link");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute("href") ?? "";
      const noteId = noteIdFromHref(href);
      if (noteId) handlers.current.onOpenNote(noteId);
      else if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
    };
    el.addEventListener("click", click, true);

    const observer = new MutationObserver(() => instance.changeTheme(themeFor(currentMode())));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

    return () => {
      observer.disconnect();
      el.removeEventListener("click", click, true);
      instance.destroy();
      mind.current = null;
    };
    // 只在挂载时初始化；换导图时外层用 key 重建组件。
  }, []);

  useImperativeHandle(ref, () => ({
    getData: () => {
      const m = mind.current!;
      const d = m.getData();
      return { nodeData: toPlain(d.nodeData), direction: m.direction };
    },
    exportPng: () => mind.current!.exportPng(true),
    addChild: () => { const m = mind.current; if (m?.currentNode) void m.addChild(); },
    addSibling: () => { const m = mind.current; if (m?.currentNode && m.currentNode.nodeObj.parent) void m.insertSibling("after"); },
    removeSelected: () => {
      const m = mind.current;
      const nodes = (m?.currentNodes ?? []).filter(n => n.nodeObj.parent);
      if (m && nodes.length) void m.removeNodes(nodes);
    },
    center: () => { const m = mind.current; if (m) { m.scaleFit(); m.toCenter(); } },
    selectedNode: () => {
      const n = mind.current?.currentNode?.nodeObj;
      return n ? { id: n.id, topic: n.topic, noteId: noteIdFromHref(n.hyperLink), isRoot: !n.parent } : null;
    },
    setSelectedNoteLink: noteId => {
      const m = mind.current;
      const tpc = m?.currentNode;
      if (!m || !tpc) return false;
      if (noteId) void m.reshapeNode(tpc, { hyperLink: noteLinkHref(noteId), metadata: { noteId } });
      else {
        // reshapeNode 只做合并，删字段得直接改数据再重排。
        delete tpc.nodeObj.hyperLink;
        delete tpc.nodeObj.metadata;
        void m.reshapeNode(tpc, {});
      }
      return true;
    },
    focusNode: nodeId => {
      const m = mind.current;
      if (!m) return;
      try { const tpc = m.findEle(nodeId); m.selectNode(tpc); m.scrollIntoView(tpc, true); } catch { /* 节点被删或折叠了就算了 */ }
    },
  }), []);

  return <div ref={host} className="mind-map-host h-full w-full" />;
});
