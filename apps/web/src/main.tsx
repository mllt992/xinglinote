import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeRoot } from "./theme";
import { ConfirmProvider } from "./components/ui/confirm";
import { ToastProvider } from "./components/ui/toast";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeRoot>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </ThemeRoot>
    </BrowserRouter>
  </StrictMode>,
);
