import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env.ts";

const PREFIX = "enc:v1:";
const key = createHash("sha256").update(env.appSecret).digest();

/** 已经是密文就原样返回，方便调用方无脑 seal 一遍。 */
export function seal(value: string) {
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

/**
 * 解不开一律抛。以前解不开会让异常直接冒到 500——而最常见的「解不开」是
 * APP_SECRET 被换过，这时候需要一句人能看懂的话，而不是一堆 GCM 报错。
 */
export function open(value: string) {
  if (!value.startsWith(PREFIX)) return value;
  const [, , iv, tag, data] = value.split(":");
  if (!iv || !tag || !data) throw new Error("密文格式不对");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("密文解不开：APP_SECRET 是不是换过了？");
  }
}

export function suffix(value: string) {
  return open(value).slice(-4);
}
