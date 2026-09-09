# WebUI 编辑 Pi 模型与 Provider 配置的边界与 secret 处理

- 状态：已采纳
- 日期：2026-09-09
- 相关：ADR-0022（单用户）、ADR-0025（技术栈）、ADR-0029（用户资源位置）

## 背景

产品要求在界面里配置模型与 provider，否则用户必须手工编辑 `~/.pi/agent/models.json` 才能换模型。但这个文件同时保存 API key、自定义请求头等凭据，而 `settings.json` 还保存着 Pi 自己管理的其他设置。把这类文件交给 WebUI 编辑，风险集中在三处：凭据外泄、写坏文件、以及「保存成功但没生效」。

## 决策

### 1. 单一收口：所有配置读写只经过 `server/src/config/pi-config.ts`

脱敏、白名单、原子写都只有一处实现。路由层只负责 HTTP 形状与鉴权，不直接触碰配置文件。这样「哪些字段可能是 secret」这个问题只需要在一个文件里回答正确。

### 2. 凭据只出布尔与固定掩码，永不出网

- `apiKey` 出口收敛为 `apiKeyConfigured: boolean`。
- 自定义请求头出口只有 `headerNames: string[]`，值一律不返回——头部的值同样可能是凭据。
- 脱敏 JSON 视图里，凭据位置显示固定掩码 `••••••••`，不反映真实长度。
- `$VAR` / `${VAR}` / `!command` 这些引用形式本身也不返回：它们泄漏部署环境结构。

### 3. 输入采用三态语义

对每个凭据字段：

- 字段缺省 = 保持原值；
- 非空字符串 = 覆盖；
- `null` = 清除。

空字符串不等于清除，掩码原样回传等于保持。这样「打开表单直接保存」不会意外清空凭据，而清除必须是一个显式动作。

### 4. 写入前用候选文件跑 SDK 校验，写入用原子替换

保存流程：在同目录写临时文件 → 用 `ModelRuntime.create({ modelsPath: 候选文件, refreshOnCreate: false })` 让 Pi 自己校验 → 通过后 `rename` 覆盖原文件。

`rename` 在同一文件系统内是原子的，因此任何失败路径下原文件字节保持不变，权限保持 `0o600`。

校验错误按 provider 归因：只有「本次修改的 provider」或「全局」错误才阻断保存；其他 provider 早已存在的错误降级为 `warnings` 返回。否则一个用户手工写坏的旧 provider 会让界面永远无法保存任何配置。

### 5. `settings.json` 不做整文件替换

`settings.json` 由 Pi 自己管理（`packages`、`theme`、`lastChangelogVersion` 等）。写入一律通过 SDK 的 `SettingsManager` setter + `flush()`，由它在锁内重读并按字段合并，权限保持 `0o644`。本产品只写白名单字段：`defaultProvider`、`defaultModel`、`retryEnabled`。

### 6. 环境变量优先，且不给假成功

`PI_TEACHER_PROVIDER` / `PI_TEACHER_MODEL` 优先于 settings。此时 `GET` 返回 `source: "env"`、`editable: false`，`PATCH /api/config/default-model` 返回 409。界面据此禁用编辑并说明原因——保存一个注定不生效的值比不让保存更糟。

### 7. 保存后刷新目录，但不改变运行中的会话

保存成功后调用 `ModelRuntime.refresh({ allowNetwork: false })`（串行化，避免并发保存交错）。已启动的 Pi Session 保持其当前模型不变，新会话与模型列表使用新配置。运行中被动换模型会让同一次对话前后行为不一致。

### 8. 不做自由文件编辑器

不提供任意路径的文件编辑，也不提供无约束的 JSON textarea。JSON 视图是「脱敏后的单个 provider」，提交时与结构化表单走同一条白名单校验路径，不给 JSON 开后门。`models-store.json` 属于 Pi 的内部状态，不是用户配置编辑目标。

## 后果

- 浏览器、日志、错误响应与验证输出中都不可能出现凭据原文；验证脚本对此有专门断言。
- 用户可以在界面完成换 provider、换模型、配 key、删 provider 的全部操作。
- 保存失败时用户拿到的是 Pi 自己的校验信息（已脱敏），而不是「保存失败」四个字。
- 配置验证必须在临时 `PI_CODING_AGENT_DIR` 内进行，并显式断言没有触碰用户真实 `~/.pi`。

## 否决方案

### 直接把 `models.json` 原样返回前端，由前端渲染

否决。凭据一旦进入浏览器就无法收回，且任何一次日志或错误上报都可能带走它。

### 用长度或前几位提示凭据

否决。它泄漏 key 的形状信息，收益只是「让用户确认填过」——布尔值已经能表达这一点。

### 保存时直接覆盖原文件

否决。写入中断会留下半个文件，导致 Pi 完全起不来，而这正是用户最需要能自救的时刻。

### 允许编辑 `settings.json` 全文

否决。会抹掉 Pi 自己管理的字段，且这些字段的语义不由本产品负责。
