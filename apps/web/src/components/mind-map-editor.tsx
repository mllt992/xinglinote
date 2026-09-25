import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import MindMap, { type SmmNode } from "simple-mind-map";
import MiniMapPlugin from "simple-mind-map/src/plugins/MiniMap.js";
import SearchPlugin from "simple-mind-map/src/plugins/Search.js";
import ExportPlugin from "simple-mind-map/src/plugins/Export.js";
import ExportPDFPlugin from "simple-mind-map/src/plugins/ExportPDF.js";
import ExportXMindPlugin from "simple-mind-map/src/plugins/ExportXMind.js";
import AssociativeLinePlugin from "simple-mind-map/src/plugins/AssociativeLine.js";
import DemonstratePlugin from "simple-mind-map/src/plugins/Demonstrate.js";
import KeyboardNavigationPlugin from "simple-mind-map/src/plugins/KeyboardNavigation.js";
import SelectPlugin from "simple-mind-map/src/plugins/Select.js";
import DragPlugin from "simple-mind-map/src/plugins/Drag.js";
import OuterFramePlugin from "simple-mind-map/src/plugins/OuterFrame.js";
import NodeImgAdjustPlugin from "simple-mind-map/src/plugins/NodeImgAdjust.js";
import PainterPlugin from "simple-mind-map/src/plugins/Painter.js";
import TouchEventPlugin from "simple-mind-map/src/plugins/TouchEvent.js";
import Themes from "simple-mind-map-plugin-themes";
import iconsModule from "simple-mind-map/src/svg/icons.js";
import {
  AlignHorizontalJustifyStart, ArrowUpToLine, Bold, BookOpen, Brackets, ChevronDown, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, Copy,
  Crosshair, Download, Expand, FileUp, GitBranchPlus, Highlighter, ImagePlus, Italic, Keyboard, LayoutTemplate, Link2, Link2Off, ListTree,
  Locate, Map as MapIcon, Maximize, Minus, MoreHorizontal, Paintbrush, Palette, Plus, Presentation, Redo2, Scissors, Search, Smile, Sparkles,
  SquareDashed, StickyNote, Strikethrough, Tag, Trash2, Underline, Undo2, Unlink, Waypoints, X, Type,
} from "lucide-react";
import {
  MIND_MAP_FORMAT, MIND_MAP_LAYOUTS, mindMapFromMarkdown, mindMapToOutline, noteIdFromHref, noteLinkHref, sanitizeMindMap,
  type MindMapData, type MindMapNode, type OutlineNode,
} from "@kb/shared";
import { api } from "../api";
import { downloadText, fileSafe, imageFileToDataUrl, importMindMapFile, IMPORT_ACCEPT, toJson, toMarkdown, toOpml } from "../lib/mind-map-io";
import { cn } from "../lib/utils";
import { NotePickerDialog } from "./note-picker-dialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tooltip } from "./ui/tooltip";
import { useConfirm } from "./ui/confirm";
import { useToast } from "./ui/toast";

MindMap.usePlugin(MiniMapPlugin).usePlugin(SearchPlugin).usePlugin(ExportPlugin).usePlugin(ExportPDFPlugin).usePlugin(ExportXMindPlugin)
  .usePlugin(AssociativeLinePlugin).usePlugin(DemonstratePlugin).usePlugin(KeyboardNavigationPlugin).usePlugin(SelectPlugin).usePlugin(DragPlugin)
  .usePlugin(OuterFramePlugin).usePlugin(NodeImgAdjustPlugin).usePlugin(PainterPlugin).usePlugin(TouchEventPlugin);
Themes.init(MindMap);

const THEME_KB = "kb";
const ICON_GROUPS = iconsModule.nodeIconList;
const ICON_GROUP_LABEL: Record<string, string> = { priority: "优先级", progress: "进度", expression: "表情", sign: "标记" };
const iconSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

// —— 跟随站点的主题：SVG 属性里用不了 var()，所以运行时读出 CSS 变量的实际颜色再定义主题 ——

