import { lookup } from "node:dns/promises";
import { fail } from "@kb/shared";
import { isPrivateAddress } from "./client-ip.ts";

/**
 * 出站地址护栏（SSRF）。
 *
 * AI 提供商、审核模型、备份目标这三处的 URL 都是用户或工作区管理员填的，
 * 填完由服务端去 fetch。不挡的话，一个普通成员就能让服务端去敲
 * `http://169.254.169.254/`（云厂商元数据）或者内网任意端口，
 * 再从状态码和响应体里把结果读回来。
 *
 * 内网部署确实需要连私网地址，所以留一个显式开关，而不是写死禁止。
 */
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_OUTBOUND_ENDPOINTS === "true"
  // 备份目标原来用的是这个名字，保持兼容
  || process.env.ALLOW_PRIVATE_BACKUP_ENDPOINTS === "true";

export function privateOutboundAllowed() {
  return ALLOW_PRIVATE;
}

/**
 * 解析并校验一个出站 URL。不合格就抛 VALIDATION。
 *
 * 注意这挡不住 DNS rebinding（校验完到真正 fetch 之间域名可以改指向），
 * 所以保存配置时和每次真正发请求前都会调一遍，把窗口压到最小。
 * 要彻底堵死得给 fetch 挂自定义 agent 按已解析的 IP 连，代价太大，暂不做。
 */
export async function assertSafeOutboundUrl(raw: string, what = "地址"): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("VALIDATION", `${what}不是合法的 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("VALIDATION", `${what}只支持 http/https`);
  }
  if (ALLOW_PRIVATE) return url;

  const host = url.hostname;
  if (isPrivateAddress(host)) {
    throw fail("VALIDATION", `${what}指向内网或环回地址；内网部署请设置 ALLOW_PRIVATE_OUTBOUND_ENDPOINTS=true`);
  }
  // 字面量 IP 上面已经判完了；域名要看它解析到哪去
  if (!/^[\d.]+$/.test(host) && !host.includes(":")) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw fail("VALIDATION", `${what}的域名解析不了：${host}`);
    }
    if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
      throw fail("VALIDATION", `${what}解析到内网地址；内网部署请设置 ALLOW_PRIVATE_OUTBOUND_ENDPOINTS=true`);
    }
  }
  return url;
}

/** 出站请求的统一超时。吊住不返回的第三方能把请求和 worker 任务一起占死。 */
export const OUTBOUND_TIMEOUT_MS = 30_000;

export type OutboundFailureKind = "timeout" | "dns" | "tls" | "refused" | "reset" | "network";

const KIND_HINT: Record<OutboundFailureKind, string> = {
  timeout: "连接超时",
  dns: "域名解析失败",
  tls: "TLS 握手失败",
  refused: "连接被拒绝",
  reset: "连接被中断",
  network: "网络请求失败",
};

/** Node/undici 的 TypeError("fetch failed") 把真正原因藏在 cause 链里，客户端只能看见这三个字。 */
function errorChain(err: unknown): Array<{ name: string; message: string; code: string }> {
  const out: Array<{ name: string; message: string; code: string }> = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur) && out.length < 8) {
    seen.add(cur);
    if (cur instanceof Error) {
      const withCode = cur as Error & { code?: unknown };
      const code = typeof withCode.code === "string" ? withCode.code : "";
      out.push({ name: cur.name, message: cur.message, code });
      const nested = (cur as { errors?: unknown }).errors;
      if (Array.isArray(nested) && nested[0] && !cur.cause) {
        cur = nested[0];
        continue;
      }
      cur = cur.cause;
    } else if (typeof cur === "object" && cur && "message" in cur) {
      out.push({ name: "", message: String((cur as { message: unknown }).message), code: "" });
      break;
    } else {
      out.push({ name: "", message: String(cur), code: "" });
      break;
    }
  }
  return out;
}

export function classifyOutboundFailure(err: unknown): { kind: OutboundFailureKind; message: string } {
  const chain = errorChain(err);
  const codes = chain.map(x => x.code).join(" ");
  const names = chain.map(x => x.name).join(" ");
  const blob = chain.map(x => `${x.name} ${x.message} ${x.code}`).join("\n");
  let kind: OutboundFailureKind = "network";
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(codes) || /getaddrinfo/i.test(blob)) kind = "dns";
  else if (/ECONNREFUSED/i.test(codes)) kind = "refused";
  else if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED/i.test(codes) || /socket hang up/i.test(blob)) kind = "reset";
  else if (/CERT_|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/i.test(codes) || /certificate|self[- ]signed/i.test(blob)) kind = "tls";
  else if (/ETIMEDOUT|UND_ERR_(CONNECT_|HEADERS_|BODY_)?TIMEOUT/i.test(codes) || /TimeoutError|AbortError/i.test(names) || /timeout|aborted/i.test(blob)) kind = "timeout";
  return { kind, message: KIND_HINT[kind] };
}

export class OutboundFetchError extends Error {
  readonly kind: OutboundFailureKind;
  constructor(kind: OutboundFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutboundFetchError";
    this.kind = kind;
  }
}

/** 校验 + 超时一把抓的 fetch。所有打第三方的地方都走它。 */
export async function safeFetch(url: string, init: RequestInit = {}, what = "地址") {
  await assertSafeOutboundUrl(url, what);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
  } catch (e) {
    const { kind, message } = classifyOutboundFailure(e);
    throw new OutboundFetchError(kind, `${what}：${message}`, { cause: e });
  }
}
