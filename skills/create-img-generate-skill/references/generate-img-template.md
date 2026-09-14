# generate-img 初始模板

首次接入时，若 `~/.pi/agent/skills/generate-img/` 不存在，创建如下结构：

```
generate-img/
├── SKILL.md          ← 按下文「初始 SKILL.md 内容」原样写入
├── scripts/          ← 空，provider 脚本后续放这里
└── references/       ← 空，provider 文档后续放这里
```

## 初始 SKILL.md 内容（原样写入）

```
---
name: generate-img
description: AI 文生图。当用户要求生成、绘制、创作图片或插画时使用，调用已配置提供商的脚本生成图片，保存到 ~/pi-teacher/llm-text-to-img/。无可用提供商时引导用户提供生图服务的接口规范。
---

当前无任何可用提供商。

用户想生成图片时：请用户提供某个生图服务的 API 接口规范（文档或链接），然后使用 create-img-generate-skill 技能完成接入。

## 状态区

当前可用提供商：（接入后在此逐条列出，格式：- {provider}：{可直接复制的脚本调用示例}）

当前优先使用提供商：（接入后写入 provider 名）
```

## 状态区维护规则

每次接入或修复 provider 后同步更新状态区：

- 「当前可用提供商」：一行一个，含可直接复制的调用示例（含核心参数），生图时模型照示例调用即可，不需要再去翻脚本源码。
- 「当前优先使用提供商」：是否更新为本次 provider，先询问用户再写入。
- frontmatter 的 description 保持不变，它是静态触发条件，与 provider 多少无关。
