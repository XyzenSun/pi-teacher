/**
 * lifecycle-child：被 lifecycle.ts fork 的子进程。
 *
 * 建一个真实会话（真 SDK、不 mock），通过 IPC 把 sessionFile 报回父进程。
 * 打点只覆盖「真实路径」：
 *   - wrapper.onDestroy（dispose 被执行）→ send `disposed`
 *   - wrapper 的 extensionRunner.emit 被调用（session_shutdown 发出）→ send `shutdown_emitted`
 *   - 父进程 SIGTERM → wrapper 的 registerSignalHandlers 里 shutdownAll →
 *     session.shutdown()（内部先 emit session_shutdown 再 destroy）→ dispose
 *
 * 参数 `stay-alive` → 等父进程 SIGTERM 后优雅退出（父进程断言 0 退出码）；
 * 无参数 → 靠 PI_TEACHER_IDLE_TIMEOUT_MS 空闲回收自行退出（父进程验证回收）。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { openDatabase } from "../db/connection.ts";
import { initializeSchema } from "../db/schema.ts";
import { startWorkspaceSession, getSessionWrapper } from "../bridge/agent-session-wrapper.ts";
import type { SessionToolContext } from "../tools/context.ts";

const stayAlive = process.argv[2] === "stay-alive";

async function main(): Promise<void> {
  const homeDir = process.env.PI_TEACHER_LIFECYCLE_HOME!;
  const workspaceRoot = process.env.PI_TEACHER_LIFECYCLE_WORKSPACE!;
  const dbPath = path.join(homeDir, "pi-teacher.db");
  const db = openDatabase(dbPath);
  initializeSchema(db);

  const toolContext: SessionToolContext = {
    db,
    spaceId: 1,
    enableMakeCard: true,
    reviewTopicId: null,
    workspaceRoot,
  };

  const { session: wrapper, realSessionId } = await startWorkspaceSession(
    `lifecycle-${randomUUID()}`,
    workspaceRoot,
    toolContext,
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
  process.send?.(`SESSION_FILE=${sessionFile}`);
  console.log(`[child] sessionFile=${sessionFile} realSessionId=${realSessionId}`);

  // 轮询注册表：wrapper 被回收后发 WRAPPERS_CLEAN=1 并退出（空闲回收验证用）。
  // stay-alive 模式不改写此逻辑：父进程 SIGTERM 由信号处理器接管。
  const deadline = Date.now() + 120_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      console.error("[child] 等待回收超时");
      process.exit(4);
    }
    if (!getSessionWrapper(sessionFile)) {
      // IPC 消息在紧接着的 process.exit 时可能丢帧（fork 竞态），标志写 stdout
      // 父进程从输出里断言，不依赖 IPC 送达
      console.log("[child] WRAPPERS_CLEAN=1 注册表已空，退出");
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

  // —— 空闲回收分支：发一条真实消息让 jsonl 落盘，然后靠空闲回收退出 ——
  const provider = process.env.PI_TEACHER_PROVIDER;
  const modelId = process.env.PI_TEACHER_MODEL;
  if (!provider || !modelId) {
    console.error("[child] 缺少 PI_TEACHER_PROVIDER / PI_TEACHER_MODEL（jsonl 落盘需要真模型）");
    process.exit(2);
  }
  const model = await wrapper.send({
    type: "set_model",
    provider,
    modelId,
  }).catch(() => null);
  console.log(`[child] set_model result=${JSON.stringify(model)}`);
  const promptResult = await wrapper.send({
    type: "prompt",
    message: "请只回复四个字：冒烟完成。不要调用任何工具。",
  }).catch((error) => {
    console.error("[child] prompt 失败：", error instanceof Error ? error.message : error);
    return null;
  });
  console.log(`[child] prompt preflight=${promptResult === null ? "accepted" : "rejected"}`);
  // 等模型跑完一轮（prompt_done 由 wrapper 在空轮次后触发），jsonl 必然落盘
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

main().catch((error) => {
  console.error("[child] 异常退出：", error instanceof Error ? error.message : error);
  process.exit(1);
});
