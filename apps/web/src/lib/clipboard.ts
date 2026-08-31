/**
 * 剪贴板写入的兼容层。
 *
 * 自托管实例不一定运行在 HTTPS 下，此时现代 Clipboard API 可能不存在或拒绝写入；
 * 两种复制都保留 execCommand 降级，至少让普通 HTTP 部署仍然可用。
 */

function legacyCopyText(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(area);
  area.select();
  try { return document.execCommand("copy"); }
  finally { area.remove(); }
}

function legacyCopyHtml(html: string): boolean {
  const host = document.createElement("div");
  host.contentEditable = "true";
  host.style.cssText = "position:fixed;left:-9999px;top:0";
  host.innerHTML = html;
  document.body.append(host);

  const selection = window.getSelection();
  const saved = selection ? [...Array(selection.rangeCount)].map((_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const range = document.createRange();
  range.selectNodeContents(host);
  selection?.removeAllRanges();
  selection?.addRange(range);
  try { return document.execCommand("copy"); }
  finally {
    host.remove();
    selection?.removeAllRanges();
    for (const old of saved) selection?.addRange(old);
  }
}

export async function copyPlainText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try { return legacyCopyText(text); }
    catch { return false; }
  }
}

function plainTextFromHtml(html: string): string {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-9999px;top:0";
  host.innerHTML = html;
  document.body.append(host);
  try { return host.innerText; }
  finally { host.remove(); }
}

/** 同时写 HTML 和纯文本，让 Word/邮件拿到格式，纯文本输入框仍能正常粘贴。 */
export async function copyRichText(html: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard.write) throw new Error("rich clipboard unavailable");
    const plainText = plainTextFromHtml(html);
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    try { return legacyCopyHtml(html); }
    catch { return false; }
  }
}
