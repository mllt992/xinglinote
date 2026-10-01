import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(),'xingli-home-setup-'));
try {
 await mkdir(join(dir,'scripts')); await copyFile(new URL('./home-setup.sh',import.meta.url),join(dir,'scripts/home-setup.sh'));
 const run = arg => spawnSync('sh',[join(dir,'scripts/home-setup.sh'),arg],{encoding:'utf8',cwd:dir});
 assert.notEqual(run('https://bad.example/path').status,0);
 assert.equal(run('notes.example.com').status,0);
 const text=await readFile(join(dir,'.env.home'),'utf8');
 assert.match(text,/^APP_SECRET=[a-f0-9]{96}$/m); assert.match(text,/^POSTGRES_PASSWORD=[a-f0-9]{64}$/m);
 assert.match(text,/PUBLIC_URL=https:\/\/notes.example.com/); assert.equal((await stat(join(dir,'.env.home'))).mode&0o777,0o600);
 assert.notEqual(run('--local').status,0); assert.equal(await readFile(join(dir,'.env.home'),'utf8'),text);
 console.log('家用配置：域名校验、随机密钥、权限600、拒绝覆盖通过；未启动 Docker');
} finally { await rm(dir,{recursive:true,force:true}); }
