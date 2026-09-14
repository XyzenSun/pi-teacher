---
name: create-img-generate-skill
description: 生图提供商接入工厂，用于创建和维护 generate-img 生图 skill。当用户提供 AI 生图 / 文生图服务的 API 接口规范（粘贴文本或文档链接，如阿里云百炼、通义万相、OpenAI Images），要求接入、添加或修复生图能力时使用。不要在用户仅要求生成图片时触发（那是 generate-img 的职责），也不要用于非生图类 API 的接入。
---

# 生图提供商接入

把用户提供的生图服务接口规范，转化为 `~/.pi/agent/skills/generate-img/` 下可运行的零依赖 Node 脚本。

## 第 1 步：确认目标与现状

1. 获取接口规范：粘贴文本优先；用户给 URL 时先用 pullpage skill 抓取正文。
2. 核对信息完整性，缺什么向用户要什么：endpoint 与 HTTP method、鉴权方式与 key 环境变量名、请求参数（必填 / 可选 / 默认值）、响应结构（同步返回还是异步任务轮询）、图片返回形式（URL / base64）。
3. 检查 `~/.pi/agent/skills/generate-img/` 是否存在；不存在则按 `references/generate-img-template.md` 创建初始目录与 SKILL.md。
4. 确定 provider 名：取服务名小写 kebab-case（如 bailian、openai）。

## 第 2 步：编写 provider 脚本

读 `references/script-spec.md`，写 `generate-img/scripts/{provider}.js`；接口规范原文归档到 `generate-img/references/{provider}/{doc-name}.md`。

## 第 3 步：真实 key 验证

> ⛔ 强制关卡：必须用真实 API key 真调用验证，禁止 mock、禁止伪造响应、禁止跳过。没有 key 就向用户索要；用户拒绝则任务中止，不得注册未验证的 provider。

key 优先由用户在 pi-teacher「系统设置 → 高级配置 → 用户环境变量」填写（保存即注入 process.env，bash 子进程立即可用）；用户在对话里直接给出时仅临时注入验证，并提醒其去界面持久化。按 `references/verify.md` 执行，验证通过前不得更新状态区。验证图确认成功后即删。

## 第 4 步：注册并收尾

1. 更新 `generate-img/SKILL.md` 状态区：可用提供商列表与脚本用法示例。
2. 询问用户是否将该提供商设为「当前优先使用提供商」，按答复写入状态区。
3. 告知用户：在会话中说「生成一张……」即可使用新能力。
