/**
 * lifecycle-child：被 lifecycle.ts fork 的子进程。
 *
 * 用新 Schema 建一条真实 Pi Session（真 SQLite、真目录、真 SDK，不 mock），
 * 通过 IPC 把 sessionFile 报回父进程。打点只覆盖「真实路径」：
 *   - wrapper.onDestroy（dispose 被执行）→ send `disposed`
 *   - wrapper 的 extensionRunner.emit 被调用（session_shutdown 发出）→ send `shutdown_emitted`
 *   - 父进程 SIGTERM → wrapper 的 registerSignalHandlers 里 shutdownAll →
 *     session.shutdown()（内部先 emit session_shutdown 再 destroy）→ dispose
 *
 * ADR-0030 适配要点：
 *   - Pi Session 记录由 createPiSession 在数据库里建出，稳定 key 用 sessionKeyFor(id)，
 *     cwd/sessionDir 都是该对话独占的 work_path，JSONL 复用建行时的 path。
 *   - 新 Schema 建行时已写入 SDK header，所以 JSONL 在建会话时就存在；空闲回收
 *     分支仍发一条真实 prompt 让消息落盘，父进程据此区分「只有 header」与
 *     「真实对话过」。
 *
 * 参数 `stay-alive` → 等父进程 SIGTERM 后优雅退出（父进程断言 0 退出码）；
 * 无参数 → 靠 PI_TEACHER_IDLE_TIMEOUT_MS 空闲回收自行退出（父进程验证回收）。
 */
import path from "node:path";
import Database from "better-sqlite3";
import { initializeSchema } from "../db/schema.ts";
import { createPiSession, sessionKeyFor } from "../session/repository.ts";
import { toolContextFor } from "../tools/context.ts";
import { startWorkspaceSession, getSessionWrapper } from "../bridge/agent-session-wrapper.ts";

const stayAlive = process.argv[2] === "stay-alive";

async function main(): Promise<void> {
  const homeDir = process.env.PI_TEACHER_LIFECYCLE_HOME!;
  // 每个子进程自己开库：父进程只负责目录生命周期，不共享句柄
  const db = new Database(path.join(homeDir, "pi-teacher.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initializeSchema(db, homeDir);

  // 两个子进程（空闲回收 / SIGTERM）共用同一个 home：各建自己的 Space 与对话，
  // 名字带 pid 避开 space.name 唯一约束
  const spaceId = Number(db.prepare("INSERT INTO space (type, name) VALUES ('learn', ?)").run(`lifecycle-${process.pid}`).lastInsertRowid);
  const agentsMdId = (db.prepare("SELECT id FROM agents_md WHERE type = 'learn'").get() as { id: number }).id;
  const piRow = createPiSession(db, homeDir, { spaceId, agentsMdId, enableMakeCard: true });
  const toolContext = toolContextFor(db, piRow);

  const { session: wrapper, realSessionId } = await startWorkspaceSession(
    sessionKeyFor(piRow.id),
    piRow.work_path,
    toolContext,
    { sessionFile: piRow.path },
  );

  // 打点：dispose 执行了、session_shutdown emit 走了 extensionRunner（写 stdout 让父进程能断言）
  wrapper.onDestroy(() => {
    console.log("[child] disposed");
    process.send?.("disposed");
  });
  const originalEmit = wrapper.inner.extensionRunner?.emit?.bind(wrapper.inner.extensionRunner);
  if (typeof originalEmit === "function") {
    // 包装签名放宽到 SDK 实际调用形态（含角标事件类型），内部只对 session_shutdown 打点
    const runner = wrapper.inner.extensionRunner as { emit: (event: any) => Promise<unknown> };
    runner.emit = async (event: any) => {
      // 只打点 session_shutdown——SDK 的 emit 会被多种事件调用，刷屏会淹没断言
      if (event?.type === "session_shutdown") {
        console.log("[child] shutdown_emitted");
      }
      return originalEmit(event);
    };
  }

  const sessionFile = wrapper.sessionFile;
  if (!sessionFile) {
    console.error("[child] sessionFile 为空");
    process.exit(3);
  }
  if (path.resolve(sessionFile) !== path.resolve(piRow.path)) {
    console.error(`[child] wrapper 没有复用数据库里的 JSONL：${sessionFile} != ${piRow.path}`);
    process.exit(5);
  }
  if (path.resolve(wrapper.cwd) !== path.resolve(piRow.work_path)) {
    console.error(`[child] wrapper cwd 不是 Pi Session 的 work_path：${wrapper.cwd} != ${piRow.work_path}`);
    process.exit(6);
  }
  process.send?.(`SESSION_FILE=${sessionFile}`);
  process.send?.(`WORK_PATH=${piRow.work_path}`);
  console.log(`[child] sessionFile=${sessionFile} realSessionId=${realSessionId} piId=${piRow.id}`);

  // 轮询注册表：wrapper 被回收后发 WRAPPERS_CLEAN=1 并退出（空闲回收验证用）。
  // stay-alive 模式不改写此逻辑：父进程 SIGTERM 由信号处理器接管。
  const deadline = Date.now() + 120_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      console.error("[child] 等待回收超时");
      process.exit(4);
    }
    if (!getSessionWrapper(sessionFile) && !getSessionWrapper(sessionKeyFor(piRow.id))) {
      // IPC 消息在紧接着的 process.exit 时可能丢帧（fork 竞态），标志写 stdout
      // 父进程从输出里断言，不依赖 IPC 送达
      console.log("[child] WRAPPERS_CLEAN=1 注册表已空，退出");
      db.close();
      process.exit(0);
    }
  }, 500);

  if (stayAlive) {
    process.send?.("READY");
    // 等父进程 SIGTERM——优雅退出在 wrapper 的 registerSignalHandlers，成功 exit(0)
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    clearInterval(timer);
    process.exit(0);
  }

  // —— 空闲回收分支：发一条真实消息让对话条目落盘，然后靠空闲回收退出 ——
  const provider = process.env.PI_TEACHER_PROVIDER;
  const modelId = process.env.PI_TEACHER_MODEL;
  if (!provider || !modelId) {
    console.error("[child] 缺少 PI_TEACHER_PROVIDER / PI_TEACHER_MODEL（消息落盘需要真模型）");
    process.exit(2);
  }
  const model = await wrapper.send({
    type: "set_model",
    provider,
    modelId,
  }).catch(() => null);
  // 只回显 provider/model 名，凭据不进日志
  console.log(`[child] set_model result=${JSON.stringify(model)}`);
  const promptResult = await wrapper.send({
    type: "prompt",
    message: "请只回复四个字：冒烟完成。不要调用任何工具。",
  }).catch((error) => {
    console.error("[child] prompt 失败：", error instanceof Error ? error.message : error);
    return null;
  });
  console.log(`[child] prompt preflight=${promptResult === null ? "accepted" : "rejected"}`);
  // 等模型跑完一轮（prompt_done 由 wrapper 在空轮次后触发），对话条目必然落盘；
  // 随后不再有任何交互，空闲计时器到点应回收 wrapper
  const runDeadline = Date.now() + 60_000;
  while (Date.now() < runDeadline && wrapper.isRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`[child] run finished, isRunning=${wrapper.isRunning()}`);
}

main().catch((error) => {
  console.error("[child] 异常退出：", error instanceof Error ? error.message : error);
  process.exit(1);
});
