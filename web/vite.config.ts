import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 开发期 /api 代理到本地后端，避免前端自带一套鉴权 cookie 域名问题；
 * 生产期由 Express 直接托管 dist，所以 base 用相对路径。
 * SSE 必须关掉代理缓冲，否则事件会被攒到连接结束才吐出来。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:39871",
        changeOrigin: false,
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
