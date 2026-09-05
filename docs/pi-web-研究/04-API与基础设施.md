# 区块 4：API 路由、基础设施、工程配置 —— pi-web 移植研究报告

> 研究对象：`/tmp/pi-web`（agegr/pi-web **v0.8.11**，Next.js 16.3.1，`@earendil-works/*` 0.84.3，MIT）
> 本区块范围：`app/api/`（35 个非 agent/sessions 路由，约 3038 行）、`bin/`、`proxy.ts`、认证/安全库、启动部署、工程配置、ADR。
> 结论先行：**它的安全分层（request-security + web-auth + path-security + project-trust）是我们最值得整体抄走的部分**；它对「Pi 无权限控制」有清醒认识但止步于「信任 + 网络防护」，没有 OS 级隔离——这正是我们 ADR-0015 选 Docker 补的层。

---

## 1. API 路由全表

先看规模（排除 `agent/*` 与 `sessions/*` 两组，那两组在别的区块）：

```
app/api/files/[...path]/route.ts      651 行  ← 最大，文件服务核心
app/api/plugins/route.ts              372 行
app/api/auth/login/[provider]         192 行
app/api/file-index/route.ts           169 行
app/api/models/route.ts               124 行
... 其余均 < 120 行，合计 35 个文件 / 3038 行
```

| 路由 | 方法 | 作用 | 对我们 |
|---|---|---|---|
| `app/api/files/[...path]` | GET（type=list/read/download/meta/preview/watch）POST（upload/upload-check） | 文件浏览/读取/流式下载/DOCX 预览/SSE watch/上传 | **有用**（文件服务样板） |
| `app/api/file-index` | GET ?cwd=&q= | `git ls-files` 优先、readdir BFS 回退的文件索引，供 @ 补全 | **有用** |
| `app/api/project-trust` | GET / POST | 查询/授予项目信任（gate 仓库内扩展代码） | **有用**（安全） |
| `app/api/cwd/validate` | POST | 校验候选工作目录并 `allowFileRoot()` | 有用（若做目录选择） |
| `app/api/cwd/browse` | GET ?path= | 目录选择器的子目录列举（含 Windows 盘符） | 可选 |
| `app/api/home` | GET | 返回 `homedir()` | 无关 |
| `app/api/default-cwd` | POST | 创建 `~/pi-cwd-YYYYMMDD` 并允许访问 | 无关（面向无项目用户） |
| `app/api/push/config` | GET | 返回 VAPID 公钥（私钥不出服务端） | 可选 |
| `app/api/push/subscribe` | POST | 注册浏览器推送订阅（按 endpoint upsert） | 可选 |
| `app/api/models` | GET ?cwd= | 可见模型列表 + 默认模型 + thinking 层级（60s 缓存） | 可选 |
| `app/api/models-config` | GET / PUT | 读写 `~/.pi/agent/models.json` | 可选 |
| `app/api/models-config/catalog` | GET | 拉 models.dev 价格目录（1h 缓存 + in-flight 去重） | 无关 |
| `app/api/models-config/discover` | POST | 向自定义 provider 上游拉模型列表 | 无关 |
| `app/api/models-config/test` | POST | 临时 models.json 里 `completeSimple("Reply with OK")` 试连通 | 无关/可选 |
| `app/api/auth/login/[provider]` | GET（SSE）/ POST | OAuth/device-code 流式登录；POST 回传手动 code | 无关（SDK 特定） |
| `app/api/auth/api-key/[provider]` | POST / DELETE | 存/删 provider API key（经 `AuthStorage`） | 无关 |
| `app/api/auth/logout/[provider]` | POST | 删 OAuth 凭据（类型不匹配返回 409） | 无关 |
| `app/api/auth/providers` | GET | OAuth/API-key provider 两个列表（能力驱动 #309） | 无关 |
| `app/api/git/status` `git/diff` | GET | `git status` / 单文件 diff | 无关/可选 |
| `app/api/worktrees` | GET / POST / DELETE | worktree 列举/创建/删除（脏目录 409） | 无关 |
| `app/api/plugins` | GET / POST | 包插件管理（SettingsManager + DefaultPackageManager） | 无关 |
| `app/api/plugins/check` | POST | 检查插件更新 | 无关 |
| `app/api/skills` | GET / PATCH | 列技能；PATCH 只改 `SKILL.md` 的 `disable-model-invocation` | 无关 |
| `app/api/skills/check` `update` | POST | 检查/更新技能（`npx skills update`） | 无关 |
| `app/api/skills/install` | POST | `npx skills add <pkg> -y --agent pi`（项目安装要求已信任） | 无关 |
| `app/api/skills/search` | POST | skills.sh API 优先，`npx skills find` 回退 | 无关 |
| `app/api/subagents/[id]` | GET / POST(steer/abort) | 子代理运行状态与操控 | 无关 |
| `app/api/subagents/settings` | GET / PUT | `builtInEnabled` 开关 | 无关 |
| `app/api/subagents/profiles` | GET/PUT/PATCH/DELETE | 子代理 profile CRUD | 无关 |
| `app/api/tools/settings` | GET / PUT | Windows PowerShell 工具开关 | 无关 |
| `app/api/app-update` | GET | 对比 npm registry 最新版（12h 缓存，`PI_WEB_SKIP_VERSION_CHECK=1` 可关） | 无关 |

