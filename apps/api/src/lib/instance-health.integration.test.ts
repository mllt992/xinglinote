import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("真实数据库：健康检查仅管理员可读、持久化实例名、不泄露密钥", { skip: !process.env.KB_TEST_DATABASE_URL }, async () => {
  assert.equal(process.env.DATABASE_URL, process.env.KB_TEST_DATABASE_URL);
  assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith("_test"));
  const { db, sql } = await import("../db/client.ts");
  const { users, sessions, instanceSettings } = await import("../db/schema.ts");
  const { eq, inArray } = await import("drizzle-orm");
  const { adminRoutes } = await import("../routes/admin.ts");
  const { Hono } = await import("hono");
  const { onError } = await import("../http.ts");
  const { ZodError } = await import("zod");
  const { fail } = await import("@kb/shared");
  const { hashToken } = await import("./session.ts");
  const ids = [randomUUID(), randomUUID()], tokens = [randomUUID(), randomUUID()];
  const [original] = await db.select({ instanceName: instanceSettings.instanceName }).from(instanceSettings).where(eq(instanceSettings.id, 1));
  const app = new Hono().route("/api/v1", adminRoutes); app.onError((e,c)=>onError(e instanceof ZodError?fail("VALIDATION",e.issues[0]?.message??"参数错误"):e,c));
  try {
    await db.insert(users).values(ids.map((id, i) => ({ id, email: `health-${id}@example.invalid`, handle: `h${id.replaceAll("-", "").slice(0,20)}`, displayName: "健康检查测试", passwordHash: "not-a-login", roleInstance: i === 0 ? "admin" : "user" })));
    await db.insert(sessions).values(ids.map((userId, i) => ({ userId, tokenHash: hashToken(tokens[i]!), expiresAt: new Date(Date.now() + 3600000) })));
    const get = (token?: string) => app.request("/api/v1/admin/health", { headers: token ? { cookie: `kb_session=${token}` } : {} });
    assert.equal((await get()).status, 401); assert.equal((await get(tokens[1])).status, 403);
    const response = await get(tokens[0]); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
    const result = await response.json() as { data: { checks: Array<{ key: string }>; onboarding: { instanceName: string } } }; assert.deepEqual(result.data.checks.map((x: { key: string }) => x.key).sort(), ["backup", "disk", "publicUrl", "secret", "smtp", "worker"]);
    assert.equal(JSON.stringify(result).includes("dev-only-change-me"), false); assert.equal(JSON.stringify(result).includes("smtpPassword"), false);
    const patch = await app.request("/api/v1/admin/settings", { method: "PATCH", headers: { cookie: `kb_session=${tokens[0]}`, "content-type": "application/json" }, body: JSON.stringify({ instanceName: "家里的星璃" }) }); assert.equal(patch.status, 200);
    const renamed = await (await get(tokens[0])).json() as { data: { onboarding: { instanceName: string } } };
    assert.equal(renamed.data.onboarding.instanceName, "家里的星璃");
    const bad = await app.request("/api/v1/admin/settings", { method: "PATCH", headers: { cookie: `kb_session=${tokens[0]}`, "content-type": "application/json" }, body: JSON.stringify({ instanceName: " " }) }); assert.equal(bad.status, 422);
  } finally {
    if (original) await db.update(instanceSettings).set(original).where(eq(instanceSettings.id, 1));
    await db.delete(sessions).where(inArray(sessions.userId, ids)); await db.delete(users).where(inArray(users.id, ids)); await sql.end();
  }
});
