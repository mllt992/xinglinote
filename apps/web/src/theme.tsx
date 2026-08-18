import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

type Resolved = {
  id: string;
  name: string;
  mode: "light" | "dark";
  navActiveStyle: "solid" | "soft";
  vars: Record<string, string>;
};

const Ctx = createContext<{ refresh: () => void }>({ refresh: () => {} });
export const useThemeRefresh = () => useContext(Ctx);

export function ThemeRoot({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    api<Resolved>(`/api/v1/theme/resolved?dark=${dark ? "1" : "0"}`)
      .then((t) => {
        const root = document.documentElement;
        Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
        root.dataset.nav = t.navActiveStyle;
        root.dataset.mode = t.mode;
      })
      .catch(() => {
        /* 未起库时用 css 兜底 */
      });
  }, [tick]);
  return <Ctx.Provider value={{ refresh: () => setTick((x) => x + 1) }}>{children}</Ctx.Provider>;
}