共同模式（值得学的约定）：
- 几乎所有路由 `export const dynamic = "force-dynamic"`，禁缓存。
- 每个读写路由都先做 `getAllowedFileRoots()` + `isExistingFilePathAllowed(cwd)` 双重校验，403 统一文案 `"Access denied"`。
- 写操作路由额外做 `isApiRequestAllowed(req)` + `hasJsonContentType(req)`（415）。
- 全部返回 `NextResponse.json`，错误统一 `{ error: string }` + 5xx/4xx。

---

## 2. 认证与安全（重点）

### 2.1 入口：`proxy.ts`（Next.js 16 的 middleware 新名）

Next 16 把 `middleware.ts` 更名为 `proxy.ts`，导出函数叫 `proxy()`。匹配范围只有根页面和 API：

```ts
// proxy.ts:11-40
export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)          // API：Host + Origin 双查
    : isApiRequestHostAllowed(request);     // 页面：只查 Host

  if (!isTrustedRequest) {
    if (!isApiRequest) return new NextResponse("Untrusted request", { status: 403 });
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: { "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"' },
    });
  }
  return NextResponse.next();
}
export const config = { matcher: ["/", "/api/:path*"] };  // proxy.ts:42
```

顺序是**先信任校验后认证**：一个 Host 不合法的请求连 401 都拿不到（不泄露存在性）。

### 2.2 Basic Auth：`lib/web-auth.ts`

- 用户名**固定** `"pi"`（`PI_WEB_AUTH_USERNAME`，`web-auth.ts:3`）。
- 密码 = 环境变量 `PI_WEB_PASSWORD` **明文**，只在进程内存/env 中，**不落盘、不哈希存储**；不设该变量 = 完全不启用认证（默认本机单人使用的前提）。
- 校验细节相当讲究（`web-auth.ts:19-45`）：

```ts
const match = /^Basic\s+(\S+)$/i.exec(authorization);
if (!match) return false;
const decoded = Buffer.from(match[1], "base64");
if (decoded.toString("base64") !== match[1]) return false;   // 规范 base64，防填充歧义
credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);  // 非法 UTF-8 拒绝
...
function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));   // web-auth.ts:9-11
}
```

两侧都过一次 SHA-256 再 `timingSafeEqual`——因为 `timingSafeEqual` 要求等长 Buffer，先哈希把长度归一，同时保留常数时间比较（防时序侧信道）。用户名和密码**分别**比较且都需通过。

### 2.3 `lib/request-security.ts`：防什么？

161 行，防御三类攻击，**没有 CSRF token**，靠 Fetch Metadata + Origin 比对：

**① DNS rebinding / Host 头伪造**（`isApiRequestHostAllowed`）：

```ts
// request-security.ts:85-102
/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(request, configuredHostnames = ...): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;
  return configuredHostnames.some((configured) => ... === hostname);
}
```

白名单来源 = `PI_WEB_HOSTNAME` + `PI_WEB_ALLOWED_HOSTS`（逗号分隔，`request-security.ts:47-52`）。`hostnameFromAuthority` 解析时拒绝带 userinfo/path/query 的 authority（`request-security.ts:10-21`），防 `Host: user@evil.com` 这类混淆。

**② 跨站请求（CSRF 的现代替代）**（`isApiRequestOriginAllowed`，`request-security.ts:131-142`）：

```ts
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;      // 浏览器明确说跨站 → 拒
  if (!origin) return true;                          // 非浏览器客户端（curl/API）→ 放行
  const requestOrigin = getRequestOrigin(request);   // 由 Host + 协议推导
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;
  return isProxyRewrittenSameOrigin(request, origin);
}
```

