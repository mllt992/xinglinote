import nodemailer from "nodemailer";
import { db } from "../db/client.ts";
import { instanceSettings } from "../db/schema.ts";
import { open } from "./secrets.ts";

export type MailResult = { sent: true } | { sent: false; reason: string };

/**
 * 发信永远不抛。
 *
 * 调用点（注册、找回密码、日历提醒）都不该因为 SMTP 挂了就整个请求 500：
 * 注册那边用户行已经插进去了，500 会让人以为没注册成功；
 * 找回密码那边更糟——「邮箱不存在回 200、邮箱存在但发信失败回 500」，
 * 刻意做的防用户枚举就这么漏了回去。
 */
export async function sendMail(to: string, subject: string, text: string): Promise<MailResult> {
  const [s] = await db.select().from(instanceSettings);
  if (!s?.smtpHost || !s.smtpPort || !s.smtpFrom) return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
  try {
    const transport = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecure,
      auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ? open(s.smtpPassword) : "" } : undefined,
    });
    await transport.sendMail({ from: s.smtpFrom, to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error("发信失败:", (e as Error).message);
    return { sent: false, reason: "SMTP_ERROR" };
  }
}
