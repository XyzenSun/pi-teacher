# Pi Teacher

用 AI 教你的本地学习助手。你把资料丢进来，它以**对话**的方式带你学会，并把知识点沉淀成**卡片**，按遗忘曲线安排复习。

单用户、自托管、数据完全留在你自己的机器上。

---

## 目录

- [它是什么](#它是什么)
- [基本架构](#基本架构)
- [Docker 部署](#docker-部署)
- [环境变量配置](#环境变量配置)
- [数据、备份与升级](#数据备份与升级)
- [常见问题](#常见问题)
- [本地开发](#本地开发)

---

## 它是什么

Pi Teacher 不是「问答机器人」，而是一个有教学方法的老师。它的基本循环是：

1. **你上传资料** → 它阅读、判断内容是否可靠、是否值得学；
2. **它给你讲** → 你随时打断提问，它调整节奏；
3. **它出卡片** → 把值得记住的东西整理成问答卡，等你确认；
4. **它安排复习** → 到期的卡片会出现在复习会话里，根据你的掌握程度动态调整间隔。

界面上有三个固定的学习入口：

| 入口 | 用途 |
| --- | --- |
| **助教** | 随时答疑。不清空、不参与复习调度，是整个应用唯一的常驻对话 |
| **复习** | 每天到期的卡片集中在这里过一遍 |
| **学习 Space** | 你自己建的主题容器（比如「线性代数」「Rust 入门」），每个 Space 下可以开多个学习对话 |

「学习 Space / 对话 / 卡片 / Topic / 术语表」这些词在界面和文档里含义一致，篇幅有限不在这里展开。

---

## 基本架构

一个容器跑完全部东西：前端静态页面、后端 API、以及 Pi Agent 会话本身都在同一个进程里。

```
┌─────────────────────────┐
│         浏览器          │  单页应用（React），唯一的用户界面
└───────────┬─────────────┘
            │ HTTP + SSE（默认 :39871）
┌────────────▼─────────────────────────────────────────────┐
│ 容器 pi-teacher（node:24-slim，以 root 运行）            │
│                                                          │
│ Express 5                                                │
│   ├─ /api/*   后端 API（鉴权、卡片、会话…）              │
│   └─ /*       托管前端构建产物                           │
│                                                          │
│ Pi Agent 会话（与后端同进程）                            │
│   └─ 需要联网 / 执行代码时，派生 skill 子进程            │
│        └─> 模型 API / 搜索 API / 云沙箱                  │
│                                                          │
│ /root/pi-teacher   业务数据（挂载点 1）                  │
│ /root/.pi/agent    Pi 配置（挂载点 2）                   │
└──────────────────────────────────────────────────────────┘
```

### 存储分两处，都不在镜像里

| 挂载点 | 内容 | 说明 |
| --- | --- | --- |
| `/root/pi-teacher` | SQLite 数据库、资料库、每个对话的工作目录与聊天记录 | **你的全部数据**。备份就是备份它 |
| `/root/.pi/agent` | `models.json`（模型供应商与 API Key）、`settings.json`（默认模型） | 模型配置。**含密钥，务必备份且不要外传** |

### 内置 skill

镜像里自带几个 skill，Agent 会在需要时自行调用，你不用手动配置：

| Skill | 作用 | 需要的密钥 |
| --- | --- | --- |
| `tavily-search` | 联网搜索（新闻、一般事实、初步资料） | `TAVILY_API_KEY` |
| `exa-search` | 联网搜索（官方文档、论文、版本信息） | `EXA_API_KEY` |
| `pullpage` | 抓取单个网页并转成 Markdown | `TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `JINA_API_KEY` 任一 |
| `sbx` | 在云端沙箱里跑有风险的代码或做原型验证 | `DAYTONA_API_KEY` / `E2B_API_KEY` / `CODESANDBOX_API_KEY` 任一 |
| `tingwu-transcribe` | 音视频转文字、生成字幕 | 通义听悟 Cookie（单独维护，见下） |

密钥没配也不会坏，只是对应 skill 调用会失败。前四类的密钥在界面里填写，见[环境变量配置](#环境变量配置)；听悟的登录 Cookie 不走环境变量，需要时直接对 Agent 说「帮我设置听悟 Cookie」，它会引导你从浏览器里取出 Cookie 值、验证后落盘。

### 安全边界

- **单用户**：首次访问时创建你自己的账号（scrypt 哈希 + 签名 Cookie），没有多用户与权限体系。
- **请求校验（默认关闭）**：后端可以校验 `Host` 白名单（防 DNS rebinding）与同源 `Origin`（防 CSRF），但**默认不开启**。
  - 关闭时（默认）：用任意域名反代访问都不会被拦，也不需要配 `PI_TEACHER_HOSTNAME`。
  - 开启时：用非 `localhost` / 非 IP 的域名访问，必须在下面同时填 `PI_TEACHER_HOSTNAME`，否则 API 返回 403。
  - 自己的内网部署认为不需要这两道防护，所以默认关；**要暴露到公网建议打开**。
- **默认不要直接暴露到公网**。要暴露请自己加一层反向代理（Nginx/Caddy）并开启 HTTPS。
- **公网部署前请先处理这几条**（与上面的开关无关，是目前真实存在的薄弱处）：
  - `/api/auth/login` **没有失败限流**，密码下限只有 6 位，公网可被字典爆破；
  - 登录 Cookie **没有 `Secure` 属性**（`server/src/auth/middleware.ts`），纯 HTTP 下可被中间人截获会话；
  - scrypt 每次尝试需 16 MB 内存，无限流下并发登录可被打满内存。

---

## Docker 部署

### 前置条件

- 一台装了 Docker（含 Docker Compose v2）的机器，Linux / macOS / Windows 均可；
- 一个可用的模型 API Key（OpenAI 兼容接口、Anthropic、Google、Bedrock 等都支持）。

镜像发布在 GitHub Container Registry：

```
ghcr.io/xyzensun/pi-teacher:latest     # 最新稳定版（每次发布稳定版时移动）
ghcr.io/xyzensun/pi-teacher:<版本>      # 例如 v0.0.1，锁版本，推荐生产使用
```

### 第 1 步：准备目录

```bash
mkdir -p pi-teacher && cd pi-teacher
# 把仓库里的 docker-compose.yaml 放到这里
```

不想 clone 仓库的话，直接新建 `docker-compose.yaml`：

```yaml
services:
  pi-teacher:
    image: ghcr.io/xyzensun/pi-teacher:latest
    init: true
    restart: unless-stopped
    ports:
      - "${PI_TEACHER_PORT:-39871}:39871"
    volumes:
      - ${HOST_PI_TEACHER_HOME:-./pi-teacher}:/root/pi-teacher
      - ${HOST_PI_AGENT_DIR:-./pi-agent}:/root/.pi/agent
    environment:
      # Host 白名单 + 同源校验的总开关（防 DNS rebinding / CSRF），默认关闭。
      - PI_TEACHER_REQUEST_SECURITY=${PI_TEACHER_REQUEST_SECURITY:-}
      # 仅在上面开关开启时生效：允许访问的域名（不是 CORS，是 Host 白名单）。
      - PI_TEACHER_HOSTNAME=${PI_TEACHER_HOSTNAME:-}
```

`init: true` 不能省：它让容器里的 PID 1 用 tini 转发信号，`docker stop` 时后端才能先优雅关闭会话再退出，而不是被硬杀。

### 第 2 步：启动

```bash
docker compose up -d
docker compose logs -f     # 看到「Pi Teacher 已启动」就绪
```

### 第 3 步：配置模型（必做）

打开 `http://<你的机器IP>:39871`。

**首次访问会要求你创建账号**（用户名 + 至少 6 位密码）。创建完进入主界面。

此时还**不能开始对话**——还没告诉它用哪个模型。进入 **管理面板 → 模型与 Provider**：

1. 点「新增 Provider」；
2. `api` 选接口类型（绝大多数 OpenAI 兼容服务选 `openai-completions`，Anthropic 官方选 `anthropic-messages`）；
3. 填 `baseUrl`（官方服务可留空）与 `API Key`；
4. 在模型列表里填入模型 id（例如 `gpt-5`、`claude-sonnet-4-5`）；
5. 保存；
6. 回到同一页把 **默认模型** 设为刚添加的 provider + 模型。

配置会原子写入 `~/.pi/agent/models.json`（容器内即挂载目录），凭据不会以任何形式回显到浏览器。

> 保存时会真的用 Pi 的加载器校验一遍配置，写错了会当场拒绝并保留原文件，不会出现「存进去但跑不起来」。

### 第 4 步：用起来

- 在左侧边栏点右上角的「文件夹 +」图标新建一个学习 Space（还没建过时会提示「还没有学习 Space，点右上角文件夹图标创建」）；
- 点 Space 右侧的「+」在里面新建学习对话，把资料拖进输入框上传或直接开始提问；
- 需要联网搜索时，先去 **管理面板 → 高级配置 → 用户环境变量** 填上搜索服务的 Key（见下节）。

### 用域名访问（或反代）

**默认情况下不用做任何配置**：请求校验默认关闭，反代传什么 `Host` 都会放行，直接用你的域名访问就行。

只有当你**开启了请求校验**（`PI_TEACHER_REQUEST_SECURITY=true`）时，才需要显式允许域名：

```yaml
environment:
  - PI_TEACHER_REQUEST_SECURITY=true
  - PI_TEACHER_HOSTNAME=learn.example.com                      # 主域名
  - PI_TEACHER_ALLOWED_HOSTS=learn.example.com,pi.internal     # 额外的，逗号分隔
```

开启后如果忘了填域名，API 会返回 403 `Invalid Host header`。注意这**不是 CORS**（本项目前后端同源，不需要 CORS），而是 Host 白名单。

IP 直访（`http://192.168.1.5:39871`）无论开关如何都放行，不需要任何配置。

### 从源码构建（可选）

不想用预构建镜像时：

```bash
git clone https://github.com/XyzenSun/pi-teacher.git
cd pi-teacher

# 仓库自带的 compose 指向已发布镜像，本地构建要把这一行
#   image: ghcr.io/xyzensun/pi-teacher:latest
# 换成
#   build: .
#   image: pi-teacher:local
sed -i.bak 's|image: ghcr.io/xyzensun/pi-teacher:latest|build: .|' docker-compose.yaml

docker compose up -d --build
```

（上面只把 `image:` 换成 `build: .`，没指定本地镜像名，compose 会用默认名；想要固定名字就照注释里的两行手动改。）

构建较慢：前端要装依赖再编译，后端要装生产依赖。日常开发不必吃这个开销，用[本地开发](#本地开发)的方式跑就行。

---

## 环境变量配置

分成**两层**，理解这一点能省很多事。

### A. 部署环境变量

在 `docker-compose.yaml` / `.env` / `docker run -e` 里设置，作用于整个容器。启动后基本不变。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_TEACHER_PORT` | `39871` | **宿主机**映射端口。改对外端口就改它 |
| `HOST_PI_TEACHER_HOME` | `./pi-teacher` | 宿主侧业务数据目录，挂到容器 `/root/pi-teacher` |
| `HOST_PI_AGENT_DIR` | `./pi-agent` | 宿主侧模型配置目录，挂到容器 `/root/.pi/agent` |
| `PI_TEACHER_HOSTNAME` | 空 | 允许访问的主机名。**仅在 `PI_TEACHER_REQUEST_SECURITY=true` 时生效**；只填主机名，不带端口与协议 |
| `PI_TEACHER_ALLOWED_HOSTS` | 空 | 额外允许的主机名，逗号分隔（与上一项等效，可只用一个）。同样仅在上面的开关开启时生效 |
| `PI_TEACHER_REQUEST_SECURITY` | 关 | Host 白名单 + 同源校验的总开关（防 DNS rebinding / CSRF）。要开就填 `true` |
| `PI_TEACHER_PROVIDER` | 空 | 固定默认模型的 provider，填了就**锁死**，界面不可改 |
| `PI_TEACHER_MODEL` | 空 | 固定默认模型的 id，同上 |
| `PI_TEACHER_HOME` | `~/pi-teacher` | 业务数据目录（容器内路径）。已由挂载决定，正常不用改 |
| `PI_TEACHER_IDLE_TIMEOUT_MS` | `600000` | 空闲会话回收时长（10 分钟）。助教会话不回收 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置目录（容器内路径）。已由挂载决定，正常不用改 |
| `PORT` | `39871` | 后端监听端口（容器内）。改它必须同步改 compose 的端口映射 |

一个典型的 `.env`：

```dotenv
PI_TEACHER_PORT=39871
HOST_PI_TEACHER_HOME=/srv/pi-teacher/data
HOST_PI_AGENT_DIR=/srv/pi-teacher/pi-agent

# 内网自用可以全部留空；要暴露到公网建议打开校验
# PI_TEACHER_REQUEST_SECURITY=true
# PI_TEACHER_HOSTNAME=learn.example.com
```

**关于请求校验**：`PI_TEACHER_REQUEST_SECURITY` 接受 `true` / `1` / `on` / `yes`（不分大小写），其余取值一律视为关闭——**拼错不会意外开启防护**。开关状态在启动日志里会明确提示：

```
[security] Host 白名单与同源校验已关闭（默认）；需要防 DNS rebinding / CSRF 时设 PI_TEACHER_REQUEST_SECURITY=true
```

**关于 `PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL`**：适合「一台机器只服务一个固定模型」的部署。设了以后，管理面板里的默认模型会变成只读并提示「由部署环境变量固定」，防止出现「界面改成功但不生效」的错觉。个人使用建议留空，在界面里改更方便。

### B. 应用内环境变量（skill 密钥）

在 **管理面板 → 高级配置 → 用户环境变量** 里设置。这些值存在数据库里，是唯一数据源，保存后立刻注入后端进程，Agent 下一次调用 skill 就能用上，**不需要重启容器**。

内置变量（未设置会显示为「未配置」，但不影响使用）：

| 变量 | 说明 |
| --- | --- |
| `TAVILY_API_KEY` / `TAVILY_BASE_URL` / `TAVILY_TIMEOUT` | Tavily 搜索 |
| `EXA_API_KEY` / `EXA_BASE_URL` / `EXA_TIMEOUT` | Exa 搜索 |
| `FIRECRAWL_API_KEY` / `FIRECRAWL_BASE_URL` | 网页抓取 |
| `JINA_API_KEY` / `JINA_BASE_URL` | Jina Reader 抓取 |
| `DAYTONA_API_KEY` / `E2B_API_KEY` / `CODESANDBOX_API_KEY` | 云沙箱（sbx skill） |

几个要点：

- 值**明文存库、明文回显**——这是单用户本机工具的取舍，别把不该看到的 Key 放进来；
- 也可以自己加任意变量（大写字母、数字、下划线，不能以数字开头），自定义 skill 可以用到；
- **受保护的变量名不能在这里设置**（`PATH`、`HOME`、`PORT`、以及 `PI_TEACHER_` / `PI_CODING_AGENT_` / `NODE_` / `npm_` 前缀）——它们会改变进程自身行为，设错了服务直接起不来，所以只认部署环境；
- 首次启动时会从容器环境变量和 `~/pi-teacher/.env` 里**一次性导入**内置变量，之后这两个来源不再被读取。也就是说，你既可以在 compose 里给 `TAVILY_API_KEY=xxx`（仅首次生效），也可以在界面里填（长期推荐）。

### C. models.json 与 settings.json

模型相关配置没有走环境变量，而是放在第二个挂载点里，由界面维护、也可以手工编辑：

```
<HOST_PI_AGENT_DIR>/        # 容器内即 ~/.pi/agent
├── models.json             ← 供应商、baseUrl、API Key、模型列表
├── settings.json           ← 默认模型等 Pi 的设置
└── skills/                 ← skill 发现目录，内置 skill 每次启动被覆盖
```

`models.json` 是 Pi 的格式，支持 `//` 注释和尾逗号。手工编辑后在界面上重新保存一次也没问题，界面只覆盖它自己管的字段（`name` / `baseUrl` / `api` / `apiKey` / `headers` / `models`），`compat`、`modelOverrides`、每个模型的 `cost` / `contextWindow` 等高级配置会原样保留。

> ⚠️ **这个文件里有 API Key，权限是 `600`。别把它提交进 git，别贴到群里。** 云沙箱、搜索等 skill 的密钥则存在数据库里。

---

## 数据、备份与升级

### 需要备份什么

只要这两个目录：

```bash
cd /path/to/compose-dir     # 即 docker-compose.yaml 所在目录
docker compose stop         # 先停服，避免拷到写一半的 SQLite

# 两个目录分别是 HOST_PI_TEACHER_HOME（业务数据）与
# HOST_PI_AGENT_DIR（模型配置，含密钥）
tar czf pi-teacher-backup-$(date +%F).tar.gz ./pi-teacher ./pi-agent

docker compose start
```

这里用的是 compose 默认的相对路径；如果你把 `HOST_PI_TEACHER_HOME` / `HOST_PI_AGENT_DIR` 指到了别处，换成实际路径。数据库是 SQLite（带 WAL 文件），停服后整体打包最稳。

### 升级

```bash
docker compose pull        # 拉取最新镜像（latest）
docker compose up -d       # 用新镜像重启
```

锁版本的做法是先把 compose 里的 `image:` 改成具体版本号，再执行上面两条。

镜像升级同时会升级**内置 skill**：容器每次启动都会用镜像里的版本覆盖 `~/.pi/agent/skills/` 下的同名目录。你自己加进去的 skill 目录不会被碰；想定制某个内置 skill，复制一份改名再改——同名目录下次启动会被覆盖回去。

数据库 schema 变更以幂等迁移的形式执行，升级不动你的历史数据。但**不支持降级**，升级前建议留一份备份。

### 改端口 / 换挂载位置

改宿主机端口：设 `PI_TEACHER_PORT`。
换数据位置：设 `HOST_PI_TEACHER_HOME` / `HOST_PI_AGENT_DIR`，把旧目录内容拷过去再启动。

---

## 常见问题

**打不开页面 / 容器起来了但访问不了**
`docker compose logs` 看有没有报错；确认端口没被占用；确认访问的是宿主端口（`PI_TEACHER_PORT`）。

**页面能开，但所有 API 返回 403 `Invalid Host header`**
你把 `PI_TEACHER_REQUEST_SECURITY=true` 打开了，但没配 `PI_TEACHER_HOSTNAME` / `PI_TEACHER_ALLOWED_HOSTS`。补上域名，或者把这个开关关掉。

**登录后什么都不能做 / 报「默认模型不可用」**
还没配置模型，或者配置的默认模型和凭据对不上。去 **管理面板 → 模型与 Provider** 检查。

**搜索不工作**
对应搜索服务的 API Key 没填，或填错了。去 **管理面板 → 高级配置 → 用户环境变量** 补上，保存立即生效，不用重启。

**改了 `models.json` 但界面没反应**
后端每次请求都会比对文件指纹，正常会自动重载。如果配置本身有语法/结构错误，会退回上一个可用状态——把文件改回合法内容即可。

**`docker stop` 很慢**
这是正常的：它要给正在运行的会话发 `session_shutdown`，让 Pi 把最后的状态写盘。装 `init: true` 就是为了保证这一步能走完。

**换了机器想迁移**
把两个挂载目录整个拷到新机器，`docker compose up -d` 即可。登录 Cookie 的签名密钥存在数据目录里，所以旧浏览器会话也继续有效。

---

## 本地开发

开发相关的目录职责、数据库设计、运行时目录约定与验证命令，见 [`doc-for-dev/README.md`](doc-for-dev/README.md)。

```bash
cd server && npm install && npm run dev    # 后端，默认 :39871
cd web    && npm install && npm run dev    # 前端 Vite，代理到后端
```

容器内不装 Node.js 之外的任何运行时；需要跑别的语言的代码时，用 `sbx` skill 去云沙箱，而不是往容器里装环境。

---

## 许可

[MIT](LICENSE)
