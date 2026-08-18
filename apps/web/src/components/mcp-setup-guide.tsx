import{useState}from'react';import type{ReactNode}from'react';import{AlertTriangle,Check,Copy,Terminal}from'lucide-react';import{Button}from'./ui/button';

const box="rounded-xl border bg-background";
/** 没有明文时（单独看教程）用占位符，让人知道该往哪填。 */
const PLACEHOLDER="kbk_你的钥匙明文";

export function CopyBlock({title,hint,value}:{title:string;hint?:string;value:string}){
  const[done,setDone]=useState(false);
  return <div className={box}>
    <div className="flex items-center gap-2 border-b px-3 py-2"><p className="flex-1 text-xs font-medium">{title}</p><Button variant="ghost" size="sm" onClick={()=>{void navigator.clipboard.writeText(value);setDone(true);setTimeout(()=>setDone(false),1500)}}>{done?<Check/>:<Copy/>}{done?"已复制":"复制"}</Button></div>
    <pre className="max-h-52 overflow-auto p-3 text-[11px] leading-5">{value}</pre>
    {hint&&<p className="border-t px-3 py-2 text-[11px] text-muted-foreground">{hint}</p>}
  </div>;
}

function Steps({items}:{items:ReactNode[]}){
  return <ol className="grid gap-1.5">{items.map((s,i)=><li key={i} className="flex gap-2.5 text-xs leading-5"><span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-medium">{i+1}</span><span className="min-w-0 text-muted-foreground">{s}</span></li>)}</ol>;
}

const K=({children}:{children:ReactNode})=><code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">{children}</code>;

type Client={id:string;name:string;transport:string;steps:(url:string,secret:string)=>ReactNode[];config:(url:string,secret:string)=>string;hint:string};

const CLIENTS:Client[]=[
  {
    id:"claude-code",name:"Claude Code",transport:"HTTP 直连",
    hint:"放在项目根目录的 .mcp.json。明文走环境变量，配置文件本身可以进版本库。",
    steps:(_u,_s)=>[
      <>在项目根目录新建 <K>.mcp.json</K>，内容用下面这份。</>,
      <>把明文存进环境变量 <K>KB_MCP_TOKEN</K>：Windows 用 <K>setx KB_MCP_TOKEN "明文"</K>，macOS / Linux 写进 <K>~/.zshrc</K> 或 <K>~/.bashrc</K>。</>,
      <><b className="text-foreground">完全退出并重开 Claude Code</b>——配置文件和环境变量都只在启动时读一次，重连命令救不了。</>,
      <>重开后会问你是否信任这台 MCP 服务器，选允许；再用 <K>/mcp</K> 确认 knowledge 已连接。</>,
    ],
    config:(url)=>JSON.stringify({mcpServers:{knowledge:{type:"http",url,headers:{Authorization:"Bearer ${KB_MCP_TOKEN}"}}}},null,2),
  },
  {
    id:"cursor",name:"Cursor",transport:"HTTP 直连",
    hint:"全局配置在 ~/.cursor/mcp.json，只给单个项目用就放项目里的 .cursor/mcp.json。",
    steps:()=>[
      <>打开 <K>~/.cursor/mcp.json</K>（没有就新建），把下面这份并进去。</>,
      <>回到 Cursor 的 Settings → MCP，点 Reload 让它重新加载。</>,
      <>工具列表里出现 knowledge 就算连上了。</>,
    ],
    config:(url,secret)=>JSON.stringify({mcpServers:{knowledge:{url,headers:{Authorization:`Bearer ${secret}`}}}},null,2),
  },
  {
    id:"claude-desktop",name:"Claude 桌面版",transport:"stdio 桥接",
    hint:"桌面版只吃 stdio，要靠 mcp-remote 中转，因此本机必须有 Node 和 npx。",
    steps:()=>[
      <>打开配置文件：Windows 在 <K>%APPDATA%\Claude\claude_desktop_config.json</K>，macOS 在 <K>~/Library/Application Support/Claude/claude_desktop_config.json</K>。</>,
      <>把下面这份并进去。</>,
      <><b className="text-foreground">完全退出桌面版再重开</b>——Windows 记得在托盘图标上右键退出，只关窗口不算。</>,
    ],
    config:(url,secret)=>JSON.stringify({mcpServers:{knowledge:{command:"npx",args:["-y","mcp-remote",url,"--header",`Authorization: Bearer ${secret}`]}}},null,2),
  },
  {
    id:"other",name:"其他客户端",transport:"通用",
    hint:"任何支持 Streamable HTTP 的 MCP 客户端都能接：一个地址加一个 Authorization 头。",
    steps:(url)=>[
      <>MCP 服务器地址：<K>{url}</K></>,
      <>认证方式：请求头 <K>Authorization: Bearer 明文</K>。</>,
      <>只支持 stdio 的客户端，参照「Claude 桌面版」那份用 mcp-remote 中转。</>,
    ],
    config:(url,secret)=>JSON.stringify({mcpServers:{knowledge:{url,headers:{Authorization:`Bearer ${secret}`}}}},null,2),
  },
];

/** 分客户端的接入教程。secret 只在刚签发时有，之后看教程用占位符。 */
export function McpSetupGuide({secret}:{secret?:string}){
  const[active,setActive]=useState(CLIENTS[0]!.id);
  const url=`${location.origin}/api/v1/mcp`;
  const value=secret??PLACEHOLDER;
  const client=CLIENTS.find(c=>c.id===active)??CLIENTS[0]!;
  const isLocal=/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(location.origin);

  return <div className="grid gap-3">
    <div className="flex flex-wrap gap-1.5">{CLIENTS.map(c=><button key={c.id} type="button" onClick={()=>setActive(c.id)} className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${active===c.id?"border-foreground bg-muted":"text-muted-foreground hover:bg-muted/50"}`}>{c.name}</button>)}</div>

    <div className={`${box} p-3`}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium"><Terminal className="size-3.5"/>{client.name} · {client.transport}</p>
      <Steps items={client.steps(url,value)}/>
    </div>

    <CopyBlock title={`${client.name} 的配置`} hint={client.hint} value={client.config(url,value)}/>

    {!secret&&<p className="text-[11px] text-muted-foreground">配置里的 <K>{PLACEHOLDER}</K> 换成你自己那把钥匙的明文。明文只在创建或轮换时显示一次，忘了就轮换一把新的。</p>}

    <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600"/>
      <div className="min-w-0 text-[11px] leading-5 text-muted-foreground">
        <p><b className="text-foreground">改完配置一定要完全重启客户端。</b>MCP 配置和环境变量都是进程启动时读一次，热重连不会重新加载。</p>
        {isLocal&&<p className="mt-1"><b className="text-foreground">当前是本机地址</b>（{location.origin}），只有跑在同一台机器上的客户端能连。要让 Claude.ai 网页版这类云端客户端接入，得把实例部署到公网 HTTPS 域名。</p>}
      </div>
    </div>
  </div>;
}
