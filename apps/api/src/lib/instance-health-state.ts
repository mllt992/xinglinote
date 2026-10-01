export type HealthItem = { key: string; label: string; status: "ok" | "warning" | "error"; detail: string; checkedAt?: string | null };
export function publicUrlHealth(raw: string): HealthItem {
  const base: HealthItem = { key: "publicUrl", label: "PUBLIC_URL", status: "error", detail: "请设置完整的 HTTPS origin，例如 https://notes.example.com" };
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return base;
    return { ...base, status: url.protocol === "https:" ? "ok" : "warning", detail: url.protocol === "https:" ? `${url.origin} · 请确认与浏览器地址一致，DNS/TLS 可达性需在外网验证` : `${url.origin} · HTTP 缺少传输保护；非 localhost 无法安装离线应用` };
  } catch { return base; }
}
export function secretHealth(secret: string): HealthItem {
  const unsafe = secret === "dev-only-change-me" || secret.length < 32;
  return { key: "secret", label: "APP_SECRET", status: unsafe ? "error" : "ok", detail: unsafe ? "正在使用开发默认值或过短密钥，请生成至少 32 字符随机密钥；生产启动会拒绝此配置" : "已设置足够长度的密钥；请安全保存，不要随意更换" };
}
export function workerHealth(heartbeat: number | null, now = Date.now()): HealthItem {
  const good = heartbeat !== null && now - heartbeat < 90000 && heartbeat <= now + 30000;
  return { key: "worker", label: "后台 worker", status: good ? "ok" : "error", detail: good ? "90 秒内有心跳与数据库连接成功记录" : "没有新鲜心跳；检查 worker 日志、数据库连接及与 API 共用的 DATA_DIR", checkedAt: heartbeat && Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : null };
}
export function diskHealth(total: number, available: number): HealthItem {
  const low = available < 512 * 1024 * 1024 || available / total < 0.05;
  return { key: "disk", label: "数据磁盘", status: low ? "warning" : "ok", detail: `可用 ${(available / 1024 ** 3).toFixed(1)} GiB / 总计 ${(total / 1024 ** 3).toFixed(1)} GiB${low ? "，请及时释放空间" : ""}` };
}

export function backupHealth(targets: Array<{ name: string; run?: { status: string; at: number | null }; test?: { status: string; at: number | null } }>, now = Date.now()): HealthItem {
  if (!targets.length) return { key: "backup", label: "备份目标", status: "error", detail: "尚未启用备份目标。请配置异机 WebDAV/S3 并运行连接测试与恢复演练" };
  const states = targets.map(t => {
    const events = [t.run, t.test].filter((e): e is { status: string; at: number | null } => !!e).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const latest = events[0];
    const status = latest?.status === "failed" ? "error" : latest && ["done", "success"].includes(latest.status) && latest.at && latest.at > now - 7 * 86400000 && latest.at <= now + 30000 ? "ok" : "warning";
    return { status, at: latest?.at, detail: `${t.name}：备份 ${t.run?.status ?? "未运行"} / 连接测试 ${t.test?.status ?? "未测试"}` };
  });
  const last = Math.max(...states.map(s => s.at ?? 0));
  return { key: "backup", label: "备份目标", status: states.some(s => s.status === "error") ? "error" : states.every(s => s.status === "ok") ? "ok" : "warning", detail: `${states.map(s => s.detail).join("；")}。此为最近历史结果，超过 7 天需复查。配置快照不等于完整灾备；请另做数据库与正文数据卷备份。`, checkedAt: last ? new Date(last).toISOString() : null };
}
