import { statfs } from "node:fs/promises";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db } from "../db/client.ts";
import { aiProviders, backgroundJobs, backupRuns, backupTargets, instanceSettings, mcpTokens, notebooks, registrationCodes, workspaces } from "../db/schema.ts";
import { env } from "../env.ts";
import { open } from "./secrets.ts";
import { backupHealth, diskHealth, publicUrlHealth, secretHealth, workerHealth, type HealthItem } from "./instance-health-state.ts";
import { readWorkerHeartbeat } from "./worker-heartbeat.ts";

export async function instanceHealth(actorId: string) {
  const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  const targets = await db.select({ id: backupTargets.id, name: backupTargets.name, scope: backupTargets.scope, workspaceId: backupTargets.workspaceId }).from(backupTargets).where(eq(backupTargets.enabled, true));
  const targetIds = new Set(targets.map(t => t.id));
  const runs = targets.length ? await db.selectDistinctOn([backupRuns.targetId], { targetId: backupRuns.targetId, status: backupRuns.status, createdAt: backupRuns.createdAt, finishedAt: backupRuns.finishedAt }).from(backupRuns).where(inArray(backupRuns.targetId, [...targetIds])).orderBy(backupRuns.targetId, desc(backupRuns.createdAt)) : [];
  const jobs = targets.length ? await db.select({ payload: backgroundJobs.payload, status: backgroundJobs.status, finishedAt: backgroundJobs.finishedAt, createdAt: backgroundJobs.createdAt }).from(backgroundJobs).where(eq(backgroundJobs.type, "test_backup_target")).orderBy(desc(backgroundJobs.createdAt)).limit(100) : [];
  const backup = backupHealth(targets.map(target => {
    const run = runs.find(r => r.targetId === target.id);
    const test = jobs.find(j => String((j.payload as { targetId?: string }).targetId) === target.id);
    return { name: target.name, run: run ? { status: run.status, at: (run.finishedAt ?? run.createdAt).getTime() } : undefined, test: test ? { status: test.status, at: (test.finishedAt ?? test.createdAt).getTime() } : undefined };
  }));
  const checks = [publicUrlHealth(env.publicUrl), secretHealth(env.appSecret), { key: "smtp", label: "SMTP", status: settings?.smtpHost && settings.smtpPort && settings.smtpFrom ? "warning" : "error", detail: settings?.smtpHost && settings.smtpPort && settings.smtpFrom ? "配置完整，尚未在本页验证连接；点击测试不会发送邮件" : "未完整配置，邮箱验证与找回密码不可用" } as HealthItem, backup];
  try { const info = await statfs(env.dataDir); checks.push(diskHealth(info.blocks * info.bsize, info.bavail * info.bsize)); } catch { checks.push({ key: "disk", label: "数据磁盘", status: "error", detail: "无法读取 DATA_DIR 磁盘信息，请检查目录与权限" }); }
  checks.push(workerHealth(await readWorkerHeartbeat(env.dataDir)));
  const [{ value: codeCount }] = await db.select({ value: count() }).from(registrationCodes);
  const [{ value: notebookCount }] = await db.select({ value: count() }).from(notebooks).where(and(eq(notebooks.createdBy, actorId), isNull(notebooks.trashedAt)));
  const [{ value: providerCount }] = await db.select({ value: count() }).from(aiProviders);
  const [{ value: tokenCount }] = await db.select({ value: count() }).from(mcpTokens).where(eq(mcpTokens.userId, actorId));
  const [home] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.personalUserId, actorId));
  return { checkedAt: new Date().toISOString(), checks, onboarding: { instanceName: settings?.instanceName ?? "星璃笔记", hasCodes: codeCount > 0, hasNotebook: notebookCount > 0, hasBackup: targets.length > 0, hasAi: providerCount > 0, hasMcp: tokenCount > 0, homeWorkspaceId: home?.id ?? null } };
}
export async function testInstanceSmtp(): Promise<HealthItem> {
  const [s] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  if (!s?.smtpHost || !s.smtpPort || !s.smtpFrom) return { key: "smtp", label: "SMTP", status: "error", detail: "请先完整配置 SMTP" };
  const transport = nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpSecure, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ? open(s.smtpPassword) : "" } : undefined });
  try { await transport.verify(); return { key: "smtp", label: "SMTP", status: "ok", detail: "连接与认证测试通过，未发送邮件；实际投递还受发件域名配置影响", checkedAt: new Date().toISOString() }; }
  catch { return { key: "smtp", label: "SMTP", status: "error", detail: "连接或认证失败。检查服务器、端口、TLS 与账号；日志不向浏览器泄露凭据", checkedAt: new Date().toISOString() }; }
  finally { transport.close(); }
}
