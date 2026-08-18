import { createRoot } from "react-dom/client";
import { ThemeRoot } from "./theme";
import { Button } from "./components/ui/button";
import { ConfirmProvider, useConfirm, usePrompt } from "./components/ui/confirm";
import { ToastProvider, useToast } from "./components/ui/toast";
import "./styles.css";

function Probe() {
  const askConfirm = useConfirm(); const askText = usePrompt(); const toast = useToast();
  return <div className="flex flex-wrap gap-3 p-10">
    <Button id="b1" variant="destructive" onClick={async () => { const ok = await askConfirm({ title: "吊销《轮换验收》？", description: "这把钥匙会立刻失效且不可恢复，用它接入的客户端会全部断开。需要的话请新建一把。", confirmText: "吊销", destructive: true }); toast[ok ? "success" : "error"](ok ? "已吊销《轮换验收》" : "已取消"); }}>吊销</Button>
    <Button id="b2" onClick={() => void askText({ title: "申请注销账号", description: "提交后账号进入注销流程，7 天内可以登录回来撤销。请输入当前密码确认。", label: "当前密码", type: "password", autoComplete: "current-password", confirmText: "申请注销", destructive: true })}>注销</Button>
  </div>;
}

createRoot(document.getElementById("root")!).render(<ThemeRoot><ToastProvider><ConfirmProvider><Probe /></ConfirmProvider></ToastProvider></ThemeRoot>);
