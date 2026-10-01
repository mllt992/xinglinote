import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fail } from '@kb/shared';

const deniedV4 = new BlockList(), globalV6 = new BlockList(), deniedV6 = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) deniedV4.addSubnet(ip,prefix,'ipv4');
globalV6.addSubnet('2000::',3,'ipv6');
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16]] as const) deniedV6.addSubnet(ip,prefix,'ipv6');
export function isPublicFetchAddress(address: string) {
 const family=isIP(address);
 return family===4?!deniedV4.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!deniedV6.check(address,'ipv6');
}
export function publicFetchUrl(raw: string) {
 let url:URL;try{url=new URL(raw);}catch{throw fail('VALIDATION','来源链接格式不正确');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw fail('VALIDATION','来源只允许无凭据的标准 HTTP(S) 地址');
 if(url.href.length>4096)throw fail('VALIDATION','来源链接过长');
 url.hash='';return url;
}
type Address={address:string;family:number};
type Response={status:number;location?:string;contentType:string;body:Buffer;url:string};
type Options={maxBytes:number;timeoutMs:number;accept:string};
type Transport=(url:URL,address:Address,options:Options,signal:AbortSignal)=>Promise<Response>;

const requestPinned:Transport=(url,address,options,signal)=>new Promise((resolve,reject)=>{
 const request=url.protocol==='https:'?httpsRequest:httpRequest;
 const req=request(url,{method:'GET',signal,agent:false,family:address.family,
  lookup:(_host,_options,callback)=>callback(null,address.address,address.family),
  headers:{accept:options.accept,'accept-encoding':'identity','user-agent':'XingliNote-Clipper/1.0'},
 },res=>{
  const status=res.statusCode??0;
  if(status!==200){res.destroy();resolve({status,location:res.headers.location,contentType:String(res.headers['content-type']??''),body:Buffer.alloc(0),url:url.href});return;}
  if(res.headers['content-encoding']&&!['identity'].includes(String(res.headers['content-encoding']).toLowerCase())){res.destroy();reject(fail('VALIDATION','来源忽略了无压缩请求，请使用浏览器剪藏或只存链接'));return;}
  if(Number(res.headers['content-length']??0)>options.maxBytes){res.destroy();reject(fail('QUOTA','来源内容超过剪藏大小限制'));return;}
  const chunks:Buffer[]=[];let size=0;
  res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>options.maxBytes){res.destroy();reject(fail('QUOTA','来源内容超过剪藏大小限制'));}else chunks.push(chunk);});
  res.on('error',reject);res.on('aborted',()=>reject(fail('VALIDATION','来源中断了下载')));
  res.on('end',()=>resolve({status,contentType:String(res.headers['content-type']??''),body:Buffer.concat(chunks),url:url.href}));
 });req.on('error',reject);req.end();
});

/** 测试可注入纯假解析器/传输；生产 HTTP 路由不能传这些依赖。 */
export async function fetchPublicResourceUsing(raw: string,options:Options,resolveHost:(host:string)=>Promise<Address[]>,transport:Transport) {
 const signal=AbortSignal.timeout(options.timeoutMs);
 const onAbort=()=>{throw fail('VALIDATION','来源响应超时，请重试或只存链接');};
 let target=publicFetchUrl(raw);
 for(let hop=0;hop<4;hop++){
  if(signal.aborted)onAbort();
  const host=target.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await new Promise<Address[]>((resolve,reject)=>{
   const abort=()=>reject(fail('VALIDATION','来源域名解析超时'));signal.addEventListener('abort',abort,{once:true});
   resolveHost(host).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  if(!addresses.length||addresses.some(a=>a.family!==isIP(a.address)||!isPublicFetchAddress(a.address)))throw fail('VALIDATION','来源地址指向私有或保留网络，已拒绝');
  // 连接只使用本次验证的地址；请求主机与 TLS SNI 仍是原域名，不再次 DNS 解析。
  const response=await transport(target,addresses.find(a=>a.family===4)??addresses[0]!,options,signal);
  if(response.status>=300&&response.status<400&&response.location){target=publicFetchUrl(new URL(response.location,target).href);continue;}
  if(response.status!==200)throw fail('VALIDATION',`来源返回 HTTP ${response.status}，请使用浏览器剪藏或只存链接`);
  if(response.body.length>options.maxBytes)throw fail('QUOTA','来源内容超过剪藏大小限制');
  return response;
 }
 throw fail('VALIDATION','来源重定向次数过多');
}
export function fetchPublicResource(raw:string,options:Options){return fetchPublicResourceUsing(raw,options,host=>lookup(host,{all:true,verbatim:true}),requestPinned);}
