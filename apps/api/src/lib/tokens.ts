import { createHash, randomBytes } from "node:crypto";

export function secureToken(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}
export function tokenHash(value: string) {
  return createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
}
export function registrationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let raw = "";
  for (let i = 0; i < 20; i++) raw += chars[bytes[i] % chars.length];
  return raw.match(/.{1,4}/g)!.join("-");
}