function cssColor(name: string, fallback: string) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  // 统一转成 #rrggbb / rgba()：皮肤里可能写 oklch() 之类，导出 SVG 时未必认。
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return raw;
  ctx.fillStyle = fallback;
  ctx.fillStyle = raw;
  return String(ctx.fillStyle);
}
function mix(a: string, b: string, t: number) {
  const rgb = (c: string) => {
    if (c.startsWith("#") && c.length === 7) return [1, 3, 5].map(i => Number.parseInt(c.slice(i, i + 2), 16));
    const m = /rgba?\(([^)]+)\)/.exec(c);
    return m ? m[1]!.split(",").slice(0, 3).map(x => Number.parseFloat(x)) : [128, 128, 128];
  };
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v * (1 - t) + y[i]! * t).toString(16).padStart(2, "0")).join("")}`;
}
function currentMode(): "light" | "dark" {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "light";
}
function defineSiteTheme() {
  const bg = cssColor("--bg", "#fafafa");
  const fg = cssColor("--fg", "#111111");
  const muted = cssColor("--fg-muted", "#6b6b6b");
  const border = cssColor("--border", "#e4e4e7");
  const subtle = cssColor("--bg-subtle", "#f5f5f5");
  const accent = cssColor("--accent", "#111111");
  const accentFg = cssColor("--accent-fg", "#ffffff");
  const line = mix(muted, bg, currentMode() === "dark" ? 0.25 : 0.35);
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";
  const base = { fontFamily: font, borderDasharray: "none", textDecoration: "none", gradientStyle: false, hoverRectColor: accent };
  MindMap.removeTheme(THEME_KB);
  MindMap.defineTheme(THEME_KB, {
    backgroundColor: bg,
    lineColor: line,
    lineWidth: 1.5,
    lineStyle: "curve",
    rootLineKeepSameInCurve: true,
    generalizationLineColor: line,
    generalizationLineWidth: 1.5,
    associativeLineColor: muted,
    associativeLineActiveColor: accent,
    associativeLineTextColor: fg,
    associativeLineTextFontFamily: font,
    paddingX: 16,
    paddingY: 7,
    root: { ...base, shape: "rectangle", fillColor: accent, color: accentFg, borderColor: "transparent", borderWidth: 0, borderRadius: 10, fontSize: 18, fontWeight: "bold" },
    second: { ...base, shape: "rectangle", fillColor: subtle, color: fg, borderColor: border, borderWidth: 1, borderRadius: 8, fontSize: 15, fontWeight: "normal", marginX: 90, marginY: 36 },
    node: { ...base, shape: "rectangle", fillColor: "transparent", color: fg, borderColor: "transparent", borderWidth: 0, borderRadius: 6, fontSize: 14, fontWeight: "normal", marginX: 46, marginY: 4 },
    generalization: { ...base, shape: "rectangle", fillColor: bg, color: fg, borderColor: line, borderWidth: 1, borderRadius: 8, fontSize: 14, fontWeight: "normal", marginX: 90, marginY: 36 },
  });
}

// —— 样式面板用到的选项 ——

const SHAPES = [
  { value: "rectangle", label: "矩形" }, { value: "roundedRectangle", label: "圆角矩形" }, { value: "ellipse", label: "椭圆" },
  { value: "circle", label: "圆形" }, { value: "diamond", label: "菱形" }, { value: "parallelogram", label: "平行四边形" },
  { value: "octagonalRectangle", label: "八角矩形" }, { value: "outerTriangularRectangle", label: "外三角矩形" }, { value: "innerTriangularRectangle", label: "内三角矩形" },
];
const FONTS = [
  { value: "", label: "跟随主题" },
  { value: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif", label: "黑体" },
  { value: "\"Songti SC\", SimSun, serif", label: "宋体" },
  { value: "\"Kaiti SC\", KaiTi, serif", label: "楷体" },
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "\"SFMono-Regular\", Consolas, monospace", label: "等宽" },
];
const DASHES = [{ value: "none", label: "实线" }, { value: "5,5", label: "虚线" }, { value: "2,4", label: "点线" }];
const LINE_STYLES = [{ value: "curve", label: "曲线" }, { value: "straight", label: "折线" }, { value: "direct", label: "直线" }];
const SWATCHES = ["#e5484d", "#f76b15", "#d6a000", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#7c7c85", "#111111", "#ffffff"];

export const MIND_MAP_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "添加子节点"], ["Enter", "添加同级节点"], ["Shift + Tab", "添加父节点"], ["Delete / Backspace", "删除节点"],
  ["Shift + Backspace", "只删除当前节点（保留子节点）"], ["F2 / 双击", "编辑文字"], ["Shift + Enter", "编辑时换行"],
  ["Ctrl + Z", "撤销"], ["Ctrl + Y / Ctrl + Shift + Z", "重做"], ["Ctrl + C / X / V", "复制 / 剪切 / 粘贴节点"],
  ["Ctrl + G", "给选中节点加概要"], ["/", "展开 / 收起选中节点"], ["Ctrl + ↑ / ↓", "上移 / 下移节点"], ["方向键", "在节点之间移动"],
  ["Ctrl + A", "全选"], ["Ctrl + 拖动 / 右键拖动", "框选多个节点"], ["Ctrl + L", "一键整理布局"],
  ["Ctrl + = / -", "放大 / 缩小"], ["Ctrl + I", "适应画布"], ["Ctrl + Enter", "回到中心主题"],
  ["Ctrl + F", "在导图里搜索"], ["Ctrl + S", "立即保存"], ["滚轮 / 拖动空白处", "平移画布"], ["Ctrl + 滚轮", "缩放"],
  ["演示中 ← / →", "上一步 / 下一步"], ["演示中 Esc", "退出演示"],
];

type Sel = {
  count: number; uid: string; text: string; isRoot: boolean; isGeneralization: boolean;
  noteId: string | null; hyperlink: string; note: string; tags: string[]; icons: string[]; hasImage: boolean;
  style: Record<string, string | number>;
};
const STYLE_KEYS = ["fillColor", "color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "textDecoration", "shape", "borderColor", "borderWidth", "borderDasharray", "borderRadius", "lineColor", "lineWidth", "lineDasharray"] as const;

function readSel(list: SmmNode[]): Sel | null {
  const n = list[0];
  if (!n) return null;
  const style: Record<string, string | number> = {};
  for (const k of STYLE_KEYS) {
    try { const v = n.getData(k) ?? n.getStyle(k, false); if (typeof v === "string" || typeof v === "number") style[k] = v; } catch { /* 概要节点上个别样式取不到 */ }
  }
  const link = String(n.getData("hyperlink") ?? "");
  const noteId = noteIdFromHref(link);
  const tags = ((n.getData("tag") as unknown[] | undefined) ?? []).map(t => typeof t === "string" ? t : String((t as { text?: string })?.text ?? "")).filter(Boolean);
  return {
    count: list.length, uid: n.uid, text: String(n.getData("text") ?? ""), isRoot: n.isRoot, isGeneralization: !!n.isGeneralization,
    noteId, hyperlink: noteId ? "" : link, note: String(n.getData("note") ?? ""),
    tags, icons: (n.getData("icon") as string[] | undefined) ?? [], hasImage: !!n.getData("image"), style,
  };
}

function pathOf(node: SmmNode) {
  const out: string[] = [];
  let cur: SmmNode | null = node;
  while (cur) { out.unshift(String(cur.getData("text") ?? "")); cur = cur.parent; }
  return out;
}
function outlineToChildren(items: OutlineNode[]): Array<{ data: Record<string, unknown>; children: unknown[] }> {
  return items.map(i => ({ data: { text: i.text, ...(i.note ? { note: i.note } : {}) }, children: outlineToChildren(i.children) }));
}

export type MindMapEditorHandle = {
  getData: () => MindMapData | null;
  focusNode: (uid: string) => void;
  /** 整份替换（导入、AI 生成时用），可以撤销。 */
  replaceData: (data: MindMapData) => void;
};

type Props = {
  data: MindMapData;
  title: string;
  mapId: string;
  workspaceId: string;
  editable: boolean;
  /** 工具栏最左边：返回、标题、保存状态。 */
  leading: React.ReactNode;
  /** 「更多」菜单里页面级的操作（版本历史、复制、移动、删除……）。 */
  menu: React.ReactNode;
  onChange: () => void;
  onOpenNote: (noteId: string) => void;
  onSaveNow: () => void;
  /** 下一次保存单独记一版并标上来源（导入 / AI），不和普通编辑合并。 */
  onSourceHint?: (source: "import" | "ai") => void;
};

type Panel = null | "style" | "outline";
type NodeDialog = null | "note" | "link" | "tags" | "icons" | "ai" | "shortcuts";
type Renderer = { copy(): void; cut(): void; paste(): void };

/**
 * simple-mind-map 的 React 外壳 + 全部编辑界面（工具栏、右键菜单、样式 / 大纲面板、搜索、小地图……）。
 * 库本身是命令式的：只在挂载时 init 一次，之后的改动从库里读出来往外报，不从 props 回灌。
 */
export const MindMapEditor = forwardRef<MindMapEditorHandle, Props>(function MindMapEditor(props, ref) {
  const { data, title, mapId, workspaceId, editable, leading, menu } = props;
  const toast = useToast();
  const confirm = useConfirm();
  const host = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const mindRef = useRef<MindMap | null>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  const [history, setHistory] = useState({ index: 0, len: 1 });
  const [scale, setScale] = useState(1);
  const [layout, setLayoutState] = useState<string>(data.layout);
  const [theme, setThemeState] = useState<string>(data.theme.template);
  const [lineStyle, setLineStyle] = useState<string>(String(data.theme.config.lineStyle ?? ""));
  const [panel, setPanel] = useState<Panel>(null);
  const [dialog, setDialog] = useState<NodeDialog>(null);
  const [picking, setPicking] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [miniOpen, setMiniOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [painting, setPainting] = useState(false);
  const [noteTip, setNoteTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; onNode: boolean } | null>(null);
  const [dataTick, setDataTick] = useState(0);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

  const active = useCallback(() => mindRef.current?.renderer.activeNodeList ?? [], []);
  const refreshSel = useCallback(() => setSel(readSel(mindRef.current?.renderer.activeNodeList ?? [])), []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    defineSiteTheme();
    const initial = sanitizeMindMap(data);
    const mind = new MindMap({
      el,
      data: initial.root,
      layout: initial.layout,
      theme: initial.theme.template,
      themeConfig: initial.theme.config,
      readonly: !editable,
      // 不用库自带的 fit：它在异步渲染结束后才执行，组件已卸载（快速切页 / 开发模式双挂载）时会对已销毁的 SVG 取尺寸报错。
      fit: false,
      enableShortcutOnlyWhenMouseInSvg: false,
      mousewheelAction: "move",
      defaultInsertSecondLevelNodeText: "分支主题",
      defaultInsertBelowSecondLevelNodeText: "子主题",
      defaultGeneralizationText: "概要",
      defaultAssociativeLineText: "关联",
      defaultOuterFrameText: "外框",
      maxHistoryCount: 300,
      isShowCreateChildBtnIcon: editable,
      hoverRectColor: cssColor("--accent", "#111111"),
      demonstrateConfig: { openBlankMode: false },
      exportPaddingX: 40,
      exportPaddingY: 40,
      nodeTextEditZIndex: 60,
      nodeNoteTooltipZIndex: 60,
      customNoteContentShow: {
        show: (note: string, left: number, top: number) => setNoteTip({ text: note, x: left, y: top }),
        hide: () => setNoteTip(null),
      },
      customHyperlinkJump: (link: string) => {
        const noteId = noteIdFromHref(link);
        if (noteId) handlers.current.onOpenNote(noteId);
        else if (/^https?:\/\//i.test(link)) window.open(link, "_blank", "noopener,noreferrer");
      },
      // 粘贴进来的导图数据来自系统剪贴板（可能是别处复制的），先洗一遍再交给库。
      customHandleClipboardText: (text: string) => {
        try {
          const raw = JSON.parse(text) as { simpleMindMap?: boolean; data?: unknown };
          if (raw && raw.simpleMindMap && raw.data) {
            const list = (Array.isArray(raw.data) ? raw.data : [raw.data]).slice(0, 200);
            return { simpleMindMap: true, data: list.map(n => sanitizeMindMap({ root: n }).root) };
          }
        } catch { /* 普通文本 */ }
        return text;
      },
      handleNodePasteImg: (file: Blob) => imageFileToDataUrl(file).then(r => ({ url: r.url, size: { width: r.width, height: r.height } })),
      errorHandler: (code: string, err: unknown) => {
        if (/export/i.test(code)) toast.error("导出失败", err instanceof Error ? err.message : undefined);
      },
    });
    mindRef.current = mind;

    const changed = () => { setDataTick(t => t + 1); handlers.current.onChange(); };
    mind.on("data_change", changed);
    mind.on("layout_change", (l: string) => { setLayoutState(l); changed(); });
    mind.on("view_theme_change", (t: string) => { setThemeState(t); changed(); });
    mind.on("node_active", () => refreshSel());
    mind.on("node_tree_render_end", () => refreshSel());
    mind.on("back_forward", (index: number, len: number) => setHistory({ index, len }));
    mind.on("scale", (s: number) => setScale(s));
    mind.on("painter_start", () => setPainting(true));
    mind.on("painter_end", () => setPainting(false));
    mind.on("exit_demonstrate", () => setPresenting(false));

    // 右键菜单：右键拖动是框选，拖过了就不弹菜单。
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => { if (e.button === 2) downAt = { x: e.clientX, y: e.clientY }; };
    el.addEventListener("mousedown", onDown, true);
    const openMenu = (e: MouseEvent, onNode: boolean) => {
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      setMenuAt({ x: e.clientX, y: e.clientY, onNode });
    };
    mind.on("node_contextmenu", (e: MouseEvent) => openMenu(e, true));
    mind.on("contextmenu", (e: MouseEvent) => openMenu(e, false));
    mind.on("draw_click", () => setMenuAt(null));
    mind.on("node_click", () => setMenuAt(null));

    mind.keyCommand.addShortcut("Control+Shift+z", () => mind.execCommand("FORWARD"));
    mind.keyCommand.addShortcut("Control+f", () => setSearchOpen(true));
    mind.keyCommand.addShortcut("Control+s", () => handlers.current.onSaveNow());
    if (editable) mind.keyCommand.addShortcut("F2", () => { const n = mind.renderer.activeNodeList[0]; if (n) mind.renderer.textEdit.show({ node: n }); });

    const observer = new MutationObserver(() => {
      defineSiteTheme();
      if (mind.getTheme() === THEME_KB) mind.setTheme(THEME_KB);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });
    const ro = new ResizeObserver(() => mind.resize());
    ro.observe(el);
    const onFs = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", onFs);
    setReady(true);
    let alive = true;
    const firstFit = () => { mind.off("node_tree_render_end", firstFit); if (alive) window.setTimeout(() => { if (alive) safeFit(mind); }, 0); };
    mind.on("node_tree_render_end", firstFit);

    return () => {
      alive = false;
      observer.disconnect();
      ro.disconnect();
      document.removeEventListener("fullscreenchange", onFs);
      el.removeEventListener("mousedown", onDown, true);
      try { mind.destroy(); } catch { /* 已经销毁 */ }
      mindRef.current = null;
    };
    // 只在挂载时初始化；换导图时外层用 key 重建组件。
  }, []);

  const getData = useCallback((): MindMapData | null => {
    const m = mindRef.current;
    if (!m) return null;
    const d = m.getData(true) as { layout: string; root: MindMapNode; theme: { template: string; config?: Record<string, unknown> } };
    return { format: MIND_MAP_FORMAT, layout: d.layout as MindMapData["layout"], root: d.root, theme: { template: d.theme.template, config: d.theme.config ?? {} } };
  }, []);

  const replaceData = useCallback((next: MindMapData) => {
    const m = mindRef.current;
    if (!m) return;
    const clean = sanitizeMindMap(next);
    m.updateData(clean.root);
    if (clean.layout !== m.getLayout()) m.setLayout(clean.layout);
    if (clean.theme.template !== m.getTheme()) { if (clean.theme.template === THEME_KB) defineSiteTheme(); m.setTheme(clean.theme.template); }
    m.setThemeConfig(clean.theme.config);
    setLineStyle(String(clean.theme.config.lineStyle ?? ""));
    window.setTimeout(() => { if (mindRef.current === m) safeFit(m); }, 60);
  }, []);

  useImperativeHandle(ref, () => ({
    getData,
    focusNode: uid => { const m = mindRef.current; if (m) try { m.execCommand("GO_TARGET_NODE", uid); } catch { /* 节点不在了 */ } },
    replaceData,
  }), [getData, replaceData]);

  // —— 操作 ——
  const exec = (name: string, ...args: unknown[]) => { mindRef.current?.execCommand(name, ...args); };
  const renderer = () => mindRef.current?.renderer as unknown as Renderer | undefined;
  const needNode = (fn: (nodes: SmmNode[], m: MindMap) => void) => () => {
    const m = mindRef.current;
    const nodes = active();
    if (!m || !nodes.length) { toast.error("先选中一个节点", "点一下画布上的节点再操作。"); return; }
    fn(nodes, m);
  };
  const setStyles = (style: Record<string, unknown>) => {
    const nodes = active();
    if (!nodes.length) { toast.error("先选中节点", "样式会应用到选中的节点上。"); return; }
    for (const n of nodes) exec("SET_NODE_STYLES", n, style);
    refreshSel();
  };
  const setMapConfig = (patch: Record<string, unknown>) => {
    const m = mindRef.current;
    if (!m) return;
    const next: Record<string, unknown> = { ...m.getCustomThemeConfig(), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    m.setThemeConfig(next);
    setDataTick(t => t + 1);
    handlers.current.onChange();
  };
  const changeLayout = (l: string) => { mindRef.current?.setLayout(l); setLayoutState(l); };
  const changeTheme = (t: string) => {
    const m = mindRef.current;
    if (!m) return;
    if (t === THEME_KB) defineSiteTheme();
    m.setTheme(t);
    setThemeState(t);
  };
  const center = () => { const m = mindRef.current; if (m?.renderer.root) m.renderer.moveNodeToCenter(m.renderer.root); };
  const clearStyles = () => { for (const n of active()) exec("REMOVE_CUSTOM_STYLES", n); refreshSel(); };

  const addImage = async (file: File) => {
    const nodes = active();
    if (!nodes.length) { toast.error("先选中一个节点"); return; }
    try {
      const img = await imageFileToDataUrl(file);
      for (const n of nodes) exec("SET_NODE_IMAGE", n, { url: img.url, title: "", width: img.width, height: img.height });
    } catch (e) { toast.error("图片没加上", (e as Error).message); }
  };

  const exportAs = async (type: "png" | "svg" | "pdf" | "xmind" | "md" | "opml" | "json") => {
    const m = mindRef.current;
    const d = getData();
    if (!m || !d) return;
    const name = fileSafe(title);
    try {
      if (type === "md") downloadText(toMarkdown(d), `${name}.md`, "text/markdown");
      else if (type === "opml") downloadText(toOpml(d, title), `${name}.opml`, "text/x-opml");
      else if (type === "json") downloadText(toJson(d, title), `${name}.json`, "application/json");
      else await m.export(type, true, name);
      toast.success("已导出", `${name}.${type}`);
    } catch (e) { toast.error("导出失败", (e as Error).message || "浏览器没能生成文件"); }
  };

  const importReplace = async (file: File) => {
    try {
      const { data: next } = await importMindMapFile(file);
      if (!await confirm({ title: "用导入的内容替换当前导图？", description: "当前内容会被替换。可以按 Ctrl + Z 撤销，也能在「版本历史」里找回。", confirmText: "替换" })) return;
      handlers.current.onSourceHint?.("import");
      replaceData(next);
      toast.success("已导入", file.name);
    } catch (e) { toast.error("导入失败", (e as Error).message); }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.current?.requestFullscreen();
    } catch { toast.error("没能进入全屏", "浏览器拒绝了全屏请求。"); }
  };
  const present = () => {
    const m = mindRef.current;
    if (!m?.demonstrate) return;
    setPresenting(true);
    try { m.demonstrate.enter(); } catch { setPresenting(false); toast.error("没能进入演示模式"); }
  };

  const layoutLabel = MIND_MAP_LAYOUTS.find(l => l.value === layout)?.label ?? "结构";
  const themeLabel = theme === THEME_KB ? "跟随站点" : theme === "default" ? "经典" : [...Themes.lightList, ...Themes.darkList].find(t => t.value === theme)?.name ?? "主题";
  const canUndo = history.index > 0;
  const canRedo = history.index < history.len - 1;
  const noSel = !sel;
  const rootSel = !!sel?.isRoot;
  const genSel = !!sel?.isGeneralization;

  const tool = (label: string, icon: React.ReactNode, onClick: () => void, opts: { disabled?: boolean; active?: boolean } = {}) =>
    <Tooltip content={label}><Button variant="ghost" size="icon" className={cn("size-8 shrink-0", opts.active && "bg-muted text-foreground")} aria-label={label} aria-pressed={opts.active}
      disabled={opts.disabled || !ready} onClick={onClick}>{icon}</Button></Tooltip>;
  const sep = <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
  const dot = (on: boolean) => <span className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-foreground" : "bg-transparent")} />;
  const item = (label: string, icon: React.ReactNode, fn: () => void, disabled = false, danger = false) =>
    <button type="button" role="menuitem" disabled={disabled}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4", danger && "text-destructive")}
      onClick={() => { setMenuAt(null); fn(); }}>{icon}<span className="flex-1">{label}</span></button>;
  const hr = <div className="my-1 h-px bg-border" />;

  const toolbar = <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5 sm:px-3" role="toolbar" aria-label="思维导图工具栏">
    {leading}
    <div className="ml-auto flex items-center gap-0.5">
      {editable && <>
        {tool("撤销（Ctrl+Z）", <Undo2 />, () => exec("BACK"), { disabled: !canUndo })}
        {tool("重做（Ctrl+Y）", <Redo2 />, () => exec("FORWARD"), { disabled: !canRedo })}
        {sep}
        {tool("添加子节点（Tab）", <ListTree />, needNode(() => exec("INSERT_CHILD_NODE")), { disabled: noSel || genSel })}
        {tool("添加同级节点（Enter）", <GitBranchPlus />, needNode(() => exec("INSERT_NODE")), { disabled: noSel || rootSel || genSel })}
        {tool("添加父节点（Shift+Tab）", <ArrowUpToLine />, needNode(() => exec("INSERT_PARENT_NODE")), { disabled: noSel || rootSel || genSel })}
        {tool("删除节点（Delete）", <Trash2 />, needNode(() => exec("REMOVE_NODE")), { disabled: noSel || rootSel })}
        {sep}
        {tool("概要（Ctrl+G）", <Brackets />, needNode(() => exec("ADD_GENERALIZATION")), { disabled: noSel || rootSel || genSel })}
        {tool("关联线：点这里，再点目标节点", <Waypoints />, needNode((_, m) => m.associativeLine?.createLineFromActiveNode()), { disabled: noSel })}
        {tool("外框", <SquareDashed />, needNode((nodes, m) => m.outerFrame?.addOuterFrame(nodes, {})), { disabled: noSel || rootSel })}
        {sep}
        {tool("图标", <Smile />, needNode(() => setDialog("icons")), { disabled: noSel })}
        {tool("图片", <ImagePlus />, needNode(() => imageInput.current?.click()), { disabled: noSel })}
        {tool("超链接", <Link2 />, needNode(() => setDialog("link")), { disabled: noSel })}
        {sel?.noteId
          ? tool("取消关联笔记", <Link2Off />, needNode(nodes => { for (const n of nodes) exec("SET_NODE_HYPERLINK", n, "", ""); refreshSel(); }))
          : tool("关联笔记", <BookOpen />, needNode(() => setPicking(true)), { disabled: noSel })}
        {tool("备注", <StickyNote />, needNode(() => setDialog("note")), { disabled: noSel })}
        {tool("标签", <Tag />, needNode(() => setDialog("tags")), { disabled: noSel })}
        {tool("AI 扩展这个节点", <Sparkles />, needNode(() => setDialog("ai")), { disabled: noSel || genSel })}
        {sep}
        {tool(painting ? "格式刷：点目标节点应用样式" : "格式刷：先选中样本节点", <Paintbrush />, () => {
          const m = mindRef.current;
          if (!m) return;
          if (painting) { m.painter?.endPainter(); return; }
          if (!active().length) { toast.error("先选中样本节点", "格式刷会把它的样式刷到你接着点的节点上。"); return; }
          m.painter?.startPainter();
        }, { active: painting })}
        {tool("样式", <Palette />, () => setPanel(p => p === "style" ? null : "style"), { active: panel === "style" })}
      </>}
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1 px-2 text-xs" disabled={!ready || !editable} aria-label="结构"><LayoutTemplate className="size-4" /><span className="hidden max-w-28 truncate xl:inline">{layoutLabel}</span><ChevronDown className="size-3 opacity-60" /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
        {MIND_MAP_LAYOUTS.map(l => <DropdownMenuItem key={l.value} onSelect={() => changeLayout(l.value)}>{dot(l.value === layout)}{l.label}</DropdownMenuItem>)}
      </DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1 px-2 text-xs" disabled={!ready || !editable} aria-label="主题"><Highlighter className="size-4" /><span className="hidden max-w-20 truncate xl:inline">{themeLabel}</span><ChevronDown className="size-3 opacity-60" /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
        <DropdownMenuItem onSelect={() => changeTheme(THEME_KB)}>{dot(theme === THEME_KB)}跟随站点（深浅色自动切换）</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeTheme("default")}>{dot(theme === "default")}经典</DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-2.5 py-1 text-[11px] text-muted-foreground">浅色</p>
        {Themes.lightList.map(t => <DropdownMenuItem key={t.value} onSelect={() => changeTheme(t.value)}>{dot(theme === t.value)}{t.name}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <p className="px-2.5 py-1 text-[11px] text-muted-foreground">深色</p>
        {Themes.darkList.map(t => <DropdownMenuItem key={t.value} onSelect={() => changeTheme(t.value)}>{dot(theme === t.value)}{t.name}</DropdownMenuItem>)}
      </DropdownMenuContent></DropdownMenu>
      {sep}
      {tool("大纲（可直接编辑）", <AlignHorizontalJustifyStart />, () => setPanel(p => p === "outline" ? null : "outline"), { active: panel === "outline" })}
      {tool("搜索（Ctrl+F）", <Search />, () => setSearchOpen(v => !v), { active: searchOpen })}
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="导出" disabled={!ready}><Download /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void exportAs("png")}>图片（PNG）</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs("svg")}>矢量图（SVG）</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs("pdf")}>PDF</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportAs("md")}>Markdown 大纲</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs("xmind")}>XMind</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs("opml")}>OPML</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs("json")}>JSON（可完整导回）</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="更多操作"><MoreHorizontal /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="end" className="w-52">
        {editable && <DropdownMenuItem onSelect={() => importInput.current?.click()}><FileUp />导入并替换…</DropdownMenuItem>}
        {editable && <DropdownMenuItem onSelect={() => exec("RESET_LAYOUT")}><Crosshair />一键整理布局</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => exec("EXPAND_ALL")}><ChevronsUpDown />全部展开</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => exec("UNEXPAND_TO_LEVEL", 1)}><ChevronsDownUp />只展开第一层</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => exec("UNEXPAND_TO_LEVEL", 2)}><ChevronsDownUp />展开到第二层</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDialog("shortcuts")}><Keyboard />快捷键</DropdownMenuItem>
        {menu && <DropdownMenuSeparator />}
        {menu}
      </DropdownMenuContent></DropdownMenu>
    </div>
  </div>;

  const nodeMenu = sel && <>
    {editable ? <>
      {item("添加子节点", <ListTree />, () => exec("INSERT_CHILD_NODE"), genSel)}
      {item("添加同级节点", <GitBranchPlus />, () => exec("INSERT_NODE"), rootSel || genSel)}
      {item("添加父节点", <ArrowUpToLine />, () => exec("INSERT_PARENT_NODE"), rootSel || genSel)}
      {item("编辑文字", <Type />, () => { const n = active()[0]; if (n) mindRef.current?.renderer.textEdit.show({ node: n }); })}
      {hr}
      {item("加概要", <Brackets />, () => exec("ADD_GENERALIZATION"), rootSel || genSel)}
      {item("连一条关联线", <Waypoints />, () => mindRef.current?.associativeLine?.createLineFromActiveNode())}
      {item("加外框", <SquareDashed />, () => mindRef.current?.outerFrame?.addOuterFrame(active(), {}), rootSel)}
      {item(sel.noteId ? "换一篇关联笔记" : "关联笔记", <BookOpen />, () => setPicking(true))}
      {sel.noteId && item("打开关联笔记", <BookOpen />, () => props.onOpenNote(sel.noteId!))}
      {item("备注", <StickyNote />, () => setDialog("note"))}
      {item("AI 扩展", <Sparkles />, () => setDialog("ai"), genSel)}
      {hr}
      {item("上移", <ChevronDown className="rotate-180" />, () => exec("UP_NODE"), rootSel || genSel)}
      {item("下移", <ChevronDown />, () => exec("DOWN_NODE"), rootSel || genSel)}
      {item("复制", <Copy />, () => renderer()?.copy())}
      {item("剪切", <Scissors />, () => renderer()?.cut(), rootSel)}
      {item("粘贴为子节点", <ClipboardPaste />, () => renderer()?.paste(), genSel)}
      {item("清除自定义样式", <Paintbrush />, clearStyles)}
      {sel.hasImage && item("删除图片", <X />, () => { for (const n of active()) exec("SET_NODE_IMAGE", n, null); })}
      {hr}
      {item("只删除这个节点", <Unlink />, () => exec("REMOVE_CURRENT_NODE"), rootSel || genSel)}
      {item("删除节点", <Trash2 />, () => exec("REMOVE_NODE"), rootSel, true)}
    </> : <>
      {item("在画布中居中", <Locate />, () => { const n = active()[0]; if (n) mindRef.current?.renderer.moveNodeToCenter(n); })}
      {sel.noteId && item("打开关联笔记", <BookOpen />, () => props.onOpenNote(sel.noteId!))}
    </>}
  </>;
  const canvasMenu = <>
    {editable && item("撤销", <Undo2 />, () => exec("BACK"), !canUndo)}
    {editable && item("重做", <Redo2 />, () => exec("FORWARD"), !canRedo)}
    {editable && item("全选", <SquareDashed />, () => exec("SELECT_ALL"))}
    {editable && hr}
    {item("回到中心主题", <Locate />, center)}
    {item("适应画布", <Expand />, () => mindRef.current?.view.fit())}
    {item("全部展开", <ChevronsUpDown />, () => exec("EXPAND_ALL"))}
    {item("全部收起", <ChevronsDownUp />, () => exec("UNEXPAND_ALL"))}
    {editable && item("一键整理布局", <Crosshair />, () => exec("RESET_LAYOUT"))}
    {hr}
    {item("导出图片", <Download />, () => void exportAs("png"))}
    {item("快捷键", <Keyboard />, () => setDialog("shortcuts"))}
  </>;

  return <div ref={shell} className="flex h-full min-h-0 flex-col bg-background">
    {toolbar}
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        <div ref={host} className="mind-map-host absolute inset-0" data-testid="mind-map-canvas" />
        {searchOpen && ready && mindRef.current && <SearchBar mind={mindRef.current} editable={editable} onClose={() => { mindRef.current?.search?.endSearch(); setSearchOpen(false); }} />}
        {miniOpen && ready && mindRef.current && <MiniMapView mind={mindRef.current} tick={dataTick} />}
        <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-sm backdrop-blur" role="toolbar" aria-label="视图">
          {tool("缩小（Ctrl+-）", <Minus />, () => mindRef.current?.view.narrow())}
          <Tooltip content="恢复到 100%"><button type="button" className="h-8 min-w-12 rounded-lg px-1.5 text-xs tabular-nums hover:bg-muted" onClick={() => mindRef.current?.view.setScale(1)}>{Math.round(scale * 100)}%</button></Tooltip>
          {tool("放大（Ctrl+=）", <Plus />, () => mindRef.current?.view.enlarge())}
          {tool("适应画布（Ctrl+I）", <Expand />, () => mindRef.current?.view.fit())}
          {tool("回到中心主题", <Locate />, center)}
          {tool("小地图", <MapIcon />, () => setMiniOpen(v => !v), { active: miniOpen })}
          {tool(fullscreen ? "退出全屏" : "全屏", <Maximize />, () => void toggleFullscreen(), { active: fullscreen })}
          {tool("演示（← → 翻页，Esc 退出）", <Presentation />, present, { active: presenting })}
        </div>
        {editable && ready && !sel && <p className="pointer-events-none absolute bottom-4 left-3 hidden text-[11px] text-muted-foreground xl:block">
          点选节点后：Tab 加子节点 · Enter 加同级 · 双击改文字 · 右键看更多 · <button type="button" className="pointer-events-auto underline" onClick={() => setDialog("shortcuts")}>全部快捷键</button></p>}
      </div>
      {panel === "style" && editable && <StylePanel sel={sel} lineStyle={lineStyle} onClose={() => setPanel(null)} setStyles={setStyles} clearStyles={clearStyles}
        setLineStyle={v => { setLineStyle(v); setMapConfig({ lineStyle: v || undefined }); }}
        setMapConfig={setMapConfig} mapConfig={mindRef.current?.getCustomThemeConfig() ?? {}} />}
      {panel === "outline" && ready && <OutlinePanel editable={editable} title={title} tick={dataTick} getData={getData}
        apply={next => mindRef.current?.updateData(next.root)} onClose={() => setPanel(null)} />}
    </div>

    {noteTip && <div role="tooltip" className="pointer-events-none fixed z-[70] max-w-80 whitespace-pre-wrap break-words rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-5 text-foreground shadow-lg"
      style={{ left: Math.max(8, Math.min(noteTip.x, window.innerWidth - 340)), top: noteTip.y + 4 }}>{noteTip.text}</div>}

    {menuAt && <ContextMenuLayer x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)}>{menuAt.onNode && sel ? nodeMenu : canvasMenu}</ContextMenuLayer>}

    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addImage(f); }} />
    <input ref={importInput} type="file" accept={IMPORT_ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importReplace(f); }} />

    <NotePickerDialog open={picking} onOpenChange={setPicking} workspaceId={workspaceId}
      description={sel ? `给节点「${sel.text || "未命名"}」关联一篇笔记，点节点上的链接图标就能跳过去。` : undefined}
      onPick={note => {
        const nodes = active();
        if (!nodes.length) { toast.error("没有选中节点", "先点一下要关联的节点。"); return; }
        for (const n of nodes) exec("SET_NODE_HYPERLINK", n, noteLinkHref(note.id), (note.title || "未命名").replace(/[<>&"']/g, "").slice(0, 100));
        refreshSel();
        toast.success("已关联", `节点现在指向「${note.title || "未命名"}」`);
      }} />
    <NoteDialog open={dialog === "note"} initial={sel?.note ?? ""} onOpenChange={o => { if (!o) setDialog(null); }}
      onSave={text => { for (const n of active()) exec("SET_NODE_NOTE", n, text.trim() ? text : ""); refreshSel(); toast.success(text.trim() ? "备注已保存" : "备注已清空"); }} />
    <LinkDialog open={dialog === "link"} initial={sel?.hyperlink ?? ""} hasNoteLink={!!sel?.noteId} onOpenChange={o => { if (!o) setDialog(null); }}
      onSave={(url, label) => { for (const n of active()) exec("SET_NODE_HYPERLINK", n, url, label.replace(/[<>&"']/g, "")); refreshSel(); toast.success(url ? "链接已设置" : "链接已移除"); }} />
    <TagsDialog open={dialog === "tags"} initial={sel?.tags ?? []} onOpenChange={o => { if (!o) setDialog(null); }}
      onSave={tags => { for (const n of active()) exec("SET_NODE_TAG", n, tags); refreshSel(); }} />
    <IconsDialog open={dialog === "icons"} selected={sel?.icons ?? []} onOpenChange={o => { if (!o) setDialog(null); }}
      onToggle={icon => {
        const group = icon.split("_")[0];
        for (const n of active()) {
          const cur = (n.getData("icon") as string[] | undefined) ?? [];
          // 同一组（比如优先级）只留一个，和 XMind 的习惯一致。
          const next = cur.includes(icon) ? cur.filter(i => i !== icon) : [...cur.filter(i => i.split("_")[0] !== group), icon];
          exec("SET_NODE_ICON", n, next);
        }
        refreshSel();
      }} />
    <AiExpandDialog open={dialog === "ai"} mapId={mapId} onOpenChange={o => { if (!o) setDialog(null); }}
      getTarget={() => { const n = active()[0]; return n ? { path: pathOf(n), existing: n.children.map(c => String(c.getData("text") ?? "")) } : null; }}
      onInsert={items => {
        const n = active()[0];
        if (!n) { toast.error("选中的节点不见了", "重新选中后再试。"); return false; }
        handlers.current.onSourceHint?.("ai");
        exec("INSERT_MULTI_CHILD_NODE", [n], outlineToChildren(items));
        return true;
      }} />
    <Dialog open={dialog === "shortcuts"} onOpenChange={o => { if (!o) setDialog(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>快捷键</DialogTitle><DialogDescription>点一下画布或节点后生效。Mac 上 Ctrl 换成 ⌘。</DialogDescription></DialogHeader>
        <div className="grid max-h-[60vh] grid-cols-1 gap-x-6 overflow-y-auto text-sm sm:grid-cols-2">
          {MIND_MAP_SHORTCUTS.map(([k, v]) => <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5"><span className="text-muted-foreground">{v}</span><kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd></div>)}
        </div>
      </DialogContent>
    </Dialog>
  </div>;
});

// —— 子组件 ——

function ContextMenuLayer({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = box.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", down, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", down, true); };
  }, [x, y, onClose]);
  return <div ref={box} role="menu" aria-label="右键菜单" className="fixed z-[65] max-h-[80vh] w-52 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg" style={pos}
    onContextMenu={e => e.preventDefault()}>{children}</div>;
}

function SearchBar({ mind, editable, onClose }: { mind: MindMap; editable: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [replace, setReplace] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [info, setInfo] = useState({ currentIndex: -1, total: 0 });
  const [searched, setSearched] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    input.current?.focus();
    const on = (d: { currentIndex: number; total: number }) => setInfo(d);
    mind.on("search_info_change", on);
    return () => mind.off("search_info_change", on);
  }, [mind]);
  const go = () => { if (text.trim()) { mind.search?.search(text); setSearched(true); } };
  return <div className="absolute left-1/2 top-3 z-10 w-[min(94%,480px)] -translate-x-1/2 rounded-xl border border-border bg-background/95 p-2 shadow-md backdrop-blur" role="search"
    onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
    <div className="flex items-center gap-1.5">
      <Search className="ml-1 size-4 shrink-0 text-muted-foreground" />
      <Input ref={input} value={text} placeholder="搜索节点文字，回车找下一个" className="h-8" aria-label="搜索导图"
        onChange={e => { setText(e.target.value); setSearched(false); if (!e.target.value) { mind.search?.endSearch(); setInfo({ currentIndex: -1, total: 0 }); } }}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); go(); } }} />
      <span className="w-12 shrink-0 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">{info.total ? `${info.currentIndex + 1}/${info.total}` : searched ? "无结果" : ""}</span>
      <Button size="sm" variant="ghost" className="h-8 px-2" onClick={go}>下一个</Button>
      {editable && <Button size="sm" variant={showReplace ? "secondary" : "ghost"} className="h-8 px-2" onClick={() => setShowReplace(v => !v)}>替换</Button>}
      <Button size="icon" variant="ghost" className="size-8" aria-label="关闭搜索" onClick={onClose}><X /></Button>
    </div>
    {showReplace && editable && <div className="mt-1.5 flex items-center gap-1.5 pl-6">
      <Input value={replace} placeholder="替换为" className="h-8" aria-label="替换为" onChange={e => setReplace(e.target.value)} />
      <Button size="sm" variant="outline" className="h-8 shrink-0" disabled={!info.total} onClick={() => mind.search?.replace(replace, true)}>替换</Button>
      <Button size="sm" variant="outline" className="h-8 shrink-0" disabled={!info.total} onClick={() => mind.search?.replaceAll(replace)}>全部替换</Button>
    </div>}
  </div>;
}

function MiniMapView({ mind, tick }: { mind: MindMap; tick: number }) {
  const W = 220, H = 140;
  const [img, setImg] = useState("");
  const [box, setBox] = useState<Record<string, string>>({});
  const redraw = useCallback(() => {
    try {
      const r = mind.miniMap.calculationMiniMap(W, H);
      setBox(r.viewBoxStyle);
      r.getImgUrl((url: string) => setImg(url));
    } catch { /* 画布还没渲染完 */ }
  }, [mind]);
  useEffect(() => {
    const t = window.setTimeout(redraw, 120);
    return () => window.clearTimeout(t);
  }, [redraw, tick]);
  useEffect(() => {
    let t = 0;
    const on = () => { window.clearTimeout(t); t = window.setTimeout(redraw, 80); };
    const pos = (s: Record<string, string>) => setBox(s);
    mind.on("view_data_change", on);
    mind.on("node_tree_render_end", on);
    mind.on("mini_map_view_box_position_change", pos);
    const move = (e: MouseEvent) => { mind.miniMap.onMousemove(e); mind.miniMap.onViewBoxMousemove(e); };
    const up = () => mind.miniMap.onMouseup();
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.clearTimeout(t);
      mind.off("view_data_change", on); mind.off("node_tree_render_end", on); mind.off("mini_map_view_box_position_change", pos);
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
    };
  }, [mind, redraw]);
  return <div className="absolute bottom-16 right-3 z-10 cursor-grab overflow-hidden rounded-xl border border-border bg-background shadow-md" style={{ width: W, height: H }}
    onMouseDown={e => mind.miniMap.onMousedown(e.nativeEvent)} role="img" aria-label="小地图：拖动方框可以平移画布" data-testid="mind-map-minimap">
    {img && <img src={img} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />}
    <div className="absolute cursor-move rounded border-2 border-primary/70 bg-primary/5" style={box}
      onMouseDown={e => { e.stopPropagation(); mind.miniMap.onViewBoxMousedown(e.nativeEvent); }} />
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">{label}</span>{children}</label>;
}
const selectCls = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return <div className="grid gap-1 text-xs"><span className="font-medium text-muted-foreground">{label}</span>
    <div className="flex flex-wrap items-center gap-1">
      {SWATCHES.map(c => <button key={c} type="button" title={c} aria-label={`${label}：${c}`} onClick={() => onChange(c)}
        className={cn("size-5 rounded-md border border-border", value.toLowerCase() === c && "ring-2 ring-ring ring-offset-1 ring-offset-background")} style={{ background: c }} />)}
      <button type="button" title="透明" aria-label={`${label}：透明`} onClick={() => onChange("transparent")}
        className={cn("relative size-5 overflow-hidden rounded-md border border-border bg-background after:absolute after:left-1/2 after:top-[-2px] after:h-6 after:w-px after:rotate-45 after:bg-destructive", value === "transparent" && "ring-2 ring-ring")} />
      <input type="color" value={hex} aria-label={`${label}：自定义`} className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent" onChange={e => onChange(e.target.value)} />
    </div>
  </div>;
}

function StylePanel({ sel, onClose, setStyles, clearStyles, lineStyle, setLineStyle, setMapConfig, mapConfig }: {
  sel: Sel | null; onClose: () => void; setStyles: (s: Record<string, unknown>) => void; clearStyles: () => void;
  lineStyle: string; setLineStyle: (v: string) => void; setMapConfig: (p: Record<string, unknown>) => void; mapConfig: Record<string, unknown>;
}) {
  const s = sel?.style ?? {};
  const v = (k: string) => String(s[k] ?? "");
  const toggle = (k: string, on: string, off: string) => setStyles({ [k]: v(k) === on ? off : on });
  const pressed = (on: boolean) => on ? "secondary" as const : "ghost" as const;
  return <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-background" aria-label="样式面板">
    <div className="flex h-11 items-center justify-between border-b border-border px-3"><p className="text-sm font-semibold">样式</p><Button size="icon" variant="ghost" className="size-7" aria-label="关闭样式面板" onClick={onClose}><X /></Button></div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
      <section className="space-y-3">
        <p className="text-xs font-semibold">节点{sel && sel.count > 1 ? `（已选 ${sel.count} 个）` : ""}</p>
        {!sel ? <p className="text-xs leading-5 text-muted-foreground">先在画布上选中节点（Ctrl + 点击可多选），再在这里改颜色、字体和形状。</p> : <>
          <ColorField label="背景色" value={v("fillColor")} onChange={c => setStyles({ fillColor: c })} />
          <ColorField label="文字颜色" value={v("color")} onChange={c => setStyles({ color: c })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="字体"><select className={selectCls} value={FONTS.some(f => f.value === v("fontFamily")) ? v("fontFamily") : ""} onChange={e => setStyles({ fontFamily: e.target.value || undefined })}>{FONTS.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}</select></Field>
            <Field label="字号"><select className={selectCls} value={v("fontSize")} onChange={e => setStyles({ fontSize: Number(e.target.value) })}>{[12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
          </div>
          <div className="flex gap-1">
            <Button size="icon" variant={pressed(v("fontWeight") === "bold")} className="size-8" aria-label="加粗" aria-pressed={v("fontWeight") === "bold"} onClick={() => toggle("fontWeight", "bold", "normal")}><Bold /></Button>
            <Button size="icon" variant={pressed(v("fontStyle") === "italic")} className="size-8" aria-label="斜体" aria-pressed={v("fontStyle") === "italic"} onClick={() => toggle("fontStyle", "italic", "normal")}><Italic /></Button>
            <Button size="icon" variant={pressed(v("textDecoration") === "underline")} className="size-8" aria-label="下划线" onClick={() => toggle("textDecoration", "underline", "none")}><Underline /></Button>
            <Button size="icon" variant={pressed(v("textDecoration") === "line-through")} className="size-8" aria-label="删除线" onClick={() => toggle("textDecoration", "line-through", "none")}><Strikethrough /></Button>
          </div>
          <Field label="形状"><select className={selectCls} value={v("shape") || "rectangle"} onChange={e => setStyles({ shape: e.target.value })}>{SHAPES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
          <ColorField label="边框颜色" value={v("borderColor")} onChange={c => setStyles({ borderColor: c })} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="边框粗细"><select className={selectCls} value={v("borderWidth")} onChange={e => setStyles({ borderWidth: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="边框样式"><select className={selectCls} value={v("borderDasharray") || "none"} onChange={e => setStyles({ borderDasharray: e.target.value })}>{DASHES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
            <Field label="圆角"><select className={selectCls} value={v("borderRadius")} onChange={e => setStyles({ borderRadius: Number(e.target.value) })}>{[0, 4, 6, 8, 10, 14, 20].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
          </div>
          <ColorField label="连向子节点的线" value={v("lineColor")} onChange={c => setStyles({ lineColor: c })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="线粗细"><select className={selectCls} value={v("lineWidth")} onChange={e => setStyles({ lineWidth: Number(e.target.value) })}>{[1, 1.5, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="线样式"><select className={selectCls} value={v("lineDasharray") || "none"} onChange={e => setStyles({ lineDasharray: e.target.value })}>{DASHES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
          </div>
          <Button size="sm" variant="outline" className="w-full" onClick={clearStyles}><Paintbrush />清除选中节点的自定义样式</Button>
        </>}
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <p className="text-xs font-semibold">整张图</p>
        <Field label="连线风格"><select className={selectCls} value={lineStyle} onChange={e => setLineStyle(e.target.value)}>
          <option value="">跟随主题</option>{LINE_STYLES.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="连线粗细"><select className={selectCls} value={String(mapConfig.lineWidth ?? "")} onChange={e => setMapConfig({ lineWidth: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">跟随主题</option>{[1, 1.5, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
          <Field label="连线箭头"><select className={selectCls} value={mapConfig.showLineMarker ? "1" : ""} onChange={e => setMapConfig({ showLineMarker: e.target.value === "1" ? true : undefined })}>
            <option value="">不显示</option><option value="1">显示</option></select></Field>
        </div>
        <ColorField label="画布背景" value={String(mapConfig.backgroundColor ?? "")} onChange={c => setMapConfig({ backgroundColor: c })} />
        <Button size="sm" variant="ghost" className="w-full" onClick={() => { setLineStyle(""); setMapConfig({ backgroundColor: undefined, lineWidth: undefined, showLineMarker: undefined, lineStyle: undefined }); }}>整张图恢复主题默认</Button>
      </section>
    </div>
  </aside>;
}

function OutlinePanel({ editable, title, tick, getData, apply, onClose }: {
  editable: boolean; title: string; tick: number; getData: () => MindMapData | null; apply: (d: MindMapData) => void; onClose: () => void;
}) {
  const [text, setText] = useState(() => { const d = getData(); return d ? mindMapToOutline(d) : ""; });
  const editing = useRef(false);
  const timer = useRef<number | null>(null);
  const lastApplied = useRef(text);
  // 画布那边改了、而这边没在打字：刷新大纲。
  useEffect(() => {
    if (editing.current) return;
    const d = getData();
    if (!d) return;
    const md = mindMapToOutline(d);
    lastApplied.current = md;
    setText(md);
  }, [tick, getData]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const commit = (md: string) => {
    if (!editable || md === lastApplied.current) return;
    const base = getData();
    if (!base) return;
    try {
      const next = mindMapFromMarkdown(md, title, { base });
      lastApplied.current = md;
      apply(next);
    } catch { /* 输入到一半、结构不完整：等下一次 */ }
  };
  const onChange = (md: string) => {
    setText(md);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(md), 700);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || !editable) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: t, value } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const endAt = value.indexOf("\n", t);
    const lineEnd = endAt < 0 ? value.length : endAt;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const next = lines.map(l => l.startsWith("#") ? l : e.shiftKey ? l.replace(/^ {1,2}/, "") : `  ${l}`).join("\n");
    const md = value.slice(0, lineStart) + next + value.slice(lineEnd);
    const delta = next.length - block.length;
    onChange(md);
    requestAnimationFrame(() => {
      el.selectionStart = lines.length === 1 ? Math.max(lineStart, s + delta) : lineStart;
      el.selectionEnd = lines.length === 1 ? Math.max(lineStart, t + delta) : lineStart + next.length;
    });
  };
  return <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background" aria-label="大纲面板">
    <div className="flex h-11 items-center justify-between border-b border-border px-3">
      <p className="text-sm font-semibold">大纲</p>
      <Button size="icon" variant="ghost" className="size-7" aria-label="关闭大纲" onClick={onClose}><X /></Button>
    </div>
    <p className="border-b border-border px-3 py-2 text-[11px] leading-5 text-muted-foreground">{editable
      ? "第一行「# 」是中心主题，「- 」是分支，Tab 缩进一层、Shift + Tab 退回，「> 」写备注。停手一会儿就同步到导图，节点样式会保留。"
      : "只读：你没有这张图的编辑权限。"}</p>
    <Textarea value={text} readOnly={!editable} spellCheck={false} aria-label="大纲文本" data-testid="mind-map-outline"
      className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[13px] leading-6 focus-visible:ring-0"
      onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; if (timer.current) window.clearTimeout(timer.current); commit(text); }}
      onKeyDown={onKeyDown} onChange={e => onChange(e.target.value)} />
  </aside>;
}

function NoteDialog({ open, initial, onOpenChange, onSave }: { open: boolean; initial: string; onOpenChange: (o: boolean) => void; onSave: (t: string) => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => { if (open) setText(initial); }, [open, initial]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>节点备注</DialogTitle><DialogDescription>鼠标移到节点的备注图标上就能看到。清空后保存即删除备注。</DialogDescription></DialogHeader>
    <Textarea autoFocus rows={8} value={text} maxLength={20000} placeholder="写点补充说明…" onChange={e => setText(e.target.value)} />
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={() => { onSave(text); onOpenChange(false); }}>保存</Button></div>
  </DialogContent></Dialog>;
}

function LinkDialog({ open, initial, hasNoteLink, onOpenChange, onSave }: { open: boolean; initial: string; hasNoteLink: boolean; onOpenChange: (o: boolean) => void; onSave: (url: string, label: string) => void }) {
  const [url, setUrl] = useState(initial);
  const [label, setLabel] = useState("");
  const toast = useToast();
  useEffect(() => { if (open) { setUrl(initial); setLabel(""); } }, [open, initial]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>超链接</DialogTitle><DialogDescription>{hasNoteLink ? "这个节点现在关联着一篇笔记，设置网址会替换掉笔记关联。" : "点节点上的链接图标会在新标签页打开。清空后保存即移除链接。"}</DialogDescription></DialogHeader>
    <form className="grid gap-3" onSubmit={e => {
      e.preventDefault();
      const v = url.trim();
      if (v && !/^https?:\/\/\S+$/i.test(v)) { toast.error("网址格式不对", "要以 http:// 或 https:// 开头。"); return; }
      onSave(v, label.trim()); onOpenChange(false);
    }}>
      <Field label="网址"><Input autoFocus value={url} placeholder="https://" onChange={e => setUrl(e.target.value)} /></Field>
      <Field label="说明（可选，鼠标悬停时显示）"><Input value={label} maxLength={100} onChange={e => setLabel(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit">保存</Button></div>
    </form>
  </DialogContent></Dialog>;
}

function TagsDialog({ open, initial, onOpenChange, onSave }: { open: boolean; initial: string[]; onOpenChange: (o: boolean) => void; onSave: (t: string[]) => void }) {
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  useEffect(() => { if (open) { setTags(initial); setDraft(""); } }, [open, initial]);
  const add = () => { const t = draft.trim().slice(0, 40); if (t && !tags.includes(t) && tags.length < 10) setTags([...tags, t]); setDraft(""); };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>节点标签</DialogTitle><DialogDescription>最多 10 个，每个不超过 40 字，回车添加。</DialogDescription></DialogHeader>
    <div className="flex min-h-9 flex-wrap items-center gap-1.5">{tags.map(t => <span key={t} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">{t}
      <button type="button" aria-label={`移除标签 ${t}`} onClick={() => setTags(tags.filter(x => x !== t))}><X className="size-3" /></button></span>)}
      {!tags.length && <span className="text-xs text-muted-foreground">还没有标签</span>}</div>
    <div className="flex gap-2"><Input autoFocus value={draft} maxLength={40} placeholder="比如：重要、待确认" onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <Button variant="outline" onClick={add} disabled={!draft.trim() || tags.length >= 10}>添加</Button></div>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={() => { onSave(tags); onOpenChange(false); }}>保存</Button></div>
  </DialogContent></Dialog>;
}

function IconsDialog({ open, selected, onOpenChange, onToggle }: { open: boolean; selected: string[]; onOpenChange: (o: boolean) => void; onToggle: (icon: string) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>图标</DialogTitle><DialogDescription>点一下加上，再点一下去掉。同一组只保留一个。</DialogDescription></DialogHeader>
    <div className="max-h-[60vh] space-y-3 overflow-y-auto">{ICON_GROUPS.map(g => <div key={g.type}>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{ICON_GROUP_LABEL[g.type] ?? g.name}</p>
      <div className="flex flex-wrap gap-1.5">{g.list.map(i => {
        const id = `${g.type}_${i.name}`;
        const on = selected.includes(id);
        return <button key={id} type="button" aria-label={`${ICON_GROUP_LABEL[g.type] ?? g.name} ${i.name}`} aria-pressed={on} onClick={() => onToggle(id)}
          className={cn("grid size-9 place-items-center rounded-lg border border-transparent hover:bg-muted", on && "border-ring bg-muted")}>
          <img src={iconSrc(i.icon)} alt="" className="size-6" />
        </button>;
      })}</div>
    </div>)}</div>
  </DialogContent></Dialog>;
}

function AiExpandDialog({ open, mapId, onOpenChange, getTarget, onInsert }: {
  open: boolean; mapId: string; onOpenChange: (o: boolean) => void;
  getTarget: () => { path: string[]; existing: string[] } | null; onInsert: (items: OutlineNode[]) => boolean;
}) {
  const toast = useToast();
  const [count, setCount] = useState(5);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<OutlineNode[] | null>(null);
  const getTargetRef = useRef(getTarget);
  getTargetRef.current = getTarget;
  const target = useMemo(() => open ? getTargetRef.current() : null, [open]);
  useEffect(() => { if (open) { setItems(null); setInstruction(""); } }, [open]);
  const run = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const d = await api<{ items: OutlineNode[] }>(`/api/v1/mindmaps/${mapId}/ai/expand`, { method: "POST", body: JSON.stringify({
        path: target.path.slice(-60).map(t => t.slice(0, 500)), existing: target.existing.slice(0, 200).map(t => t.slice(0, 500)), count, instruction: instruction.trim() || undefined,
      }) });
      setItems(d.items);
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.error("AI 没能扩展", code === "AI_NOT_CONFIGURED" ? "还没有可用的 AI，可以在「AI 与自动化」里设置。" : (e as Error).message);
    } finally { setBusy(false); }
  };
  const list = (nodes: OutlineNode[], depth = 0): React.ReactNode => nodes.map((i, k) => <div key={`${depth}-${k}`} style={{ paddingLeft: depth * 14 }} className="text-sm leading-6">· {i.text}{i.children.length > 0 && list(i.children, depth + 1)}</div>);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>AI 扩展节点</DialogTitle><DialogDescription>{target ? `为「${target.path[target.path.length - 1] || "未命名"}」补充子节点。AI 会参考从中心主题到这里的路径和已有的子节点。` : "先选中一个节点。"}</DialogDescription></DialogHeader>
    <div className="grid gap-3">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label="额外要求（可选）"><Input value={instruction} maxLength={500} placeholder="比如：侧重风险、每条带一个例子" onChange={e => setInstruction(e.target.value)} /></Field>
        <Field label="数量"><select className={selectCls} value={count} onChange={e => setCount(Number(e.target.value))}>{[3, 5, 8, 12].map(n => <option key={n} value={n}>{n} 个左右</option>)}</select></Field>
      </div>
      {items && <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3" data-testid="ai-expand-preview">{list(items)}</div>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant={items ? "outline" : "default"} disabled={busy || !target} onClick={() => void run()}><Sparkles />{busy ? "AI 正在想…" : items ? "换一批" : "生成建议"}</Button>
        {items && <Button disabled={busy} onClick={() => { if (onInsert(items)) { toast.success("已插入", `新增 ${items.length} 个子节点，可以撤销。`); onOpenChange(false); } }}>插入到导图</Button>}
      </div>
    </div>
  </DialogContent></Dialog>;
}

/** 适应画布；容器不可见或实例已销毁时 svg.js 取不到尺寸会抛错，这种时候跳过就好。 */
function safeFit(mind: MindMap) {
  try { mind.view.fit(); } catch { /* 容器还没显示或已卸载 */ }
}

/** 只读预览（版本历史里用）：同一套渲染和主题，不带任何编辑能力。 */
export function MindMapPreview({ data }: { data: MindMapData }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    defineSiteTheme();
    let clean: MindMapData;
    try { clean = sanitizeMindMap(data); } catch { return; }
    const mind = new MindMap({
      el, data: clean.root, layout: clean.layout, theme: clean.theme.template, themeConfig: clean.theme.config,
      readonly: true, fit: false, isShowCreateChildBtnIcon: false, enableShortcutOnlyWhenMouseInSvg: true,
      customNoteContentShow: { show: () => undefined, hide: () => undefined }, customHyperlinkJump: () => undefined,
    });
    let alive = true;
    const ro = new ResizeObserver(() => { if (!alive) return; try { mind.resize(); } catch { /* 已销毁 */ } safeFit(mind); });
    ro.observe(el);
    const firstFit = () => { mind.off("node_tree_render_end", firstFit); window.setTimeout(() => { if (alive) safeFit(mind); }, 0); };
    mind.on("node_tree_render_end", firstFit);
    return () => { alive = false; ro.disconnect(); try { mind.destroy(); } catch { /* 已销毁 */ } };
  }, [data]);
  return <div ref={host} className="mind-map-host size-full" />;
}
