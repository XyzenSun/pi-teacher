# TODO

## 当前阶段（用户已定）：插件注册与工具开发跑通

不做 UI 前端。目标是：Pi 插件（extensionFactories 路线）注册 16 个工具（15 个自研前缀命名 + ask_user 移植官方样例），工具能落库、能被模型调用，后端宿主能创建会话。

**当前任务**：插件注册与工具开发跑通，PRD 见 `plugin-tools-mvp.md`（2026-09-07 已与用户对齐需求）

- [x] 搭 server/ 工程骨架（依赖版本见 PRD「工程骨架」节）
- [x] db/schema.ts + connection.ts（冒烟 3 断言过）
- [x] fsrs/service.ts（关 steps 语义已验证：due ≥ 24h）
- [x] tools/ 按组实现（16 工具：15 自研 + ask_user 移植官方 question.ts）
- [x] 插件工厂 factory.ts（可见性执行层拒绝，冒烟验证助教硬拒/开关拒绝）
- [x] run-real.ts：真模型验证通过（deepseek 真实调用 topic_list→topic_create→card_propose 落库）
- [x] 验收清单逐项过：冒烟 25/25 + run-real 4/4 + 注册断言 16/16
- [x] 全工具冒烟（用户要求「把所有工具都测一遍」）：smoke.ts 重写为 16 工具全覆盖，75/75——补齐 card_get / card_delete / card_merge / topic_list / glossary_get / ask_user 直调，含 merge 调度继承、软删回收站、取卡截断、重名标题、路径越界等边界

## 已完成的探索结论（勿重复调研）

- 工具注册路线定 extensionFactories（用户拍板），customTools 路线否决
- 工具名前缀式定稿：card_* / topic_* / glossary_* / review_* / md_* / file_* + ask_user
- FSRS 关多步学习（learning_steps: []），表零加列
- 详细技术事实见 `../CLAUDE.md`「技术事实」节

## 暂缓（不在本阶段）

- Express 路由 / SSE / 前端 UI
- pi-web 桥接层移植（rpc-manager 裁剪）——依赖插件先跑通
- 沙箱插件、生图 skill
