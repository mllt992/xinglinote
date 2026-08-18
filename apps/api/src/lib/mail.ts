import nodemailer from "nodemailer";
import { db } from "../db/client.ts";
import { instanceSettings } from "../db/schema.ts";
import { open } from "./secrets.ts";

export async function sendMail(to: string, subject: string, text: string) {
  const [s] = await db.select().from(instanceSettings);
  if (!s?.smtpHost || !s.smtpPort || !s.smtpFrom) return { sent: false as const, reason: "SMTP_NOT_CONFIGURED" };
  const transport = nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpSecure, auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ? open(s.smtpPassword) : "" } : undefined });
  await transport.sendMail({ from: s.smtpFrom, to, subject, text });
  return { sent: true as const };
}
