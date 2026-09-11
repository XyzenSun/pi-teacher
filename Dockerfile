# Pi Teacher 运行镜像（PRD docs/tasks/preproduction-readiness.md §3.6；约束见 ADR-0015 / ADR-0029 / ADR-0034）。
#
# 布局必须与仓库相对路径一致：server/src/index.ts 用 ../../web/dist 找前端产物。
# 出厂提示词（全局 AGENTS.md、agents_md / teach_style 模板、维护提醒文案）全在 server/src/prompts/defaults.ts，
# 镜像里没有 docs。运行方式与开发一致（node --import tsx），tsx 已在 dependencies；预编译留作后续优化。
#
# 容器内不覆盖任何路径约定（ADR-0029）：以 root 运行，数据目录就是 ~/pi-teacher（/root/pi-teacher），
# Pi 配置与 skills 就是 ~/.pi/agent 与 ~/.pi/agent/skills。宿主侧放在哪里由 compose.yaml 的挂载决定。
# 仓库自带的内置 skill 随镜像走（/app/skills），docker-entrypoint.sh 每次启动把它们覆盖进 ~/.pi/agent/skills，
# 用户自己加的 skill 目录不受影响。

# ---- 1. 前端构建 ----
FROM node:24-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. 后端运行依赖（生产依赖，含 tsx 与 better-sqlite3 预编译二进制）----
FROM node:24-slim AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
# --ignore-scripts：npm ci 按 lockfile 装包，lockfile 不记录 better-sqlite3 的 gypfile:false，
# npm 看到磁盘上的 binding.gyp 就会合成 node-gyp rebuild，而 slim 镜像没有 Python / make / g++。
# 运行时 lib/binding.js 直接加载 prebuilds/linux-x64.node，本来就不需要编译；
# 其余带 install 脚本的生产依赖（esbuild 校验 @esbuild/linux-x64、protobufjs 整理版本号、@google/genai 空操作）跳过也不影响运行。
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# ---- 3. 运行时 ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=39871
WORKDIR /app
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/package-lock.json ./server/
COPY server/src ./server/src
COPY --from=web-build /app/web/dist ./web/dist
# 内置 skill：新增 skill 只需往仓库 skills/ 加目录，不改后端代码。
COPY skills ./skills
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 两个挂载点先建好；不声明 VOLUME——ADR-0029 不用匿名卷，未挂载时写进容器层，只适合临时试跑。
RUN mkdir -p /root/pi-teacher /root/.pi/agent/skills
EXPOSE 39871
WORKDIR /app/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