- `sec-fetch-site: cross-site` 一票否决；
- 有 `Origin` 时要求它等于「Host + 请求协议」推导出的 origin；
- `isProxyRewrittenSameOrigin`（`request-security.ts:111-129`）专门处理「中继重写 Origin」（注释点名 Azure Dev Tunnels）：`x-forwarded-proto` 存在且 `sec-fetch-site: same-origin` 且 Origin 的 authority == Host 时放行；
- 用户**手动**点导出链接的顶级导航（`sec-fetch-user: ?1` + `navigate` + `document` 且路径匹配 `/api/sessions/:id/export`）豁免（`request-security.ts:68-83`）。

总入口 `isApiRequestAllowed`（`request-security.ts:148-155`）= Host 检查 +（仅当请求带 Origin/sec-fetch-site 时）Origin 检查。`hasJsonContentType`（157-161 行）在写路由强制 `application/json` 或 `*+json`，防 content-type 混淆 smuggling。

**没有 SSRF 防护**——它不主动抓用户给的 URL（skills search / models discover 抓的是固定域名），所以不需要。

### 2.4 文件 API 的路径穿越防御（三层）

**第一层：词法包含**（`lib/path-security.ts:10-23`，全仓库唯一实现，AGENTS.md 明说「Keep that one implementation — it is the security boundary」）：

```ts
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    ...
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) return true;
  }
  return false;
}
```

`resolver.resolve()` 归一 `..`，所以 `/root/../../etc/passwd` 解析后不再以 `/root/` 开头 → 拒。e2e 里就有断言：`await api("/api/files/..%2F..%2Fetc%2Fpasswd?type=read", 403)`（`e2e/run.mjs:147`）。

**第二层：符号链接穿透**（`isExistingPathWithinRoots`，`path-security.ts:25-42`）：目标 `realpathSync`，**每个 root 也 realpath**，再跑一次词法检查——允许根内的符号链接把访问引到根外。上传路径在 GET 授权之外又做了一遍（`files/[...path]/route.ts:103-118`）：

```ts
// A browsable directory can be a symlink. Resolve both sides before writes
// so a symlink inside an allowed root cannot redirect uploads outside it.
const realDirectory = fs.realpathSync(directory);
const realRoots = new Set<string>();
for (const root of allowedRoots) { try { realRoots.add(fs.realpathSync(root)); } catch {} }
if (!isFilePathAllowed(realDirectory, realRoots)) { ... 403 }
```

**第三层：root 从哪来**（`lib/file-access.ts:20-49`）：会话 cwd + worktree 的 `projectRoot` + `~/pi-cwd-YYYYMMDD` + 显式 `allowFileRoot()`（`lib/allowed-roots.ts`，存 `globalThis` 抗热重载）。带 5 秒 TTL 缓存（否则每个请求全盘扫描会话目录）。**明确设计立场**：「`/api/files` is intentionally not a general filesystem browser」（AGENTS.md §File access allow-list）。

补充边界：
- 会话引用豁免：文件虽不在允许根内，但某会话内容中精确引用过它（UUID 校验 + 边界字符匹配，`lib/session-file-references-core.ts`）则可读——为聊天里出现的文件链接服务。
- 上传文件名验证（`lib/file-upload.ts:23-40`）：拒绝 `.`/`..`/`\0`/含 `/` 或 `\`/非 basename/重复名；写入用 `flag: "wx"`（不覆盖已存在，覆盖需先显式 `unlinkSync`）；体积限制 25MB/文件、100MB/请求（multipart 总线连边界一起限，`lib/bounded-form-data.ts:17-52` 手写流式限量解析——因为 `Content-Length` 在 chunked 下不可信）。
- SVG 被当文档执行的风险单独处理（`files/[...path]/route.ts:307-316`）：SVG inline 预览加严格 CSP `default-src 'none'` + `nosniff` + `no-referrer`，注释直说「repo-controlled SVG … would otherwise run script in the Pi Web origin, where it can call any /api route」。

### 2.5 project-trust 机制：为什么需要

`lib/project-trust.ts:23-39` 的注释就是完整动机：

```ts
/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true...
 * Pi Web and the `pi` CLI share the same trust store.
 */
