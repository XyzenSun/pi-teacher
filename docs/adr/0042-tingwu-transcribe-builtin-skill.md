# tingwu-transcribe 原样接入为第五个内置 skill

> 状态：现行。补上 ADR-0040「tingwu 本轮不接入」的后续；内置 skill 由四个变五个。

接入 `tingwu-transcribe`（通义听悟音视频转写），仓库 `skills/` 从四个变五个。**上游代码原样接入，一行不改**。

## 为什么这次可以接，上次不行

ADR-0040 否决 tingwu 的理由是「它不是 skill 而是需要常驻的本地 REST 网关（端口 8787、靠手动维护登录 Cookie），得先决定怎么部署再写调用它的 skill」。这一版形态变了：

| | 上一版（`tingwu视频语音识别2api`） | 这一版（`tingwu-transcribe`） |
| --- | --- | --- |
| 入口 | 只有 `server.js`，必须先起服务再 curl | 增加 `scripts/cli.js`，**AI 默认走 CLI，无需起服务** |
| 形态 | 一个 npm 项目 | 已按 skill 组织：`SKILL.md` + `scripts/` + `references/` 三层 |
| 依赖 | package.json 有依赖 | **零第三方依赖**，只用 `node:` 内置模块 |

「必须常驻服务」这个唯一的阻塞点消失了——`server.js` 退化为可选入口（用户要在网页上传时才起），转写主路径是纯命令行，与其余四个 skill 的调用方式一致。核实：全部 import 只有 `node:crypto/fs/http/path/url` 与相对路径，容器内 Node 24 直接可跑。

## 原样接入，不改代码

上游质量达标（CLI 优先、references 分层、错误输出结构化 `{error, code, detail}`、失败非零退出码），本轮不做任何源码改动。接入时只做了两件与代码无关的事：删除随目录带来的 `.git`，以及确认没有 `cookie.txt` 等凭证文件混入。

代价是两处与项目约定不完全契合，**经用户明确判断后接受**：

### Cookie 存在 skill 目录内，重启即失效

`cookie-store.js` 默认把 Cookie 写在 `scripts/cookie.txt`（权限 600）。而内置 skill 每次容器启动都被入口脚本 `rm -rf` 后重新复制（ADR-0029），所以**容器重启或升级镜像后 Cookie 会丢，需要重新设置**。

不改的理由：听悟 Cookie 本来就会过期，失效时 CLI 会明确报 `COOKIE_INVALID` 并引导更新，重新粘贴是这个 skill 的常规操作；而容器重启并不频繁。两者叠加后，「重启后要重设」并没有增加多少实际负担。

需要跨重启保留时，不必改代码——`TW_COOKIE_FILE` 环境变量可指向挂载卷内的路径（如 `/root/pi-teacher/data/tingwu-cookie.txt`），已写进 `docs/deploy.md`。

这也是它不走 `user_env` 表（ADR-0034）的原因：Cookie 需要程序在验证成功后回写、失效时标记状态，而 `user_env` 是纯人工维护的配置表，不适合程序改写。

### server.js 默认监听 0.0.0.0 且无鉴权

Web 网关（`TW_HOST` 默认 `0.0.0.0:8787`）没有任何鉴权，能访问该端口的人都能用你的听悟账号。当前风险可控：**容器没有 `EXPOSE 8787`，compose 也没映射该端口**，宿主机访问不到；且它不会自启动，只有模型或用户显式 `node scripts/server.js` 才会起。

如果以后要把这个端口暴露出去，必须先加鉴权或改绑 `127.0.0.1`。

## Consequences

- `skills/` 五个目录：`tavily-search` / `pullpage` / `exa-search`（零依赖 Node 脚本）、`sbx`（esbuild bundle）、`tingwu-transcribe`（上游原样）。
- 后端零改动，`BUILTIN_USER_ENV` 不新增条目——这个 skill 的凭证不走环境变量。
- `.dockerignore` 的 `*.md` 只匹配根目录，已实测 `SKILL.md`、三份 `references/*.md` 与 `ui.html` 都完整进入镜像。
- 升级已有部署：重建镜像即可，入口脚本自动同步；首次使用前需设置一次 Cookie。

## Considered Options

### 改 Cookie 默认路径到挂载卷

否决（本轮）。用户判断「Cookie 本来就会过期、容器重启不频繁」，不值得为此分叉上游代码——一旦改了源码，后续上游更新就要手工合并。需要时用 `TW_COOKIE_FILE` 即可达到同样效果，零代码改动。

### 删掉 server.js 与 ui.html

否决。用户在网页上批量上传是真实需求，而当前端口未暴露、不自启动，风险已被容器边界隔离。删掉反而丢功能。

### 把 Cookie 纳入 user_env 表

否决。`user_env` 的值由用户在界面手工维护，程序只读；而 Cookie 需要程序在验证通过后写入、在失效时标记，语义不匹配。
