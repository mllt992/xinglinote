export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (!json.ok) throw Object.assign(new Error(json.error.message), { code: json.error.code, fields: json.error.fields });
  return json.data;
}

export type Me = {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  instanceRole: string;
  appearance: "system" | "light" | "dark";
  themeId: string;
  accent: string | null;
  personalWorkspaceId: string | null;
  status?: string;
  deletionScheduledAt?: string | null;
  storage?: { usedBytes: number; quotaBytes: number; remainingBytes: number; noteBytes: number; attachmentBytes: number };
};