```

机制要点：
- 判定「是否含需信任资源」用 SDK 的 `hasTrustRequiringProjectResources(cwd)`；普通项目不弹任何东西。
- 信任记录存 SDK 的 `ProjectTrustStore`（`~/.pi/agent` 下），**与 pi CLI 共享**——CLI 里信任过的项目在 Web 里也信任。
- 三处消费：`rpc-manager.ts:1943`（创建 AgentSession 时）、`models/route.ts`（枚举模型也要 import 扩展，同样 gate）、`skills/install`（项目内装技能要求先信任）。
- POST 信任（`app/api/project-trust/route.ts`）：有活跃会话先 409（`hasBusyRpcSessionForCwd`），信任成功后 `destroyRpcSessionsForCwd()` 强制下次以信任态重建 wrapper + `invalidateModelsCache()`。

### 2.6 它对「Pi 官方无权限控制」的应对

**意识到了，且分层处理，但没有 OS 级隔离**。四层：

1. **网络层**：默认只听 `127.0.0.1`；非 loopback 监听时启动脚本直接打警告（`bin/pi-web.js`：有密码警告「Basic Auth over HTTP，用 HTTPS 或 VPN」，无密码警告「仅限可信网络」）；README 写明「监听非回环地址会暴露一个可执行高权限操作的智能体」。
2. **请求层**：§2.3 的 Host/Origin 信任体系（防的是浏览器侧攻击，不是 Pi 权限本身）。
3. **文件层**：允许根 allow-list（防 Web UI 变全盘浏览器）。
4. **代码执行层**：project-trust gate 仓库内扩展 + ADR-0001 清洗宿主环境变量。

**没有做的**：agent 的 `bash` 工具仍以启动用户的完整权限跑任意命令；没有沙箱、没有容器、没有命令过滤。它的答案本质是「这是本机单用户工具，信任模型 = 你自己」。我们的 ADR-0015（Docker 隔离部署）恰好补上它缺的第 5 层——如果要把它当部署参考，`PI_WEB_PASSWORD` + 反向代理 HTTPS 是它的官方上限，权限隔离要我们自己加。

---

## 3. 启动与部署

### 3.1 `npx @agegr/pi-web` 完整流程

npm 包 `files` 字段直接发布**预构建产物**：`bin`、`.next`（排除 cache/dev/sourcemap）、`public`、`next.config.ts`（`package.json:20-29`）。用户 npx 拉包后：

```
bin/pi-web.js
  ├─ bin/node-version.js      Node >= 22.19.0 检查，不符即退出（MIN_NODE_VERSION 硬编码）
  ├─ bin/pi-web-options.js    parseArgs(strict) 解析 -p/-H/--no-open/-h；
  │                           优先级：CLI 参数 > PORT / PI_WEB_HOSTNAME > 默认 30141 / 127.0.0.1
  ├─ 校验 .next 存在（"Build artifacts not found. Please report this issue."）
  ├─ 非 loopback 监听 → 控制台警告（见 §2.6）
  ├─ require.resolve("next/dist/bin/next") 直接定位 next 的 JS 入口
  │   （注释：避免 .bin 符号链接在 npx 安装下不存在的问题）
  ├─ spawn(process.execPath, [nextBin, "start", "-p", port, "-H", hostname],
  │        { cwd: pkgDir, env: { ...process.env, PI_WEB_HOSTNAME: hostname } })
  ├─ bin/process-lifecycle.js wireChildProcessLifecycle：
  │    SIGINT/SIGTERM 转发给子进程，5s 超时 SIGKILL；
  │    子进程意外退出打印原因并以 128+signal 退出；两次 Ctrl+C 强杀
  └─ 监听子进程 stdout，出现 "Ready" 且未 --no-open →
     按平台 spawn cmd /c start "" url | open url | xdg-open url
     （全程无 shell:true，注释引 DEP0190：避免参数被 shell 解释）
```

浏览器打开 `http://<hostname>:<port>`（默认 `http://127.0.0.1:30141`）。

### 3.2 端口 / host 配置

| 项 | CLI | 环境变量 | 默认 |
|---|---|---|---|
| 端口 | `-p, --port` | `PORT` | `30141` |
| host | `-H, --hostname` | `PI_WEB_HOSTNAME` | **`127.0.0.1`（默认只听本机）** |
| 开浏览器 | `--no-open` | `PI_WEB_NO_OPEN=1/true/yes/on` | 自动打开 |

**是的，默认仅监听 127.0.0.1**；`npm run dev` / `start` 脚本也都硬编码 `-H 127.0.0.1`，`dev:lan` / `start:lan` 才是 `0.0.0.0`。`PI_WEB_HOSTNAME` 同时被塞进子进程环境，供 `request-security.ts:49` 的 Host 白名单使用（`bin/pi-web.js:87`）。

### 3.3 `next.config.ts`（2152 字节，无 standalone）

```ts
const nextConfig: NextConfig = {
  outputFileTracingRoot: configDir,
  serverExternalPackages: [            // 关键：SDK 相关包不进 server bundle
    "undici", "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  allowedDevOrigins: ["127.0.0.1", "10.*.*.*", /* 172.16-31 / 192.168 */],  // dev server 的 LAN 访问
  async headers() { /* / 不缓存；/sw.js 加 Service-Worker-Allowed: /；manifest */ },
  env: { NEXT_PUBLIC_APP_VERSION: version, NEXT_PUBLIC_PI_VERSION: piVersion },  // 构建时读 package.json 注入
};
```

