import { createHmac,randomInt } from "node:crypto";
import { env } from "../env.ts";
// 给访客评论用的最小验证码：一道加法，答案签在 token 里，不落库也不引第三方。
const sign=(payload:string)=>createHmac("sha256",env.appSecret).update(payload).digest("base64url");
export function issueChallenge(){
  const a=randomInt(2,9),b=randomInt(2,9),expires=Date.now()+600000;
  const payload=`${a+b}.${expires}`;
  return{question:`${a} + ${b} = ?`,token:`${payload}.${sign(payload)}`};
}
export function solveChallenge(token:string|undefined,answer:string|undefined){
  if(!token||!answer)return false;
  const[sum,expires,mac]=token.split(".");
  if(!sum||!expires||!mac)return false;
  if(sign(`${sum}.${expires}`)!==mac)return false;
  if(Number(expires)<Date.now())return false;
  return answer.trim()===sum;
}
