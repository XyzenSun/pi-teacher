# sbx — 统一云沙箱 CLI

一套命令操作 Daytona / E2B / CodeSandbox 三家云沙箱：创建 → 上传 → 执行 → 取结果 → 下载 → 销毁。为 AI Agent（Claude Code skill）代码验证场景设计。

## 安装

```bash
npm install -g @xyzensun/sbx   # 全局安装，CLI 命令为 sbx
# 或不安装直接用：npx @xyzensun/sbx list
```

npm 包内含 TypeScript 源码（src/）与 SKILL.md（Claude Code 技能文档），完全开源（MIT）。

### 作为 Claude Code skill 安装

```bash
mkdir -p ~/.claude/skills/sbx
cp "$(npm root -g)/@xyzensun/sbx/SKILL.md" ~/.claude/skills/sbx/SKILL.md
```

## 认证（环境变量优先，--envfile 显式加载）

| 平台 | 环境变量 | 可选反代 |
|---|---|---|
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_URL` |
| E2B | `E2B_API_KEY` | `E2B_DOMAIN` / `E2B_API_URL` |
| CodeSandbox | `CODESANDBOX_API_KEY` | `CODESANDBOX_API_URL` |

> key 从不持久化到磁盘；`sbx list` 只显示已配置 key 的平台（key 掩码显示）。

### --envfile：从 .env 文件加载

key 不方便 export 时，任一命令均可显式指定 envfile（支持 `export KEY=VALUE`、单双引号、`#` 注释；真实环境变量优先于文件值）：

```bash
sbx list --envfile ./sandbox.env
sbx create -p e2b --ttl 10 --envfile ./sandbox.env --json
```

## 命令速查

```bash
sbx list                                        # 可用平台（仅显示配了 key 的）

sbx create -p e2b                               # 默认模板
sbx create -p e2b --template my-tpl             # 平台已有模板
sbx create -p e2b --dockerfile ./Dockerfile     # 本地 Dockerfile（强制单阶段）
sbx create -p daytona --image python:3.12-slim  # 公共镜像（Daytona 免构建）
sbx create -p e2b --ttl 30 --env FOO=bar        # TTL 30 分钟自动销毁

sbx run    -p e2b -s <id> "npm test"                    # 前台执行，透传退出码
sbx run    -p e2b -s <id> "npm run dev" --background    # 后台，返回 commandId
sbx result -p e2b -s <id> <commandId> --wait            # 查询/等待后台命令

sbx upload   -p e2b -s <id> ./app.py /home/user/app.py
sbx download -p e2b -s <id> /home/user/out.png ./out.png
sbx preview  -p e2b -s <id> --port 3000         # 公网预览 URL

sbx ps      -p e2b                              # 沙箱列表
sbx stop    -p e2b -s <id>                      # 停止（E2B pause 免费保内存）
sbx destroy -p e2b -s <id> --yes                # 彻底销毁
```

## 约定

- 所有命令（除 `list`）必带 `-p/--platform`，或设 `SBX_DEFAULT_PLATFORM`
- 全部命令支持 `--json`（稳定结构，供 skill/脚本消费）
- 退出码：`0` 成功；`2` 参数/key/Dockerfile 错误；`3` 平台级错误；`run`/`result` 透传沙箱内命令退出码
- `--dockerfile` 强制单阶段：CLI 本地解析，多条 `FROM` 直接拒绝（行号级报错）
- Dockerfile/镜像 → 平台模板时按内容寻址命名（`sbx-<镜像描述>-<hash8>`）并缓存复用；`--force-rebuild` 重建

## 平台差异速记

| | Daytona | E2B | CodeSandbox |
|---|---|---|---|
| `--image` | 直接创建（秒级） | 构建模板（分钟级，有缓存） | 构建模板（分钟级，有缓存） |
| 命令 stderr | session 模式分离 | 原生分离 | 平台合并输出（stderr 恒空） |
| preview | 签名 URL（1h） | `{port}-{id}.e2b.app`（服务需绑 0.0.0.0） | `{id}-{port}.csb.app` |
| stop 语义 | stop（省资源） | pause（保内存不计费） | hibernate（快照休眠） |

## 开发

```bash
npm run typecheck   # 类型检查
npm run build       # 编译到 dist/
npm run dev         # tsx 直跑 src/
```

架构：`src/index.ts`（CLI 层）→ `src/platform-registry.ts`（平台注册）→ `src/providers/*`（三家适配，实现统一 `SandboxProvider` 接口）。平台差异封闭在 Provider 内；`src/dockerfile/parser.ts` 负责单阶段校验；`src/template-naming.ts` 负责内容寻址命名。

> 注：`src/types/codesandbox-shim.d.ts` 是 `@codesandbox/sdk` 的类型补丁——其发行版 `.d.ts` 内部相对导入无扩展名，NodeNext 下类型树解析失败；运行时不受影响。
