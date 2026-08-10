import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// 开发：vite dev（5173）→ /api 代理到指挥面板后端（8787）
// 生产：vite build → web/dist，由 server.mjs 以 /app/* 静态托管
// base 固化在配置里而非命令行参数：Git Bash 会把 --base=/app/ 里的 /app/ MSYS
// 转换成 /Program Files/Git/app/，导致产物 index.html 引用坏路径（2026-08-10 修复）
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: { outDir: "dist", sourcemap: true },
});
