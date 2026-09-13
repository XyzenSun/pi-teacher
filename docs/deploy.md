# 部署（Docker）

单机、单用户部署，基于 `Dockerfile` + `docker-entrypoint.sh` + `compose.yaml`（决策背景：ADR-0015 镜像选型、ADR-0029 目录挂载、ADR-0034 用户环境变量、ADR-0036 维护提醒）。目标形态是：克隆仓库，`docker compose up -d`，一键运行。

仓库里有两份 compose，分工不同：`compose.yaml` 是源码构建版（`build: .` + healthcheck，本仓库开发验证用）；`docker-compose.yaml` 是镜像拉取版（GHCR `ghcr.io/xyzensun/pi-teacher:latest`，与 main 分支同步维护，面向开源使用者）。两者挂载与环境变量语义一致，本文以 `compose.yaml` 为准叙述。

## 一句话模型

容器内**完全遵循 Pi 的约定**：进程以 root 运行，业务数据在 `~/pi-teacher`，Pi 配置在 `~/.pi/agent`，skills 在 `~/.pi/agent/skills`——和在宿主机上直接 `npm run dev` 一模一样，代码里没有任何容器专用路径。宿主机上这两个目录放在哪里由 compose 的两个变量决定，默认就平铺在 `compose.yaml` 旁边（首次启动自动创建）：

| 变量 | 默认值 | 挂到容器内 | 放什么 |
| --- | --- | --- | --- |
| `HOST_PI_TEACHER_HOME` | `./pi-teacher` | `/root/pi-teacher` | SQLite（`data/`）、`materials/`、各会话工作目录、全局 `AGENTS.md` / `USER.md` |
| `HOST_PI_AGENT_DIR` | `./pi-agent` | `/root/.pi/agent` | `models.json`（provider 与 API key）、`settings.json`（默认模型）、`skills/`（见下）、Pi 自己的运行态 |

两个目录都已写进 `.gitignore` 与 `.dockerignore`，不会被提交、也不会被打进镜像。

**skills** 就是 `HOST_PI_AGENT_DIR/skills/`，随 `~/.pi/agent` 一起挂进容器，可写：

- **内置 skill**（仓库 `skills/`：`tavily-search` 搜索、`exa-search` 搜索与问答、`pullpage` 单 URL 抓取、`sbx` 云沙箱、`tingwu-transcribe` 音视频转写）随镜像走。容器每次启动，入口脚本把镜像里的每个内置 skill**先删同名目录再整目录复制**进 `~/.pi/agent/skills`，所以升级镜像就等于升级了内置 skill。内置 skill 的目录归镜像管，直接改它会在下次启动被覆盖回来；想定制就复制一份改个名字。
  - `tingwu-transcribe` 的登录 Cookie 默认落在 skill 目录内（`scripts/cookie.txt`，权限 600），因此**容器重启或升级镜像后需要重新设置**（`node scripts/cli.js cookie set '<纯Cookie值>'`）。Cookie 本来就会过期、失效时 CLI 会明确提示，按需重设即可。要让它跨重启保留，可在 compose 的 `environment` 里加 `TW_COOKIE_FILE=/root/pi-teacher/data/tingwu-cookie.txt`（该路径在挂载卷内）。
- **你自己的 skill** 往 `HOST_PI_AGENT_DIR/skills/` 里放目录即可（每个子目录一个 `SKILL.md`），入口脚本不碰内置以外的任何目录；`docker compose restart` 后 Pi 会在下次开会话时发现它。

其余变量：

| 变量 | 作用 |
| --- | --- |
| `PI_TEACHER_PORT` | 宿主监听端口，默认 `39871` |
| `PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` | 固定默认模型；设了以后界面里不能改默认模型。留空则用 `settings.json` 的 `defaultProvider` / `defaultModel`，再没有就取 `models.json` 里第一个 |
| `PI_TEACHER_HOSTNAME` | 用**域名**访问时必填（`localhost` 与 IP 直连不用）。后端校验 `Host` 头防 DNS rebinding，未列出的域名一律 403 |

变量写在 `compose.yaml` 同目录的 `.env` 里即可（compose 自动读取；该文件已被 `.gitignore` / `.dockerignore` 排除）。`TAVILY_API_KEY` 之类 skill 用的密钥**不要**写在这里：登录后到「系统设置 → 高级配置 → 用户环境变量」填，存进数据库并立即注入进程环境（ADR-0034），换容器不丢。

## 前提

