import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发：vite dev（5173）→ /api 代理到指挥面板后端（8787）
// 生产：vite build --base=/app/ → web/dist，由 server.mjs 以 /app/* 静态托管
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: { outDir: "dist", sourcemap: true },
});
