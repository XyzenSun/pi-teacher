# sbx 源码（本目录即权威）

`skills/sbx/scripts/sbx`（4.4M 单文件 node cli）由本目录的 TypeScript 源码用 esbuild 打包.

## 目录内容

- `src/`：源码。`index.ts` 是 CLI 入口（commander），`providers/` 三家沙箱实现（daytona / e2b / codesandbox），`dockerfile/parser.ts` 本地校验单阶段构建，`envfile.ts` 是 `--envfile` 选项（Pi Teacher 场景不用，SKILL.md 明令 key 由后端注入环境变量；保留是为了与迁移基线一致，见下）
- `package.json` / `package-lock.json`：依赖三家 SDK（`@codesandbox/sdk` / `@daytona/sdk` / `e2b`）+ commander；`repository` 字段仍指向上游 codeup 私有仓库，属历史信息
- `tsconfig.json`：`tsc` 配置（typecheck / `npm run dev` 用）；**打包不用 tsc，用下面的 esbuild**
- `UPSTREAM-README.md`：上游 0.1.0 的 README 原样存档（npm 包视角的完整 CLI 文档，含三家平台反代环境变量表）；`../SKILL.md` 才是 Pi Teacher 适配版（`scripts/sbx` 路径、key 由后端注入、不用 `--envfile`），两者有实质差异，**不要拿 UPSTREAM 版覆盖 SKILL.md**

迁入时与上游逐字节一致（排除了 Windows 残留空文件 `nul`）；`scripts/sbx` 未重打，其 `--version`（0.1.0）与 `package.json` 一致，源码与产物严格对应。

## 为什么分发仍是 bundle，不是源码直跑

三家 SDK 的 node_modules 实测 **445M**：随镜像 COPY 或容器启动时装（npx 首拉实测 286 秒、npm 缓存 673M 落在非挂载目录）都不可接受。esbuild 压成 4.4M 纯 JS 单文件（无原生模块），`COPY skills/` 即进镜像，entrypoint 复制到 `~/.pi/agent/skills/` 即用，离线自包含。源码直跑只用于开发调试：本目录 `npm install` 后 `npx tsx src/index.ts <cmd>`。

## 改代码后重打产物

```bash
cd skills/sbx/sourcecode
npm install                      # 仅本目录开发时需要；镜像构建不跑这步
npx -y esbuild@0.25.0 --bundle src/index.ts \
  --platform=node --format=esm --target=node24 \
  --banner:js='import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' \
  --outfile=../scripts/sbx
chmod 755 ../scripts/sbx
```

踩坑记录（上游时代实测，esbuild 行为未变）：

- 必须 `--format=esm` + `createRequire` banner：cjs 产物会把依赖里的 `createRequire(import.meta.url)` 变成 `__filename` 未定义（`ERR_INVALID_ARG_VALUE`）；裸 esm 则死在「Dynamic require of "util"」。
- 产物入口是 `src/index.ts`（上游 npm 包的 dist/index.js 是 tsc 产物，多一层转译）；esbuild 直接吃 TS。
- 产物自带 `#!/usr/bin/env node` shebang；容器与宿主机都满足 Node ≥ 24。
- 改动后提交 `scripts/sbx` 与 `sourcecode/` 源码**同一个 commit**；重打后按 AGENTS.md 流程重建镜像，entrypoint 会覆盖同步进 `~/.pi/agent/skills`。

## 验证

```bash
scripts/sbx --version            # 与 sourcecode/package.json 的 version 一致
scripts/sbx list                 # 无 key 时提示三家环境变量名
E2B_API_KEY=<假key> scripts/sbx create -p e2b --ttl 5 --json
# 假 key 也应返回平台层鉴权错误（证明 SDK 真实发出请求，打包未破坏功能）
sourcecode/ 下：npm install && npx tsc --noEmit   # typecheck
```
