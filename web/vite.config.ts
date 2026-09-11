import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 开发期 /api 代理到本地后端，避免前端自带一套鉴权 cookie 域名问题；
 * 生产期由 Express 直接托管 dist，所以 base 用相对路径。
 * SSE 必须关掉代理缓冲，否则事件会被攒到连接结束才吐出来。
 */
// 验收时可用 PI_TEACHER_API_PORT 指向隔离数据目录的后端，不碰真实 ~/pi-teacher。
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${loadEnv(mode, ".", "PI_TEACHER_").PI_TEACHER_API_PORT ?? "39871"}`,
        changeOrigin: false,
        ws: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
}));
