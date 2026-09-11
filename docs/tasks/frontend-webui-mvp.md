# PRD：前端 WebUI MVP（React + Vite + Tailwind）

> 任务简称：frontend-webui-mvp
> 状态：待用户审查，尚未开始实现
> 日期：2026-09-08
> 前置：backend-host-mvp（commit `4006891`）
> 视觉基准：`/workspace/pi-teacher/前端模板`
> 研究依据：优先阅读 `docs/pi-web-研究/`，再按需核对 pi-web MIT 源码 `/tmp/pi-web`
> 相关架构决策：ADR-0025、ADR-0030、ADR-0022、ADR-0024

## 1. 目标

为已经完成的 Express 后端宿主提供真实可用的 React WebUI，完成以下闭环：

```text
登录/首次设置密码
  → Space 收纳箱与 Pi Session 树
  → 新建学习/复习 Pi Session
  → 流式对话
  → 上传资料并在对话中引用
  → AI 提议 Card
  → 右侧快速审批 / 管理面板编辑与回收
  → 复习 Pi Session
```

前端不使用静态假数据伪装后端能力。没有 API 能力的模板按钮不实现为假功能；本任务需要的附件、模型查询/切换、Space/Pi Session 新 Schema 等后端能力一并补齐。

## 2. 已确认的产品决策

### 2.1 领域模型

```text
space（唯一收纳容器）
├── type = learn：用户创建的学习 Space
├── type = review：id=1，全局唯一复习 Space
└── type = ta：id=0，全局唯一助教 Space

pi_session（一次具体对话）
└── space_id → space.id
```

- 删除 `session` 表；不再保留 `session_id`。
- `space` 只负责聚类，不拥有共享工作目录。
- 每条 `pi_session` 独占 `work_path`、`AGENTS.md`、`style.md`、JSONL 和私有产出。
- `space.id=0` 固定助教 Space，初始化时直接创建唯一固定助教 Pi Session 与目录。
- `space.id=1` 固定复习 Space，允许多个复习 Pi Session。
- `ta` / `review` 的名称、类型、身份不可编辑和删除；学习 Space 可重命名、删除；Pi Session 不跨 Space 移动。
- 项目尚未上线，旧数据库和旧 JSONL 直接破坏性重建，不提供迁移。
- `space.type` 必须与 `agents_md.type` 匹配；`review_topic_id` 只允许出现在 `review` Space 的 Pi Session。

### 2.2 视觉与布局

以 `/workspace/pi-teacher/前端模板` 的 Atelier Mind 风格为准：

- Inter + Newsreader + JetBrains Mono 字体组合；
- 暖白纸张色、深 slate 主色、sage 辅助色；
- 桌面三栏：左侧 Space/Pi Session 树、中间主对话、右侧 Card Proposal + 固定助教；
- 本阶段只实现桌面版工作台，不实现移动端布局与交互；移动端设计完成后另立任务。

### 2.3 左侧导航

- 两级可折叠树：`Space → Pi Session`。
- 助教 Space 不在左侧出现，唯一入口是右侧下方固定助教。
- 点击 Space 只展开/收起，不自动打开最近 Pi Session。
- 学习 Space 标题 `+`：直接打开学习类型的新建 Pi Session 面板。
- 复习 Space 标题 `+`：直接打开复习类型的新建 Pi Session 面板。
- 第三个全局 `+`：打开通用新建面板，由用户选择学习或复习。
- 卡片管理中的“新建 Card”不是 Pi Session 入口，放在管理面板的 Card 子页。
- 复习 Space 展开后同时展示 Topic 快捷入口和历史复习 Pi Session；Topic 点击进入复习新建面板并预选 `review_topic_id`；“全部”表示 `review_topic_id = null`。

### 2.4 新建 Pi Session

统一面板先选择活动类型，再展示对应字段；助教不可创建。

学习：

- 当前学习 Space（从入口自动带入；全局入口由用户选择）；
- `agents_md`：只列 `type=learn`；
- `teach_style`：可选；
- `enable_make_card`：默认开启。

