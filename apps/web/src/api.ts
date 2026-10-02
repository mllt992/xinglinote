import { captureDeviceResponse, deviceStorage } from "./lib/device-storage";
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/api/v1/auth/logout") deviceStorage.logout();
  const user = deviceStorage.identity(), epoch = deviceStorage.epoch();
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "fetch",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json()) as ApiOk<T> | ApiErr;
  if (!json.ok) {
    if (epoch === deviceStorage.epoch()) {
      if (json.error.code === "UNAUTHENTICATED") deviceStorage.logout();
      const note = /^\/api\/v1\/notes\/([^/?]+)$/.exec(path);
      if (note && ["FORBIDDEN", "NOT_FOUND", "GONE_TRASHED"].includes(json.error.code)) deviceStorage.forgetSnapshot(note[1]!);
      const today = /^\/api\/v1\/workspaces\/([^/?]+)\/today$/.exec(path);
      if (today && ["FORBIDDEN", "NOT_FOUND"].includes(json.error.code)) deviceStorage.forgetSnapshot(today[1]!);
    }
    throw Object.assign(new Error(json.error.message), { code: json.error.code, fields: json.error.fields });
  }
  captureDeviceResponse(path, json.data, method, user, epoch);
  return json.data;
}

/** 读取逐行 JSON；TextDecoder 会保住落在网络 chunk 边界上的半个中文字符。 */
export async function readJsonLines<T>(body: ReadableStream<Uint8Array>, onLine: (value: T) => void | Promise<void>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await onLine(JSON.parse(line) as T);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) await onLine(JSON.parse(buffer) as T);
}

export async function apiJsonLines<T>(path: string, init: RequestInit, onLine: (value: T) => void | Promise<void>) {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const json = await res.json() as ApiErr;
    throw Object.assign(new Error(json.error?.message ?? "请求失败"), { code: json.error?.code, fields: json.error?.fields });
  }
  if (!res.body) throw new Error("服务器没有返回响应流");
  await readJsonLines(res.body, onLine);
}

export type Me = {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  instanceRole: string;
  appearance: "system" | "light" | "dark";
  themeId: string;
  accent: string | null;
  personalWorkspaceId: string | null;
  status?: string;
  deletionScheduledAt?: string | null;
  storage?: { usedBytes: number; quotaBytes: number; remainingBytes: number; noteBytes: number; attachmentBytes: number };
};
