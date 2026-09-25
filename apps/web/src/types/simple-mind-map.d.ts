/**
 * simple-mind-map 没有自带类型（package.json 里的 types 目录没发布）。
 * 这里只声明我们实际用到的部分，其余保持宽松，免得类型挡路。
 */
declare module "simple-mind-map" {
  export type SmmNodeData = { text: string; uid: string; [key: string]: unknown };
  export type SmmTree = { data: SmmNodeData; children: SmmTree[] };
  export interface SmmNode {
    uid: string;
    isRoot: boolean;
    isGeneralization: boolean;
    layerIndex: number;
    parent: SmmNode | null;
    children: SmmNode[];
    nodeData: SmmTree;
    getData(key?: string): any;
    getStyle(prop: string, root?: boolean): any;
    active(): void;
    setText(text: string): void;
    setStyle(prop: string, value: unknown): void;
    setStyles(style: Record<string, unknown>): void;
  }
  export interface SmmRenderer {
    root: SmmNode | null;
    activeNodeList: SmmNode[];
    textEdit: { isShowTextEdit(): boolean; show(opts: { node: SmmNode }): void; hideEditTextBox(): void };
    findNodeByUid(uid: string): SmmNode | null;
    moveNodeToCenter(node: SmmNode, resetScale?: boolean): void;
    clearActiveNodeList(): void;
    expandToNodeUid(uid: string, cb?: () => void): void;
  }
  export interface SmmView {
    scale: number;
    fit(getRbox?: () => unknown, enlarge?: boolean, fitPadding?: number): void;
    reset(): void;
    enlarge(cx?: number, cy?: number, isTouchPad?: boolean): void;
    narrow(cx?: number, cy?: number, isTouchPad?: boolean): void;
    setScale(scale: number, cx?: number, cy?: number): void;
    getTransformData(): unknown;
  }
  export default class MindMap {
    constructor(opt: Record<string, unknown>);
    static usePlugin(plugin: unknown, opt?: unknown): typeof MindMap;
    static defineTheme(name: string, config: Record<string, unknown>): void;
    static removeTheme(name: string): void;
    el: HTMLElement;
    opt: Record<string, any>;
    renderer: SmmRenderer;
    view: SmmView;
    command: { history: string[]; activeHistoryIndex: number; clearHistory(): void };
    keyCommand: { addShortcut(key: string, fn: () => void): void; removeShortcut(key: string, fn?: () => void): void; pause(): void; recovery(): void };
    miniMap?: any;
    search?: any;
    demonstrate?: any;
    associativeLine?: any;
    outerFrame?: any;
    painter?: any;
    on(event: string, fn: (...args: any[]) => void): void;
    off(event: string, fn: (...args: any[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
    execCommand(name: string, ...args: unknown[]): void;
    getData(withConfig?: boolean): any;
    setData(data: unknown): void;
    setFullData(data: unknown): void;
    updateData(data: unknown): void;
    getLayout(): string;
    setLayout(layout: string, notRender?: boolean): void;
    getTheme(): string;
    setTheme(theme: string, notRender?: boolean): void;
    getCustomThemeConfig(): Record<string, unknown>;
    setThemeConfig(config: Record<string, unknown>, notRender?: boolean): void;
    getThemeConfig(prop?: string): any;
    updateConfig(opt: Record<string, unknown>): void;
    setMode(mode: "readonly" | "edit"): void;
    resize(): void;
    render(cb?: () => void, source?: string): void;
    reRender(cb?: () => void, source?: string): void;
    export(type: string, isDownload?: boolean, name?: string, ...args: unknown[]): Promise<any>;
    destroy(): void;
  }
}

declare module "simple-mind-map/src/plugins/*" {
  const plugin: any;
  export default plugin;
}

declare module "simple-mind-map/src/parse/xmind.js" {
  const xmind: { parseXmindFile(file: File | Blob): Promise<any> };
  export default xmind;
}
declare module "simple-mind-map/src/parse/markdown.js" {
  const markdown: { transformMarkdownTo(md: string): any; transformToMarkdown(root: any): string };
  export default markdown;
}

declare module "simple-mind-map/src/svg/icons.js" {
  const icons: { nodeIconList: Array<{ name: string; type: string; list: Array<{ name: string; icon: string }> }> };
  export default icons;
}

declare module "simple-mind-map-plugin-themes" {
  type Item = { name: string; value: string; theme: Record<string, unknown> };
  const Themes: { darkList: Item[]; lightList: Item[]; init(MindMap: unknown): void };
  export default Themes;
}