复习：

- 固定复习 Space，不让用户选择其他 Space；
- `agents_md`：只列 `type=review`；
- `teach_style`：可选；
- Topic：全部或指定 Topic；
- `enable_make_card`：默认开启。

创建成功后立即进入新 Pi Session 对话。创建 API 不接收模型字段；模型通过模型查询接口展示并用 `set_model` command 修改当前 Pi Session。

### 2.5 主对话

必须实现：

- Markdown + GFM + KaTeX + Mermaid；
- `normalizeDisplayMath` 公式兼容层；
- HTML sanitize，顺序保持 `rehypeRaw → rehypeSanitize → rehypeKatex`；
- 思维块折叠；
- 工具调用折叠、参数预览、结果与错误状态；
- `toolResult` 按 `toolCallId` 配对到工具调用，不单独渲染；
- 超过 100,000 字符的 Markdown 降级为可展开纯文本；
- 历史懒加载与加载旧消息时滚动位置不跳；
- 用户上滚阅读历史时不被流式输出强制拉回底部；
- IME 输入保护；
- 草稿恢复；
- 图片附件；
- `@` 文件引用；
- 斜杠命令；
- steer/follow-up；
- 桌面端输入与窗口交互；移动端键盘适配不在本阶段范围内。

复用 pi-web 的优先级：

1. `streaming-message.ts` 等纯函数直接移植；
2. `MessageView` 三层分发、`React.memo` 自定义比较器、工具结果 Map 配对直接复用后按 pi-teacher 类型裁剪；
3. `ChatInput` 的 IME、草稿、图片、`@`、斜杠、steer/follow-up 逻辑裁剪移植；
4. 样式结构以模板为准，不把 pi-web 的灰蓝配色原样覆盖 Atelier Mind。

### 2.6 SSE 与会话回收

采用 pi-web 的 reducer + 原生 `EventSource`：

- 连接成功收到 `connected` 后，清理旧的流式临时状态并调用 `GET context` 做权威同步；
- `message_start` / `message_update` 更新当前流式 assistant 消息；
- `message_end`、`prompt_done`、`agent_settled` 后刷新权威 context 与列表状态；
- EventSource 原生被动自动重连；页面显示连接中、已连接、重连中、已回收状态；
- 后端没有 Last-Event-ID/replay cursor，重连后不能假设事件补发；
- `command` 或 `events` 返回 404 时，停止该 Pi Session 的当前连接，提示“Pi Session 已回收，请重新打开”，不自动创建新对话；
- 重新从树中打开时，后端按稳定 `pi_session.id` 找到真实 JSONL 路径并恢复 wrapper；前端不暴露绝对路径，不使用临时 UUID。

### 2.7 右侧栏

上半部：

- 展示全局 `status=proposed` Card Proposal；
- 支持按 Topic 筛选；
- 不声称 Card 来自当前主对话；
- 快速翻面、确认、拒绝；
- 全屏/详细管理入口跳转到一体化管理面板的 Card 子页。

下半部：

- 复用全局唯一固定助教 Pi Session；
- 助教不自动获得当前主对话上下文；
- 发送按钮旁提供“一次性发送并注入当前主会话简介”；
- 注入只在用户点击该按钮的这一轮发生。

### 2.8 管理面板

左下角“系统设置”打开一个一体化管理面板/落地式大面板，不拆成多个互不相干的页面；面板内部使用 Tab 或子导航切换：

- Card：全部、待审批、正常卡、回收站；新建、编辑、确认、拒绝、删除、恢复；
- Glossary：提议/正常/删除状态的真实数据管理；
- Topic：列表、创建/编辑、`request_retention`、`maximum_interval`；
- Agents Md：按 `learn` / `review` / `ta` 分类编辑；
- Teach Style：列表与编辑；
- Card 编辑、回收站、Topic FSRS 参数编辑全部进入首版。

右侧栏仍只做 Card Proposal 快捷操作与固定助教，不复制完整管理逻辑。

系统设置与帮助可使用普通 Modal；管理面板本身不是假数据弹窗，所有操作连接真实 API。

