import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env.ts";
const key=createHash("sha256").update(env.appSecret).digest();
export function seal(value:string){if(value.startsWith("enc:v1:"))return value;const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;}
export function open(value:string){if(!value.startsWith("enc:v1:"))return value;const[, , iv,tag,data]=value.split(":");const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));decipher.setAuthTag(Buffer.from(tag,"base64url"));return Buffer.concat([decipher.update(Buffer.from(data,"base64url")),decipher.final()]).toString("utf8");}
export function suffix(value:string){const plain=open(value);return plain.slice(-4);}
