# sbx 单文件产物来源

`scripts/sbx` 是 npm 包 `@xyzensun/sbx` 的 esbuild 单文件打包产物，不是手写代码。源码与版本归上游仓库管辖，本目录不放源码副本，只记录重建方法。

- 上游仓库：`git@codeup.aliyun.com:68fa4149bb64aae551966922/sandbox-cli.git`
- npm 包：`@xyzensun/sbx`（npmmirror 与官方源均已发布）

## 为什么打包而不是直接装

- 直接 `npm install`：`@codesandbox/sdk` 传递引入 `@opentelemetry` / `@sentry`，node_modules 共 445M，对 701M 的运行镜像不可接受（实测数字见 ADR-0040）。
- 运行时 `npx -y @xyzensun/sbx`：容器内首拉实测 286 秒，npm 缓存落在非挂载的 `/root/.npm`，容器重建即丢，模型一次调用等不起。
- 单文件 bundle：4.4M、纯 JS（无原生模块）、离线可用，与 tavily-search 直接提交 Go 静态二进制的做法同一范式。

## 升级重打

```bash
mkdir /tmp/sbx-rebuild && cd /tmp/sbx-rebuild
npm init -y >/dev/null
npm install @xyzensun/sbx --registry=https://registry.npmmirror.com
npx -y esbuild@0.25.0 --bundle node_modules/@xyzensun/sbx/dist/index.js \
  --platform=node --format=esm --target=node24 \
  --banner:js='import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' \
  --outfile=scripts/sbx
chmod 755 scripts/sbx
```

要点：

- 必须 `--format=esm` + `createRequire` banner：cjs 产物会把依赖里的 `createRequire(import.meta.url)` 变成 `__filename` 未定义（实测 `ERR_INVALID_ARG_VALUE`）；裸 esm 则死在「Dynamic require of "util"」。
- 产物自带 `#!/usr/bin/env node` shebang，容器与宿主机都满足 Node ≥ 24。
- 换版本只改安装命令；重新提交产物后按 CLAUDE.md 流程重建镜像，entrypoint 会覆盖同步进 `~/.pi/agent/skills`。

## 验证

```bash
scripts/sbx --version          # 应输出包版本号
scripts/sbx list                # 无 key 时提示三家环境变量名
E2B_API_KEY=<假key> scripts/sbx create -p e2b --ttl 5 --json
# 假 key 也应返回平台层鉴权错误（证明 SDK 真实发出请求，打包未破坏功能）
```