- **没有 `output: "standalone"`**——发布形态是「npm 包 + 预构建 `.next` + `next start`」。
- `serverExternalPackages` 是移植时必抄的一条：Pi SDK 及 undici 这类带原生/dynamic import 的包必须 external，否则 route handler 里行为异常。
- 版本号在构建时从 `package.json` 和 SDK 的 `package.json` 读出注入 `NEXT_PUBLIC_*`。

### 3.4 Dockerfile：没有

仓库内无 Dockerfile / compose / k8s 清单（`.github/workflows/ci.yml` 是唯一 CI）。它推荐的部署路径（README「远程访问」节）：

1. `PI_WEB_PASSWORD='<长随机密码>' pi-web --hostname 0.0.0.0`，仅限可信局域网；
2. 公网必须「可信反向代理提供 HTTPS，或可信 VPN」；代理传递外部主机名时把该名字精确加进 `PI_WEB_ALLOWED_HOSTS`（白名单不改变监听地址）；
3. 出网代理：`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量（由 `instrumentation.ts` 装的 undici `EnvHttpProxyAgent` 消费）。

### 3.5 环境变量全集

**自有变量：**

| 变量 | 用途 | 默认 |
|---|---|---|
| `PI_WEB_PASSWORD` | Basic Auth 密码（用户名固定 `pi`） | 不设 = 无认证 |
| `PI_WEB_HOSTNAME` | 默认监听 host；同时进 Host 白名单 | `127.0.0.1` |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理/自定义主机名（逗号分隔，精确匹配） | 未设置 |
| `PI_WEB_NO_OPEN` | `1/true/yes/on` 禁自动开浏览器 | 开 |
| `PORT` | 默认端口 | `30141` |
| `PI_WEB_SKIP_VERSION_CHECK` | `=1` 关闭 app-update 版本检查 | 开 |
| `PI_CODING_AGENT_DIR` | Pi agent 数据目录（SDK 消费，e2e 用它做隔离 fixture） | `~/.pi/agent` |
| `SKILLS_API_URL` | skills 搜索 API 覆盖 | `https://skills.sh` |
| `GITHUB_TOKEN` / `GH_TOKEN` | skills 更新检查的 GitHub 凭据 | — |

**框架/传递变量：** `NEXT_PUBLIC_APP_VERSION`、`NEXT_PUBLIC_PI_VERSION`（构建注入）；`NODE_ENV`、`NEXT_RUNTIME`（instrumentation 判断 nodejs runtime）、`NEXT_TELEMETRY_DISABLED`（e2e 用）；`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（undici 代理）；`XDG_STATE_HOME`（skill-lock 锁文件位置）。

**内部子进程临时设置（非配置）：** `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`（导出时调 pi CLI）、`LC_ALL=C`（git 输出稳定性）、`FORCE_COLOR=0`（npx 输出去色）、`GIT_TERMINAL_PROMPT=0`（git 不交互）。

### 3.6 `instrumentation.ts`（212 字节但很关键）

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}
```

Next.js 的 server 启动钩子（仅在 Node runtime）装全局 undici dispatcher：`EnvHttpProxyAgent`（吃 HTTP_PROXY 系变量）+ 300s idle/header 超时 + 每个连接包一层 error listener——注释说明 undici 在终止响应体时会 emit 内部 error，不兜住会把整个 Next 进程带崩（`lib/http-dispatcher.ts:27-35`）。**我们要在容器里出网走代理的话这段直接抄**。

---

## 4. 它自己的架构决策（ADR 全读）

`docs/adr/` 共 3 篇，都很短（每篇 1 屏）：

### ADR-0001 isolate-project-command-environments

- **内容**：Web 宿主给项目命令（agent `bash` 工具、用户 `!`/`!!` 直接 shell）的环境做清洗——剥离 `PORT`、`NODE_ENV`、所有 `NEXT_*`，保留 SDK 管理的 PATH、Pi 会话元数据及其余继承值；显式设置的项目命令变量仍然生效。第三方扩展自己的子进程不拦截。
- **为什么**：项目命令不该看到宿主 Next 运行时的变量（`PORT` 尤其危险——项目里的测试/脚本可能尝试起服务占同一个语义端口）。
- **对应我们**：Docker 里 web 宿主与 agent 同容器时，这个「环境渗漏」问题同样存在，值得沿用。