- Docker 24+ 与 Compose v2（`docker compose version` 能出版本号即可）。
- `HOST_PI_AGENT_DIR` 下要有 `models.json`——这是 Pi 的 provider 配置，Pi Teacher 不生成它。最省事的做法是先在宿主机装 Pi 跑一次 `pi` 配好模型，然后把 `~/.pi/agent` 整个复制到 `./pi-agent`（或干脆设 `HOST_PI_AGENT_DIR=~/.pi/agent` 直接共用）；也可以手写一份（格式见 Pi 文档；界面「系统设置 → 模型」在启动后也能增删 provider，但至少要能起来）。
- 首次构建需要能访问 npm registry（走 `server/package-lock.json` 锁定的源）和 Docker Hub 拉 `node:24-slim`。

## 首次启动

```bash
cd pi-teacher
# 需要改端口 / 目录 / 默认模型时先建 .env，例如：
#   printf 'PI_TEACHER_PORT=39871\nHOST_PI_AGENT_DIR=~/.pi/agent\n' > .env
docker compose build            # 三阶段：前端构建 → 后端依赖 → 运行镜像；约 1–3 分钟
docker compose up -d
docker compose ps               # STATUS 应在 20 秒内变成 Up … (healthy)
docker compose logs --tail 5    # 能看到 [entrypoint] 内置 skill 已同步… 与 [server] Pi Teacher 已启动
```

浏览器打开 `http://localhost:39871`，首次进入会要求设置用户名与密码（单用户）。然后：

1. 「系统设置 → 模型」确认 provider 与默认模型；`PI_TEACHER_PROVIDER` 固定了的话这里只读。
2. 「系统设置 → 高级配置 → 用户环境变量」填 `TAVILY_API_KEY`（用搜索 skill 才需要）。
3. 「系统设置 → 高级配置 → 教学运行设置」按需调整共用提醒间隔（默认 30 轮，0 关闭全部提醒）与四段文案（三段基础 + 学习精华）。「恢复默认」只还原对应文案；学习精华仅在学习会话的基础提醒后同轮追加，不替代原有提醒。
4. 「系统设置 → 全局 AGENTS.md / 用户偏好」按需改全局规则与长期偏好；出厂内容来自 `server/src/prompts/defaults.ts`，只在文件不存在时写入一次。

想让脚本替你把 HTTP 面走一遍（含真模型对话、skill 是否可用）：

```bash
cd server && npm install        # 只装一次
PI_TEACHER_BASE_URL=http://127.0.0.1:39871 \
PI_TEACHER_VERIFY_USERNAME=你的用户名 PI_TEACHER_VERIFY_PASSWORD=你的密码 \
npm run verify:remote
```

实例还没设置账号时可以不传用户名密码，脚本会自己 setup 一个并在结尾打印出来。脚本只通过 HTTP 工作，不碰宿主目录；它创建的验收 Space 结束时会删除（工作目录按 ADR-0037 保留在 `HOST_PI_TEACHER_HOME/learn/<id>/` 下，可手动清理）。

## 日常操作

| 要做什么 | 命令 |
| --- | --- |
| 看日志 | `docker compose logs -f --tail 200` |
| 停止 | `docker compose stop`。后端收到 SIGTERM 会先给每个打开的会话发 `session_shutdown` 再退出，日志能看到 `[bridge] 收到 SIGTERM，先向 N 个会话发 session_shutdown 再退出`；实测退出用时不到 1 秒，远在 Docker 的 10 秒宽限期内，退出码 0 |
| 重启 | `docker compose restart`。会话列表、卡片、用户环境变量、设置全部保留（都在挂载目录里）；打开着的对话会被关掉，界面重新打开即可 |
| 升级 | 先备份，再 `git pull && docker compose build && docker compose up -d`。新代码与出厂提示词需要重建镜像，不能只 restart。后端启动时自动补齐 schema，内置 skill 由入口脚本覆盖成新版本，旧部署的 `attachments/` 会一次性改名为 `files/`（ADR-0038）；资料与精华阶段的兼容规则见下文 |
| 加自己的 skill | 把目录放进 `HOST_PI_AGENT_DIR/skills/`，`docker compose restart` |
| 备份 | 复制 `HOST_PI_TEACHER_HOME` 与 `HOST_PI_AGENT_DIR` 两个目录。SQLite 开着 WAL，运行中复制要把 `data/pi-teacher.db`、`-wal`、`-shm` 三个文件一起拷；最稳妥是 `docker compose stop` 后再复制 |
| 恢复 | 停容器，把两个目录放回原位，`docker compose start` |

镜像内没有 shell 工具以外的东西（无 curl、无 python3）；进容器排查用 `docker compose exec pi-teacher sh`。

## 资料归档与学习精华的升级兼容（ADR-0039）

