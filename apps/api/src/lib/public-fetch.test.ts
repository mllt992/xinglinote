import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublicResourceUsing, isPublicFetchAddress, publicFetchUrl } from './public-fetch.ts';
const options={maxBytes:1000,timeoutMs:1000,accept:'text/html'};
test('剪藏网络仅允许标准无凭据 HTTP(S) 与公网单播地址',()=>{
 for(const value of ['file:///etc/passwd','https://user:password@example.com','http://example.com:8080'])assert.throws(()=>publicFetchUrl(value));
 for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','198.18.0.1','203.0.113.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::7f00:1','fc00::1','fe80::1','ff02::1','2002:7f00:1::1','2001:db8::1'])assert.equal(isPublicFetchAddress(ip),false,ip);
 assert.equal(isPublicFetchAddress('93.184.216.34'),true);assert.equal(isPublicFetchAddress('2606:4700:4700::1111'),true);
});
test('每跳全部 DNS 地址复核，传输固定到当次已验证 IP 且有字节上限',async()=>{
 let count=0;const addresses:string[]=[];
 const response=await fetchPublicResourceUsing('https://example.com/start',options,async()=>[{address:'93.184.216.34',family:4}],async(url,address)=>{
  addresses.push(address.address);return ++count===1?{status:302,location:'/end',contentType:'',body:Buffer.alloc(0),url:url.href}:{status:200,contentType:'text/html',body:Buffer.from('article'),url:url.href};
 });assert.equal(response.body.toString(),'article');assert.deepEqual(addresses,['93.184.216.34','93.184.216.34']);
 await assert.rejects(fetchPublicResourceUsing('https://example.com',options,async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],async()=>{throw Error('不能连接');}),/私有/);
 await assert.rejects(fetchPublicResourceUsing('https://example.com',options,async()=>[{address:'93.184.216.34',family:4}],async()=>({status:302,location:'http://127.0.0.1/',contentType:'',body:Buffer.alloc(0),url:''})),/私有/);
 await assert.rejects(fetchPublicResourceUsing('https://example.com',options,async()=>[{address:'93.184.216.34',family:4}],async()=>({status:200,contentType:'text/html',body:Buffer.alloc(1001),url:''})),/大小/);
});
