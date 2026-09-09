import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { createPiSession } from "../session/repository.ts";
import { projectAgentsMd, projectTeachStyle } from "../projection/agents-md.ts";

const TA_TEMPLATE_PATH = fileURLToPath(new URL("../../../docs/提示词设计/提示词模板/agentsmd/助教.md", import.meta.url));

const LEARN_PROMPT = `# 学习职责
你是 Pi Teacher 的学习老师。使用中文，围绕用户的目标进行清晰、有层次的讲解。
先理解问题和已有基础，再用简短示例、推导与练习帮助用户掌握知识。不编造事实。
每条 Pi Session 独立维护 MISSION.md、GLOSSARY.md、learning-records/ 和 essence/。
可以按需读取共享资料，但不要假设其他对话的内容是当前上下文。
只有制卡开关开启时才使用 card_propose；卡片必须属于合适的 Topic，提议后由用户审批。
当用户提出复习请求时可使用复习工具，评级必须来自用户真实回答，不能替用户作答。
`;

const REVIEW_PROMPT = `# 复习职责
你是 Pi Teacher 的复习老师。使用中文，通过对话帮助用户主动回忆，而非直接展示答案。
通过 review_get_due_cards 获取到期卡片；选择了 Topic 时遵守本会话的主题过滤。
一次只提出适量问题，等待用户回答后再解释与反馈；没有真实回答时不得提交评级。
使用 Again、Hard、Good、Easy 表达记忆表现，使用 review_submit_ratings 提交，间隔由 FSRS 计算。
开启制卡时可以提议必要的补充卡片，但不重复创建已有知识点，不擅自确认卡片。
`;

/** 默认模板只填充缺失行，绝不覆盖用户在管理面板里编辑过的正文。 */
export function seedApplication(db: Database.Database, homeDir: string): void {
  const taPrompt = readFileSync(TA_TEMPLATE_PATH, "utf8");
  if (!taPrompt.trim()) throw new Error("助教初始模板为空，不能初始化固定助教");
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO space (id, type, name) VALUES (0, 'ta', '助教'), (1, 'review', '复习')").run();
    db.prepare("INSERT OR IGNORE INTO agents_md (id, type, name, description, prompt) VALUES (0, 'ta', '助教', '固定助教，只答疑', ?)").run(taPrompt);
    if (!db.prepare("SELECT id FROM agents_md WHERE type = 'learn'").get()) {
      db.prepare("INSERT INTO agents_md (type, name, description, prompt) VALUES ('learn', '循序学习', '围绕目标讲解、练习与沉淀', ?)").run(LEARN_PROMPT);
    }
    if (!db.prepare("SELECT id FROM agents_md WHERE type = 'review'").get()) {
      db.prepare("INSERT INTO agents_md (type, name, description, prompt) VALUES ('review', '主动回忆', '基于到期卡片进行对话复习', ?)").run(REVIEW_PROMPT);
    }
    if (!db.prepare("SELECT id FROM teach_style LIMIT 1").get()) {
      const insert = db.prepare("INSERT INTO teach_style (name, description, prompt) VALUES (?, ?, ?)");
      insert.run("清晰直接", "先结论，再解释和示例", "先给结论，再解释原因和适量示例。避免空泛鼓励与不必要的术语堆砌。");
      insert.run("启发式追问", "用适量问题引导思考", "每次只提出一个有助于理解的问题，等待用户回答；用户要求直接解释时不强行追问。");
    }
  }).immediate();
  const ta = createPiSession(db, homeDir, { spaceId: 0, agentsMdId: 0, enableMakeCard: false }, true);
  mkdirSync(ta.work_path, { recursive: true });
  mkdirSync(path.join(ta.work_path, "attachments"), { recursive: true });
  // 初始化重入只补缺失文件，已有对话保持创建时的投影，不受模板后续编辑污染。
  if (!existsSync(path.join(ta.work_path, "AGENTS.md"))) projectAgentsMd(db, ta.work_path, ta.agents_md_id);
  if (!existsSync(path.join(ta.work_path, "style.md"))) projectTeachStyle(db, ta.work_path, ta.teach_style_id);
}