升级前先备份两个挂载目录，再重建镜像并启动。这个阶段不需要重建数据库，也不需要重新创建学习 Pi Session：

- **既有全局 AGENTS.md 不自动覆盖。** 新建数据目录会使用新的出厂资料规范；已有部署请在「系统设置 → Agents Md → 全局 AGENTS.md」手工合并 `server/src/prompts/defaults.ts` 的「上传资料的阅读与归档」规范与学习专属 `essence/` 说明，保留自己的其他规则。重新打开对话后加载新规则。
- **上传仍进入当前会话的 `files/`。** 模型实际阅读并判断正确、可学习后，规整资料移入全局 `materials/`；混乱原件先保留到 `materials/origins/`，整理后的学习版本放入 `materials/`，索引由模型维护。升级不会自动搬动或整理任何资料。
- **原三段自定义提醒保持不变。** 新增 `learningEssence` 文案缺行即使用出厂值，可在高级配置编辑或恢复默认。它仅在学习会话的基础提醒后同轮追加，与原提醒共用间隔；0 一起关闭，制卡开关不影响精华段。
- **旧学习会话正常打开时补建空 `essence/`。** 既有精华文件不改写；助教与复习不自动创建。若 `essence` 被普通文件占用，打开返回 409，需先自行检查并妥善处理该文件，程序不会强行替换。
- **卡片来源列自动幂等移除。** `card.source_essence_path` 不再保留，工具与 HTTP 也不再返回来源字段；卡片其他字段、ID、调度、复习日志及精华文件保留，不创建替代关联。

**回退旧镜像时，需要同时恢复升级前备份。** 旧代码仍可能查询已经移除的列，不能只把镜像版本切回去。

## 常见错误

**打开对话后模型显示 `unknown`，发消息返回「会话命令未被接受」**
`HOST_PI_AGENT_DIR` 下没有 `models.json`，或者里面没有任何可用 provider。`GET /api/models` 会返回空列表。到「系统设置 → 模型」添加 provider，或把宿主机配好的 `models.json` 放进该目录后 `docker compose restart`。

**`failed to bind host port 0.0.0.0:39871/tcp: address already in use`**
宿主机端口被占（多半是本机还在 `npm run dev`）。`ss -lptn 'sport = :39871'` 看谁占着；换端口就在 `.env` 里设 `PI_TEACHER_PORT=39872`。

**浏览器访问返回 `{"error":"Invalid Host header"}`（403）**
用域名访问但没设 `PI_TEACHER_HOSTNAME`。设成访问用的域名（不带端口）后 `docker compose up -d`。反向代理场景同理，代理转发的 `Host` 必须是这个域名。

**宿主目录里的文件属 root，普通用户改不了**
容器内以 root 运行，写进挂载目录的文件自然属 root。宿主机上要编辑（例如改 `USER.md`）时 `sudo chown -R $USER` 一次即可；容器不介意文件属于谁。以非 root 运行需要 uid 对齐，目前没做（PRD `docs/tasks/preproduction-readiness.md` §7）。

**skill 在对话里「找不到命令」**
先 `docker compose exec pi-teacher ls /root/.pi/agent/skills` 看目录是否在；每个 skill 必须是一个含 `SKILL.md` 的子目录。自己加的 skill 的可执行文件要先 `chmod +x`（入口脚本复制内置 skill 时保留权限位，自己的目录它不动）。密钥不从 skill 目录的 `.env` 读，统一走界面里的用户环境变量。

**改了内置 skill，重启后被改回去了**
这是预期行为：内置 skill 的目录归镜像管。想定制就复制一份改个名字，Pi 会把两份都加载（同名才会冲突）。

**`docker compose build` 卡在 `npm ci`**
构建阶段要访问 `registry.npmmirror.com`（lockfile 锁定的源）。后端依赖用 `--ignore-scripts` 安装是有意为之：better-sqlite3 自带预编译二进制，镜像里没有也不需要 Python / 编译器；如果换了会触发编译的依赖版本，先看 `docs/spec.md` 的对应条目。

## 从宿主机直跑迁移到容器

宿主机上一直用 `npm run dev` 的话，数据本来就在 `~/pi-teacher` 与 `~/.pi/agent`，在 `.env` 里写 `HOST_PI_TEACHER_HOME=~/pi-teacher` 与 `HOST_PI_AGENT_DIR=~/.pi/agent` 后 `docker compose up -d`——容器看到的就是同一套目录。注意先停掉宿主机上的后端，两者不能同时写同一个 SQLite。反过来，宿主机直跑想用仓库自带的 skill，把 `skills/` 下的目录复制（或软链）进 `~/.pi/agent/skills/` 即可，直跑没有入口脚本替你做这件事。
