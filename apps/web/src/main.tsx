import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeRoot } from "./theme";
import { ErrorBoundary } from "./components/error-boundary";
import { ConfirmProvider } from "./components/ui/confirm";
import { ToastProvider } from "./components/ui/toast";
import "./styles.css";

// 异步里抛出来的错误进不了 ErrorBoundary（React 只接渲染期的），补一条日志，
// 免得又变成「什么都没发生但功能不对」。不弹提示：这类事件噪音大，打扰不起。
window.addEventListener("unhandledrejection", e => {
  console.error("[星璃笔记] 未处理的 Promise 拒绝", e.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 边界放在 Router 里面：这样兜底页面自己也能用路由，而且 Provider 挂载失败同样接得住 */}
    <BrowserRouter>
      <ErrorBoundary>
        <ThemeRoot>
          <ToastProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </ToastProvider>
        </ThemeRoot>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
