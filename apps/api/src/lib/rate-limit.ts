import { fail } from "@kb/shared";
type Bucket={count:number;reset:number};const buckets=new Map<string,Bucket>();
export function limit(key:string,max:number,windowMs:number){const now=Date.now();let b=buckets.get(key);if(!b||b.reset<=now){b={count:0,reset:now+windowMs};buckets.set(key,b);}b.count++;if(b.count>max)throw fail("RATE_LIMIT","请求过于频繁，请稍后再试");if(buckets.size>10000)for(const[k,v]of buckets)if(v.reset<=now)buckets.delete(k);return{remaining:Math.max(0,max-b.count),reset:b.reset};}