### ADR-0002 chat-only-tool-selection

- **内容**：空 `tools` 数组 ≠ 普通会话，而是显式「Chat only」策略：不加载扩展/skills/prompt 模板/主题，系统 prompt = Pi 默认 loader 发现的上下文文件有序内容（AGENTS.md/CLAUDE.md 等），Web 不加自己的前后缀。持久化靠版本化 custom entry `pi-web:tool-selection`（`data:{version:1,tools:[]}`），无 entry = 旧会话走 Pi 默认，空数组 = Chat only。
- **踩坑记录（对 Pi 版本升级最有价值）**：
  - 选择必须在 `createAgentSessionServices()` **之前** resolve，否则 Chat only 会 import 并执行会话扩展；
  - 精确系统 prompt 必须在 Pi 的 `before_agent_start` 阶段**之后重打**——SDK 在模型调用前一刻重建 base prompt；
  - 跨 Chat-only 边界必须 append 新 entry 并**重建 wrapper**（已加载资源的 wrapper 无法原地关掉资源）；
  - Pi 原生会话格式**不持久化** tool 选择——这是 Web 层的补丁，说明 SDK 在此有缺口。

### ADR-0003 built-in-subagent-toggle

- **内容**：内置子代理是一个**内联隐藏扩展**，全局开关 `~/.pi/agent/agents/settings.json` 的 `builtInEnabled`（缺省 false，malformed fail-closed）。factory 始终安装（让 reload 能切换）但禁用时注册 0 个工具；运行期再查一次开关防陈旧 tool call。启用时压制识别为 legacy `pi-subagents` 且注册了保留名（`Agent`/`get_subagent_result`/`steer_subagent`）的扩展，禁用时不压制。
- **为什么**：开关切换不销毁已有 wrapper、已有子会话仍可读、正在跑的子代理不被中断——状态迁移的完整设计。

### 「为什么选 Next.js」「为什么选 SSE」——没有 ADR

如实说：**两篇都没有 ADR**。只能从代码与 AGENTS.md 推断：

- **Next.js 的证据**：单仓单应用（无独立前端目录）；`serverExternalPackages` 表明深度依赖 route handler 运行时；AGENTS.md 记录了大量「Next.js 热重载会丢模块级状态」的坑及 `globalThis` 对策（rpc-manager、allowed-roots、各缓存全部挂 `globalThis`）；开发图绑定 Turbopack（`next dev --webpack` 在 undici import 上会挂，AGENTS.md 明令不要用）；PWA（`sw.js`、manifest）。这像「先选了 Next 全栈再适配」，而非权衡后的决策记录。
- **SSE 的证据**：AGENTS.md 架构图即 SSE（`GET /api/agent/[id]/events` + `POST` 命令，命令与事件通道分离）；OAuth 登录流也用 SSE；`agent-event-connection.ts` 做被动重连 + 30 秒 grace 窗口 + 运行状态轮询对账。选择动机可推断为：Next route handler 原生支持流式 Response（WebSocket 需要自定义 server / upgrade 处理，与 `next start` 托管部署不兼容）、事件单向推送够用、EventSource 自带重连语义。
- **踩坑记录**主要不在 ADR 而在 **AGENTS.md 的 "Key Design Decisions & Traps"**（19.8KB），高价值条目：
  - `globalThis.__piSessions` + idle 10 分钟 + `__piStartLocks` 并发启动去重；
  - **fork 会原地变异 wrapper 内部状态**（`inner.sessionId` 变成新 id），不立即 destroy 会产生损坏的 `parentSession` 链；
  - `parentSession` 头字段仅是显示元数据，整文件 `writeFileSync` 重写安全；
  - toolCall 字段名在文件格式（`id/name/arguments`）与类型（`toolCallId/toolName/input`）间不一致，`normalizeToolCalls()` 两侧都要调；
  - compaction 事件新旧两套事件名并存兼容；
  - 深会话导出 HTML 的递归改迭代防栈溢出；
  - Windows 路径比较必须 `samePath()` 不能 `===`（git 输出 POSIX 风格 + 盘符大小写）；
  - `#307` enabledModels glob 不能字面比较、`#309` 双 auth provider 会被列两次、`#236` project-trust——**issue 号直接写进注释，可溯源**。
- **CONTEXT.md** 是四词统一语言（Ubiquitous Language）：Host Runtime Environment / Project Command Environment / Built-in Project Shell，每个词给出 Avoid 列表——典型的 DDD 术语表，防 AI/贡献者混用概念。

---

## 5. 工程配置

### 5.1 TypeScript（`tsconfig.json`）

