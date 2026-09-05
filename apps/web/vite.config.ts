import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { compactNoteTitlePlugin } from "./compact-note-title-plugin";

export default defineConfig({
  plugins: [compactNoteTitlePlugin(), react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 12098,
    strictPort: true,
    proxy: {
      // ws: true —— 协同房间就挂在 /api/v1/notes/:id/collab 上，开发态也得转 WebSocket 升级
      "/api": { target: "http://127.0.0.1:12099", changeOrigin: true, ws: true },
      // OAuth 发现端点与 ICS 订阅地址都在根路径下，开发态也要转给 api
      "/.well-known": { target: "http://127.0.0.1:12099", changeOrigin: true },
      "/calendar/feed": { target: "http://127.0.0.1:12099", changeOrigin: true },
    },
  },
});
