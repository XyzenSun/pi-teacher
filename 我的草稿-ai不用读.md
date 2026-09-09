2. style.md（教学风格追加）
  server/src/bridge/agent-session-wrapper.ts:556
  会话打开时读 style.md，若非空则通过 appendSystemPrompt: [style]
  追加到 system prompt 末尾。目前两条：
  - 清晰直接：32 字符
  - 启发式追问：38 字符

这个和agents.md 是怎么配合的？ agents.md 是pi agent的机制决定的他会自动追加到系统提示词里


3. context 钩子注入 ,目前是没做制卡的提醒和user偏好维护的提醒吗？ 
