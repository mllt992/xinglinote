import type { MarkdownIt, StateBlock, StateCore, StateInline } from "markdown-it";

/**
 * 脚注：`正文[^1]` + 另起一行的 `[^1]: 注释`。
 *
 * **支持的是一个子集**，够写作用，不追求跟某个实现逐字一致（规格 §9.2 注明）：
 *
 * - 定义写成一行；要续行就下一行起缩进 4 个空格，空行结束。
 * - 定义内容按**行内**解析——里面可以有 `**粗体**`、链接、`[[双链]]`，但放不下列表和代码块。
 * - 编号按**首次引用**的顺序排，没被引用到的定义不输出。
 * - 引用了但没定义的，原样留成 `[^x]` 文本，不吃掉也不报错。
 */
type Definition = { content: string; line: number };
type FootnoteEnv = {
  defs: Map<string, Definition>;
  /** label → 编号，从 1 起，按首次引用的顺序发。 */
  order: Map<string, number>;
  /** label → 这条被引用了几次，用来给每个引用点分配唯一 id。 */
  hits: Map<string, number>;
};

function envOf(env: unknown): FootnoteEnv {
  const holder = (env ?? {}) as { footnotes?: FootnoteEnv };
  holder.footnotes ??= { defs: new Map(), order: new Map(), hits: new Map() };
  return holder.footnotes;
}

const LABEL = /^\[\^([^\]\s]+)\]:/;

/** `[^label]: …` 定义行。只往 env 里记，不产生 token——正文里不该出现它。 */
function definition(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const from = state.bMarks[startLine] + state.tShift[startLine];
  const to = state.eMarks[startLine];
  const hit = LABEL.exec(state.src.slice(from, to));
  if (!hit) return false;
  if (silent) return true;

  const chunks = [state.src.slice(from + hit[0].length, to).trim()];
  let line = startLine;
  // 续行：下一行起缩进 4 个空格；空行就到此为止
  while (line + 1 < endLine) {
    const next = line + 1;
    if (state.isEmpty(next)) break;
    if (state.sCount[next] - state.blkIndent < 4) break;
    chunks.push(state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]).trim());
    line = next;
  }

  const footnotes = envOf(state.env);
  // 同名定义以第一条为准，和链接引用定义的老规矩一致
  if (!footnotes.defs.has(hit[1])) footnotes.defs.set(hit[1], { content: chunks.join("\n").trim(), line: startLine });
  state.line = line + 1;
  return true;
}

/** `[^label]` 引用。没有对应定义就当普通文字放过去。 */
function reference(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5e /* ^ */) return false;
  const close = src.indexOf("]", start + 2);
  if (close < 0 || close > state.posMax) return false;
  const label = src.slice(start + 2, close);
  if (!label || /[\s\]]/.test(label)) return false;
  // `[^1]:` 是定义不是引用（定义行本该被块规则吃掉，这里兜一下嵌套场景）
  if (src.charCodeAt(close + 1) === 0x3a /* : */) return false;

  const footnotes = envOf(state.env);
  if (!footnotes.defs.has(label)) return false;
  if (!silent) {
    const index = footnotes.order.get(label) ?? footnotes.order.size + 1;
    footnotes.order.set(label, index);
    const seq = (footnotes.hits.get(label) ?? 0) + 1;
    footnotes.hits.set(label, seq);
    const token = state.push("footnote_ref", "", 0);
    token.meta = { index, seq };
  }
  state.pos = close + 1;
  return true;
}

/** 把脚注区拼在文末。定义内容在这里才做行内解析——那时块与行内两轮都已经跑完了。 */
function collect(state: StateCore): boolean {
  const footnotes = envOf(state.env);
  if (!footnotes.order.size) return true;
  const md = state.md;

  const open = new state.Token("footnote_block_open", "", 1);
  const close = new state.Token("footnote_block_close", "", -1);
  const items: InstanceType<typeof state.Token>[] = [];

  for (const [label, index] of [...footnotes.order.entries()].sort((a, b) => a[1] - b[1])) {
    const def = footnotes.defs.get(label);
    if (!def) continue;
    const item = new state.Token("footnote_open", "", 1);
    item.meta = { index, uses: footnotes.hits.get(label) ?? 1 };
    const inline = new state.Token("inline", "", 0);
    inline.content = def.content;
    inline.children = [];
    inline.map = [def.line, def.line + 1];
    md.inline.parse(def.content, md, state.env, inline.children);
    const itemClose = new state.Token("footnote_close", "", -1);
    itemClose.meta = item.meta;
    items.push(item, inline, itemClose);
  }
  if (!items.length) return true;
  state.tokens.push(open, ...items, close);
  return true;
}

export function footnotePlugin(md: MarkdownIt) {
  md.block.ruler.before("reference", "footnote_def", definition, { alt: ["paragraph", "reference"] });
  md.inline.ruler.after("image", "footnote_ref", reference);
  md.core.ruler.push("footnote_tail", collect);

  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const { index, seq } = tokens[idx].meta as { index: number; seq: number };
    return `<sup class="footnote-ref"><a id="fnref-${index}-${seq}" href="#fn-${index}">[${index}]</a></sup>`;
  };
  md.renderer.rules.footnote_block_open = () =>
    `<section class="footnotes"><hr class="footnotes-sep">\n<ol class="footnotes-list">\n`;
  md.renderer.rules.footnote_block_close = () => `</ol>\n</section>\n`;
  md.renderer.rules.footnote_open = (tokens, idx) =>
    `<li id="fn-${(tokens[idx].meta as { index: number }).index}" class="footnote-item"><p>`;
  md.renderer.rules.footnote_close = (tokens, idx) => {
    const { index, uses } = tokens[idx].meta as { index: number; uses: number };
    // 每一处引用给一个回跳箭头，读到脚注能原路返回
    const backs = Array.from({ length: uses }, (_, i) =>
      `<a href="#fnref-${index}-${i + 1}" class="footnote-backref" aria-label="回到正文">↩</a>`).join("");
    return `${backs}</p></li>\n`;
  };
}
