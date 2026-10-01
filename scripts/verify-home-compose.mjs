// GitHub 临时 runner 专用：全新 Linux Compose 安装，loopback + 独立一次性卷，绝不启用 TLS。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
assert.equal(process.env.GITHUB_ACTIONS,'true','只允许在隔离 GitHub runner 运行，不能指向用户已有实例');
assert.equal(existsSync('.env.home'),false,'不覆盖已有家用配置');
const project=`xingli-smoke-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
assert.match(project,/^xingli-smoke-\d+-\d+$/);
const compose=['compose','--project-name',project,'--env-file','.env.home','-f','compose.home.yml'];
const run=(bin,args,timeout=420000)=>new Promise((resolve,reject)=>{
 const child=spawn(bin,args,{stdio:'inherit',env:{...process.env,BUILDKIT_PROGRESS:'plain'}});
 const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`${bin} ${args[0]} timed out`));},timeout);
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`${bin} ${args[0]} exited ${code}`));});
});
const base='http://127.0.0.1:12099';let configured=false;const start=Date.now();
try{
 await run('sh',['scripts/home-setup.sh','--local'],10000);configured=true;
 const config=await readFile('.env.home','utf8');const appSecret=/^APP_SECRET=(.+)$/m.exec(config)[1];
 await run('docker',[...compose,'config','--quiet'],10000);
 await run('docker',[...compose,'up','-d','--build'],540000);
 await run('docker',[...compose,'exec','-T','api','sh','-c','test ! -e /app/.env.home && test ! -e /app/home-backup'],10000);
 let ready=false;for(let i=0;i<90;i++){try{if((await fetch(base+'/api/healthz',{signal:AbortSignal.timeout(2000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}assert.ok(ready,'新安装 API 没有就绪');
 const register=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json','x-requested-with':'fetch'},body:JSON.stringify({email:'compose-smoke@example.invalid',handle:'composesmoke',displayName:'干净安装验收',password:'Fixture-'+randomBytes(20).toString('hex')})});
 const registration=await register.json();assert.equal(register.status,201,JSON.stringify(registration));assert.equal(registration.data.isFirst,true);assert.equal(registration.data.requiresVerification,false);
 const cookie=register.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
 const get=async path=>{const r=await fetch(base+'/api/v1'+path,{headers:{cookie,'x-requested-with':'fetch'}});const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j.data;};
 const me=await get('/me');assert.equal(me.instanceRole,'admin');assert.ok(me.personalWorkspaceId);
 const codeResponse=await fetch(base+'/api/v1/admin/registration-codes',{method:'POST',headers:{cookie,'content-type':'application/json','x-requested-with':'fetch'},body:JSON.stringify({quantity:1,maxUses:1,expiresInDays:1,note:'一次性 CI 验收'})});
 const codes=await codeResponse.json();assert.equal(codeResponse.status,201);assert.equal(codes.data.codes.length,1);
 let health;for(let i=0;i<20;i++){health=await get('/admin/health');if(health.checks.find(c=>c.key==='worker')?.status==='ok')break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(health.checks.find(c=>c.key==='worker')?.status,'ok');assert.equal(health.checks.find(c=>c.key==='secret')?.status,'ok');assert.equal(health.checks.find(c=>c.key==='backup')?.status,'error');assert.equal(JSON.stringify(health).includes(appSecret),false);
 const manifest=await (await fetch(base+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');assert.ok((await fetch(base+'/offline.html')).ok);
 console.log(JSON.stringify({cleanLinuxCompose:true,firstAdmin:true,registrationCodeCreated:true,personalWorkspace:true,workerHeartbeat:true,secretSafe:true,manifestAndOfflineShell:true,seconds:Math.round((Date.now()-start)/1000),nasHardwareTested:false},null,2));
}finally{
 if(configured){await run('docker',[...compose,'down','--volumes','--remove-orphans'],60000);await rm('.env.home',{force:true});}
}
