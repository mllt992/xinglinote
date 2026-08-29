export type HelpMeta = {
  helpSource?: "builtin" | "external";
  helpUrl?: string | null;
};

export type HelpTarget = { href: string; external: boolean };

/** 服务端会校验一次，客户端仍只放行 http(s)，避免旧数据或手工改库变成危险链接。 */
export function resolveHelpTarget(meta: HelpMeta): HelpTarget {
  if (meta.helpSource !== "external" || !meta.helpUrl) return { href: "/help", external: false };
  try {
    const url = new URL(meta.helpUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return { href: url.href, external: true };
  } catch {
    // 配置异常时始终保留可用的内置帮助入口。
  }
  return { href: "/help", external: false };
}
