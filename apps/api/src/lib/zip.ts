import { crc32,deflateRawSync } from "node:zlib";
// 最小 zip 写入器：只用 deflate，够导出「给人看的树」，不引第三方依赖。
export type ZipEntry={path:string;data:Buffer};
const dosTime=(d:Date)=>((d.getHours()<<11)|(d.getMinutes()<<5)|Math.floor(d.getSeconds()/2))&0xffff;
const dosDate=(d:Date)=>(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xffff;

export function makeZip(entries:ZipEntry[],at=new Date()){
  const time=dosTime(at),date=dosDate(at),locals:Buffer[]=[],central:Buffer[]=[];
  let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.path,"utf8"),raw=entry.data;
    const packed=deflateRawSync(raw),useDeflate=packed.length<raw.length;
    const data=useDeflate?packed:raw,method=useDeflate?8:0,sum=crc32(raw);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6); // 0x0800 = 文件名按 UTF-8 读
    local.writeUInt16LE(method,8);local.writeUInt16LE(time,10);local.writeUInt16LE(date,12);
    local.writeUInt32LE(sum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);
    const dir=Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50,0);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x0800,8);
    dir.writeUInt16LE(method,10);dir.writeUInt16LE(time,12);dir.writeUInt16LE(date,14);
    dir.writeUInt32LE(sum,16);dir.writeUInt32LE(data.length,20);dir.writeUInt32LE(raw.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);
    locals.push(local,name,data);central.push(dir,name);
    offset+=30+name.length+data.length;
  }
  const cd=Buffer.concat(central),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,eocd]);
}

const CONTROL_CHARS=new RegExp("[\\u0000-\\u001f]","g");
const WINDOWS_RESERVED=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** zip 里的一段路径：去掉分隔符与控制字符，Windows 保留名也躲开。 */
export function safeSegment(raw:string,fallback="未命名"){
  const cleaned=raw.normalize("NFKC").replace(/[\\/:*?"<>|]/g,"_").replace(CONTROL_CHARS,"").replace(/^\.+|\.+$/g,"").trim();
  if(!cleaned)return fallback;
  if(WINDOWS_RESERVED.test(cleaned))return `_${cleaned}`;
  return cleaned.slice(0,80);
}
/** 同一层里重名就加 -1 -2，扩展名保住。 */
export function uniquePath(used:Set<string>,path:string){
  if(!used.has(path.toLowerCase())){used.add(path.toLowerCase());return path;}
  const dot=path.lastIndexOf("."),stem=dot>0?path.slice(0,dot):path,ext=dot>0?path.slice(dot):"";
  for(let i=1;;i++){const next=`${stem}-${i}${ext}`;if(!used.has(next.toLowerCase())){used.add(next.toLowerCase());return next;}}
}
