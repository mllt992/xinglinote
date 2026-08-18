export * from "./errors.js";
export * from "./theme.js";

export const HANDLE_RE = /^[a-z][a-z0-9_]{2,31}$/;

export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