### 2.9 认证页

- 登录页与首启动设置密码页采用 Atelier Mind 令牌、字体和背景；
- 使用全屏背景 + 居中认证卡；
- 不套三栏工作台；
- 首启动由 `GET /api/auth/status` 判断，空 user 表进入设置密码页。

## 3. 前端工程

新增 `web/` 独立包：

```text
web/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    app/
    components/
    hooks/
    lib/
    styles/
    types/
```

固定技术：

- React + TypeScript + Vite + Tailwind；
- `react-router-dom`；
- 状态管理只用 React hooks/context，不预装 Redux/Zustand；
- API 统一封装 fetch、cookie 同源请求、错误归一化；
- dev：Vite `/api` proxy → Express；
- prod：Express serve `web/dist`，非 `/api` 路径提供 SPA fallback；
- 页面必须支持刷新、浏览器后退/前进和直接访问管理面板入口。

建议路由：

```text
/login
/setup
/app
/settings
```

主应用的当前 Space/Pi Session 状态由 React Router + 前端状态维护；固定助教使用稳定 `pi_session.id` 作为内部身份。

## 4. 后端契约与新增 API

### 4.1 Schema 与现有 API 重构

后端先于前端联调完成破坏性 Schema 重建：

- 删除 `session` 表；
- `space` 变为收纳容器，字段含 `id/type/name/created_at`；
- 固定 `space`：id=0 ta、id=1 review；`type` 唯一约束保证 ta/review 单例；
- `pi_session` 删除 `session_id`，保留 `space_id`，新增 `work_path`；
- `pi_session.space_id=0` 增加 partial unique index，保证固定助教只有一条；
- 初始化时创建 ta/review Space、可用内置 `agents_md`/`teach_style` 种子，并创建固定 ta Pi Session 与目录；
- 创建 Pi Session 时事务内校验 Space 类型、模板类型、复习 Topic 约束；
- 所有路由、工具上下文、目录生成和验证脚本从 `space.type` 读取业务类型，不用数字推断类型；
- 不迁移旧 DB，不兼容旧 `session` 表。

### 4.2 对话 API

保留现有 `/api/conversations` 族路径，但将寻址逐步改为稳定 `pi_session.id`；后端内部由 id 查询 `path`，绝对路径不返回前端。

至少支持：

- Space 列表与其 Pi Session 列表；
- 创建学习/复习 Pi Session；
- 获取 context；
- command；
- SSE events；
- 关闭/重新打开；
- `set_model`。

### 4.3 模型 API

新增：

- `GET /api/models`：读取当前部署可用模型，返回 provider、model id、展示名及当前默认值；
- `POST /api/conversations/:id/model` 或统一走 command：调用 `set_model` 修改当前 Pi Session；
- 模型列表不可包含密钥、完整 provider 配置或内部凭据。

### 4.4 附件与文件引用 API

新增真实附件接口：

- `POST /api/conversations/:id/attachments`：上传文件到当前 Pi Session 的 `work_path/attachments/`；拒绝路径穿越和覆盖冲突；返回文件 id、相对路径、文件名、MIME、大小；
- `GET /api/conversations/:id/attachments`：列出当前 Pi Session 已上传文件；
- `GET /api/conversations/:id/attachments/:name`：读取/下载当前 Pi Session 附件；
- `GET /api/conversations/:id/file-index?q=`：供 `@` 补全使用。

文件访问策略：

- 应用层不把 Pi Session 当作安全沙箱，不阻止 AI 访问容器内其他目录；
- 上传接口仍只把用户上传文件落到当前 Pi Session 的 `attachments/`；
- 远程执行隔离由既有 skill 负责；
- HTTP 上传/下载接口保留基本的文件名校验、路径穿越防护和请求大小限制，防止接口自身被误用。

## 5. 助教模板与初始化

初始模板已写入：

`提示词设计/提示词模板/agentsmd/助教.md`（2026-09-11 起改为 `server/src/prompts/defaults.ts` 的 `AGENTS_MD_TEMPLATES.ta`，原文件已删除）

