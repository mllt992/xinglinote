import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import postgres from 'postgres';

// 独立的全新数据库，不能在已有用户库上测试首次管理员或删表。
test('空实例并发注册只有一个首位管理员，后续开放注册不提升权限',{skip:!process.env.KB_TEST_DATABASE_URL},async()=>{
 assert.equal(process.env.DATABASE_URL,process.env.KB_TEST_DATABASE_URL);assert.ok(new URL(process.env.KB_TEST_DATABASE_URL!).pathname.endsWith('_test'));
 const admin=postgres(process.env.KB_TEST_DATABASE_URL!,{max:1}),name=`register_${randomUUID().replaceAll('-','')}_test`;
 const url=new URL(process.env.KB_TEST_DATABASE_URL!);url.pathname='/'+name;
 let client:ReturnType<typeof postgres>|undefined,opened=false;
 try{
  await admin.unsafe(`CREATE DATABASE ${name}`);opened=true;
  execFileSync(process.execPath,['--import','tsx','src/db/push.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url.href},stdio:'pipe',timeout:60000});
  process.env.DATABASE_URL=url.href;
  const {auth}=await import('../routes/auth.ts');const {Hono}=await import('hono');const {onError}=await import('../http.ts');const {sql}=await import('../db/client.ts');client=sql;
  const app=new Hono();app.onError(onError);app.route('/api/v1',auth);
  const register=(n:number)=>app.request('http://local/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`first-${n}@example.invalid`,handle:`first${n}`,displayName:`测试${n}`,password:'Synthetic-password-123'})});
  const first=await Promise.all([register(1),register(2)]);assert.equal(first.filter(r=>r.status===201).length,1);assert.equal(first.filter(r=>r.status===403).length,1);
  const admins=await sql`select id from users where role_instance='admin'`;assert.equal(admins.length,1);
  await sql`update instance_settings set allow_open_registration=true`;
  const later=await Promise.all([register(3),register(4)]);assert.ok(later.every(r=>r.status===201));
  for(const response of later){const body=await response.json() as {data:{isFirst:boolean}};assert.equal(body.data.isFirst,false);}
  assert.equal((await sql`select id from users where role_instance='admin'`).length,1);
  assert.equal((await sql`select id from workspaces where kind='personal'`).length,3);
 }finally{
  await client?.end();if(opened)await admin.unsafe(`DROP DATABASE ${name}`);await admin.end();
 }
});