- `strict: true`（含 noImplicitAny/strictNullChecks 等）；**没有** `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noUncheckedSideEffectImports` 等更狠的档位。
- `target: ES2017`、`moduleResolution: "bundler"`、`isolatedModules`、`noEmit`（tsc 只做类型检查，Next 自己编译）、`paths: {"@/*": ["./*"]}`、`allowJs` + `skipLibCheck`。
- 类型检查独立于构建：CI 单独跑 `npx tsc --noEmit`；日常开发「不要跑 next build」（会污染 `.next` 干扰 dev server，AGENTS.md 反复强调）。

### 5.2 ESLint（`eslint.config.mjs`，flat config）

就是 `eslint-config-next` 的 `coreWebVitals` + `typescript` 两个预设原样铺开，外加关闭三条 React Compiler 时代的新规则：

```js
rules: {
  "react-hooks/immutability": "off",
  "react-hooks/refs": "off",
  "react-hooks/set-state-in-effect": "off",
}
```

没有任何自定义命名/复杂度规则。纪律靠 code review 与 AGENTS.md，不靠 lint。

### 5.3 测试策略

- **单元/集成**：**150 个 `*.test.mjs`**，与源码同目录共置（`lib/foo.ts` 旁边就是 `lib/foo.test.mjs`）。用 `node --test` 原生 runner 跑：`node --experimental-strip-types --test "app/**/*.test.mjs" ...`（`package.json:38`）——**零测试框架依赖**（无 jest/vitest），TS 源码靠 Node 的类型剥离直接被 import。另有 1 个 bench（`session-list-scanner.bench.mjs`）。
- **e2e**：单文件 `e2e/run.mjs`（268 行）+ Playwright chromium。特点：
  - 自起服务器（dev 或 `E2E_SERVER_MODE=start` 对 `next start`），端口用 net server 探测空闲后释放再复用；
  - **启动前 seed fixture** 到临时 `PI_CODING_AGENT_DIR`（mkdtemp），5000 条消息长会话、分支会话、toolcall 会话、压缩会话，跑完 `rmSync`；
  - 无模型凭据、无真实 Pi 会话——**只测只读路径**：分页（`before`/`tail` 参数、无 gap 无重复）、分支上下文、markdown/toolcall 渲染、`/api/files/..%2F..%2Fetc%2Fpasswd → 403`、未知会话 404、压缩锚点导航、桌面+移动两视口零浏览器错误；
  - 「发送 prompt / 流式 / agent 执行不在本套件内」——明确边界声明。
- **CI**（`.github/workflows/ci.yml`）：两个 job——`checks`（lint + tsc + test，15 分钟超时）与 `e2e`（干净 checkout `npm run build` 后 `E2E_SERVER_MODE=start` 跑 Playwright，失败上传 `test-results/e2e/` 工件）。

### 5.4 i18n 方案

**零依赖自研**（`docs/i18n.md` 明说「intentionally kept inside the application instead of introducing another runtime dependency」）：

```
lib/i18n/
  types.ts        15 行   Locale = "en" | "zh-CN" | "zh-TW"；LocalePlugin { id, label, messages }
  registry.ts     41 行   插件注册表 + resolveBrowserLocale（zh-Hans/zh-SG→zh-CN，zh-HK/MO/Hant→zh-TW）
  format.ts       60 行   translateMessage（locale→en→key 三级回退，dev 模式警告缺 key）
                          + interpolateMessage（{param} 占位符）+ Intl.RelativeTimeFormat
  messages/en.ts|zh-CN.ts|zh-TW.ts   各 604 行扁平 "namespace.key": "text" 字典
hooks/useI18n.tsx        I18nProvider + useI18n；localStorage["pi-locale"] 持久化，
                         首开按 navigator.languages 解析，document.documentElement.lang 同步
```

- 翻译文件是**静态 import 的 TS 模块**（非 JSON、无 ICU 库）；新增语言 = 新建 messages 文件 + registry 数组加一项 + types union 加一个 id。
- 服务端也用（web-push 推送文案按订阅时上报的 locale 选语言，`lib/web-push.ts:97-104`）。
- 贡献规范明确：产品名/命令/路径/工具输出**不翻译**；API 错误不做英文文本匹配式翻译，只包本地回退文案。

---

## 6. 对我们有用的基础设施清单

### 直接拿走（高价值，低耦合）

