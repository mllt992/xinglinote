/* 专用只读页：不加载应用、发 API 请求或选择其他账户。正文只用 textContent。 */
const prefix = "xingli.device.v1:";
const el = id => document.getElementById(id);
let activeId = null;
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(prefix + key)) ?? fallback; } catch { return fallback; } }
function render() {
  el("article").hidden = true; el("body").textContent = ""; el("list").replaceChildren();
  activeId = read("active", null)?.id;
  if (typeof activeId !== "string" || read(`consent:${activeId}`, false) !== true) { activeId = null; el("status").textContent = "没有可读取的离线内容。联网登录后，在「本机离线与草稿」开启可信设备，再打开需要的笔记或今天页。"; return; }
  const raw = read(`snapshots:${activeId}`, []);
  const now = Date.now();
  const rows = Array.isArray(raw) ? raw.filter(s => s && (s.kind === "note" || s.kind === "today") && typeof s.title === "string" && typeof s.text === "string" && s.savedAt > now - 7 * 86400000 && s.savedAt <= now + 60000).slice(0, 13) : [];
  if (Array.isArray(raw) && rows.length !== raw.length) { try { localStorage.setItem(prefix + `snapshots:${activeId}`, JSON.stringify(rows)); } catch { /* 仍拒绝读取过期内容 */ } }
  el("status").textContent = `${rows.length} 份快照 · 最长保留 7 天 · 仅当前已授权账号`;
  for (const row of rows) {
    const button = document.createElement("button"); button.textContent = `${row.kind === "today" ? "今天" : "笔记"} · ${row.title}`;
    button.onclick = () => { if (read("active", null)?.id !== activeId) return render(); el("title").textContent = row.title; el("body").textContent = row.text; el("time").textContent = `只读 · 缓存于 ${new Date(row.savedAt).toLocaleString()}`; el("article").hidden = false; };
    el("list").append(button);
  }
}
el("clear").onclick = () => { try { if (activeId) localStorage.removeItem(prefix + `snapshots:${activeId}`); } catch { el("status").textContent = "浏览器拒绝清理，请使用浏览器站点设置清除数据。"; return; } render(); };
window.addEventListener("storage", render); window.addEventListener("pageshow", render); render();
