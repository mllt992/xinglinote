import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 12098,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:12099", changeOrigin: true },
      // OAuth 发现端点与 ICS 订阅地址都在根路径下，开发态也要转给 api
      "/.well-known": { target: "http://127.0.0.1:12099", changeOrigin: true },
      "/calendar/feed": { target: "http://127.0.0.1:12099", changeOrigin: true },
    },
  },
});
