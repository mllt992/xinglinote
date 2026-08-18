import argon2 from "argon2";

export function validPassword(pw: string): boolean {
  return pw.length >= 10 && /[a-zA-Z]/.test(pw) && /\d/.test(pw);
}

export function hashPassword(pw: string) {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, pw: string) {
  return argon2.verify(hash, pw);
}