| 模块 | 拿什么 | 备注 |
|---|---|---|
| `proxy.ts` + `lib/request-security.ts` + `lib/web-auth.ts` | 整套请求信任 + Basic Auth | 三个文件互相仅依赖彼此与 `node:net/crypto`，几乎可原样拷贝。**Docker 部署下仍需要**（容器内相邻服务的 Host/Origin 校验价值降低，但防跨站与代理重写的逻辑保留） |
| `lib/path-security.ts` + `lib/file-access.ts` + `lib/allowed-roots.ts` | 路径包含检查 + 允许根管理 | `isPathWithinRoots` 是它们自认的「single security boundary」，抄一份并保持唯一实现。5s TTL + globalThis 缓存模式一并抄 |
| `lib/project-trust.ts` | 信任 gate | 若我们沿用 pi 的 `ProjectTrustStore`，整个文件可复用；**前提是我们也接受「打开仓库 = 可能执行仓库代码」这一模型**——否则 Docker 方案下此问题由隔离消解，只需保留 UI 提示 |
| `lib/file-fuzzy.ts` + `app/api/file-index/route.ts` | @ 文件补全全套 | 189 行纯函数（评分阶梯 exact/prefix/substring/path-substring/subsequence + 目录 drill-down + `@"quoted path"` 语法）+ git ls-files/BFS walk/globalThis 缓存。做聊天输入的 @ 引用直接用 |
| `lib/bounded-form-data.ts` | 52 行 | 手写流式 multipart 限量解析，防 chunked 请求绕过 Content-Length 限制 |
| `lib/atomic-file.ts` | 25 行 | `writePrivateFileAtomicSync`：0600 权限 + 临时文件 + rename 原子写。存任何敏感 JSON（凭据/推送状态）都该用 |
| `lib/npx.ts` | ~70 行 | 跨平台无 shell 调 npx（Windows 直接找 `npx-cli.js` 用当前 node 执行）。我们要在服务端跑任何 npm CLI 时用 |
| `instrumentation.ts` + `lib/http-dispatcher.ts` | undici 全局代理 + 超时 + 错误兜底 | 容器内出网走代理、防 undici 内部错误杀进程，一并带走 |
| `lib/paths.ts` | `toNativePath` / `toSlashPath` / `samePath` / `isWindowsAbsolutePath` | 若需 Windows 兼容则必抄；纯 Linux 部署可简化 |
| `bin/` 三脚本 | npx CLI 启动器模式 | 仅当我们也发 npm 包（node 版本门禁、参数解析、信号转发、无 shell 开浏览器都有细节坑已解） |
| e2e 模式 | `run.mjs` 的「探端口→自起服→seed 临时 fixture→断言→清理」骨架 | 换成我们的路由即可复用整个结构 |
| i18n 三件套 | registry/format/types + provider | 60 行运行时 + 每语言一 TS 文件；比引 next-intl 轻 |
| 文档实践 | ADR + AGENTS.md（Traps 小节）+ CONTEXT.md（术语表） | 「把踩坑与 issue 号写进注释和 AGENTS.md」这个习惯本身值得移植 |

### 模式复用（不抄代码，抄思路）

- `globalThis.__piXxx` 挂一切热重载敏感状态（Next dev 的硬约束，我们也用 Next 就逃不掉）；
- `models-cache.ts` 的缓存三件套：TTL + in-flight Promise 去重 + **generation 计数失效**（写操作后整个代作废）——任何「读昂贵、写后必须立刻可见」的缓存都适用；
- 路由层「词法检查 + realpath 检查」双段式，及「403 统一文案不泄露原因」。

### 无关（Pi 生态专属或我们不需要）

`auth/*` 四个路由（OAuth/API key 是 pi 的 ModelRuntime 体系）、`models-config/{catalog,discover,test}`、`skills/*` 五个、`plugins/*` 两个、`subagents/*` 三个、`worktrees`、`git/{status,diff}`、`app-update`、`tools/settings`（Windows PowerShell）、`default-cwd`/`home`、`project-tree.ts`（会话分支树投影，属聊天 UI 域）、`web-push.ts`（可选，需要 Service Worker 与 `web-push` 依赖，教学场景价值存疑）、`model-catalog.ts`/`model-scope.ts`（若我们不暴露模型配置面板则不需要；若需要则 `model-scope.ts` 是「必须委托 SDK resolver 而非自实现 glob」的重要前车之鉴，#307）。

---

## 附：与本报告相关的交叉引用

- ADR-0015（我们）：Docker 部署补的正是 pi-web 缺的 OS 级隔离层（见 §2.6）。
- 区块 1 报告（`01-桥接层.md`）：rpc-manager / SSE 层的移植清单。
- pi-web 源码可溯源 issue：#236（project-trust）、#307（enabledModels glob）、#309（双 auth provider）、#617/#599（e2e 脚本来源）。