内容原则：

- 只答疑，不推进课程；
- 不制卡、不修改 Card、不发起复习；
- 当前主会话摘要只有用户点击注入按钮时才可见；
- 使用中文，尊重用户回答深度偏好；
- 可按需读取用户明确提供的资料。

初始化过程必须保证：

```text
initializeSchema
  → seed fixed Space rows
  → seed ta agents_md row from 助教.md
  → seed fixed ta pi_session row
  → create ta/<pi-session-id>/ directory
  → project AGENTS.md/style.md
```

初始化需要幂等；重复启动不得生成第二条 ta Pi Session。

## 6. 文件与业务权限边界

必须区分两种概念：

1. **工具业务权限**：由 `SessionToolContext` 和工具可见性矩阵控制。
   - 助教禁止制卡、删除/合并 Card、复习写入等业务操作；
   - `enable_make_card` 控制学习/复习对话的制卡工具；
   - Space/type 与模板类型由后端校验。
2. **文件/进程系统权限**：本项目不实现 Pi Session 级路径沙箱。
   - Docker 容器是部署边界；
   - 远程沙箱 skill 是执行隔离边界；
   - AI 是否能访问容器内其他目录不由 WebUI 的 `space_id` 再限制一次。

## 7. 实现顺序

1. **后端 Schema 重建**：删除旧 `session` 模型，加入 Space 容器、Pi 独占目录、ta 初始化与约束；
2. **后端 API 对齐**：重写 Space/Pi Session 路由、目录投影、工具上下文、验证脚本；
3. **附件与模型 API**：先用真实文件、真实模型配置验证；
4. **web 工程骨架**：Vite、React Router、Tailwind、Atelier Mind tokens、认证路由；
5. **主布局**：桌面三栏、Space/Pi Session 树；本阶段不实现移动端折叠；
6. **对话管线**：SSE reducer、Markdown、消息块、输入框、历史懒加载；
7. **Card/助教侧栏**：全局 Proposal 池、Topic 筛选、固定助教与一次性上下文注入；
8. **管理面板**：Card、Glossary、Topic、Agents Md、Teach Style 全部真实 CRUD/编辑；
9. **真实联调与验收**：认证 → 创建 Space → 创建 Pi Session → 上传附件 → 对话/SSE → Card 审批 → 管理面板 → 助教注入 → 模型切换。

## 8. 验收标准

### 后端

- 新库初始化产生固定 ta/review Space；
- 产生且只产生一条固定 ta Pi Session；
- 多次初始化幂等；
- 同一 Space 下多个 Pi Session 的 `AGENTS.md`、`style.md`、JSONL 互不覆盖；
- Space/type/template/review topic 校验正确；
- 旧 `session` 表不存在；
- 附件真实落盘到对应 Pi Session；
- 模型查询不泄露密钥；
- 原有真实模型验证面重做并全绿。

### 前端

- 首启动设置密码、登录、登出可用；
- Space/Pi Session 两级树可展开、收起和切换；
- 三个新建入口语义正确；
- 学习、复习对话创建成功后立即进入；
- SSE 流式消息、断线重连、404 回收提示正确；
- Markdown/KaTeX/Mermaid/思维块/工具调用正常；
- IME、草稿、附件、`@`、斜杠命令、steer/follow-up 正常；
- 全局 Proposal 池可按 Topic 筛选并审批；
- 管理面板所有首版子类真实可操作；
- 固定助教复用同一 Pi Session，注入按钮只在用户点击时生效；
- 模型选择器查询并切换当前 Pi Session 模型；
- 桌面端布局与交互无明显阻塞；
- 不出现模板中没有后端支持的假功能反馈。

## 9. 暂不实现

- 日历与学习热力图；
- 语音输入；
- 知识图谱；
- PWA 推送与浏览器通知；
- 多用户；
- Space 级共享文件目录；
- 移动端布局与交互（待后续完成移动端设计后另立任务）；
- Pi Session 级应用权限沙箱（Docker/远程沙箱由外部边界负责）。
