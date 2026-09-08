// 基于 pi-web v0.9.0 lib/rpc-manager.ts 裁剪重写（MIT License，上游 2067 行
// → 本文件约 600 行）。裁剪对照见 PRD backend-host-mvp 附录：
//   砍——subagent 全套、扩展 UI widget/custom-ui-terminal、web-push、
//        project-trust、startup-preferences、model-scope、PlainTextTheme/
//        TuiKeybindingsManager（pi-tui 依赖随 ask_user 一并移除）、
//        session-liveness、fork/clone/fork_branch、withExtensionTools、bash
//   保留——wrapper 生命周期、prompt 准入队列与两段式 ack、空闲回收、
//        启动锁、send() 命令表、emit/onEvent、destroy/shutdown、优雅退出
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSessionLike, ToolInfo } from "./pi-types.ts";
import type { SessionToolContext } from "../tools/context.ts";
import { createPiTeacherExtension } from "../tools/factory.ts";
import { emitAgentRunComplete } from "../events/hub.ts";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type AgentRunCompleteListener = (sessionId: string) => void;

export interface AgentSessionWrapperOptions {
  /** 标题生成等「首轮完成后」的钩子（pi-web 用于 web-push，这里给事件 hub） */
  onAgentRunComplete?: AgentRunCompleteListener;
}

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

/** 空闲回收时长：默认 10 分钟，测试可用环境变量调到秒级。 */
function idleTimeoutMs(): number {
  const fromEnv = Number(process.env.PI_TEACHER_IDLE_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10 * 60 * 1000;
}

// ============================================================================
// AgentSessionWrapper
// 与 pi-web 同名类职责一致：包住 AgentSessionLike，提供事件分发、
// prompt 串行化准入、空闲回收、优雅退出。
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingPromptCount = 0;
  private agentRunNeedsCompletion = false;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // 多个销毁监听器：注册表清理、外部打点可以并存（单槽会被互相覆盖）
  private onDestroyCallbacks: Array<() => void> = [];
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    options: AgentSessionWrapperOptions = {},
  ) {
    this.onAgentRunComplete = options.onAgentRunComplete;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage(): unknown {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive
      && (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") this.agentRunNeedsCompletion = true;
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
    });
    this.resetIdleTimer();
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    try {
      // 消费方（标题生成）按 jsonl 路径查 pi_session，传 sessionFile 而非
      // SDK 内部 id（uuidv7）——否则查不到行、标题永远生成不了。
      this.onAgentRunComplete?.(this.sessionFile || this.sessionId);
    } catch (error) {
      console.error("[bridge] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  private async withFinalIdleReset<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[bridge] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /** prompt 准入串行化：同一会话并发 POST 只有一个在跑，其余排队。 */
  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    return release;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this._alive) return;
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() && !this.forceShutdownOnIdle) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[bridge] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, idleTimeoutMs());
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallbacks.push(cb);
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;

    try {
      // get_state 只是状态查询，不应推迟 Stop 之后的强制清理
      if (type !== "get_state") this.resetIdleTimer();

      switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolvePromise, rejectPromise) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              this.agentRunNeedsCompletion = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolvePromise();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              rejectPromise(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            this.notifyAgentRunCompleteIfIdle();
          };

          this.pendingPromptCount += 1;
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              preflightResult: (success) => {
                if (success) acceptPreflight();
              },
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[bridge] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort": {
        this.forceShutdownOnIdle = true;
        try {
          return await this.withFinalIdleReset(() => this.inner.abort());
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.pendingPromptCount > 0,
          isCompacting: this.inner.isCompacting,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          pendingMessageCount: this.inner.pendingMessageCount,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "set_thinking_level": {
        this.inner.setThinkingLevel(command.level as string);
        return null;
      }

      case "compact": {
        return await this.withFinalIdleReset(() =>
          this.inner.compact(command.customInstructions as string | undefined)
        );
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          ...t,
          active: active.has(t.name),
        }));
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      this.resetIdleTimer();
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unsubscribe?.();

    const finishDispose = () => {
      try {
        this.inner.dispose();
      } finally {
        for (const cb of this.onDestroyCallbacks) {
          try {
            cb();
          } catch (error) {
            console.error(
              "[bridge] onDestroy callback failed:",
              error instanceof Error ? error.message : error,
            );
          }
        }
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void (async () => emit.call(
      this.inner.extensionRunner,
      { type: "session_shutdown", reason: "quit" },
    ))()
      .catch((error) => {
        console.error(
          "[bridge] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }
}

// ============================================================================
// 会话注册表（模块级 Map，ADR-0024 简化决定，不用 globalThis）
// ============================================================================

const sessionRegistry = new Map<string, AgentSessionWrapper>();
const startLocks = new Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>>();

// 信号钩子只注册一次：SIGTERM/SIGINT 时对全部会话先发 session_shutdown 再 dispose。
let signalHandlersRegistered = false;

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  const shutdownAll = () => {
    // 双 key 注册会让同一 wrapper 出现两次：按对象去重，shutdown/destroy 幂等但别重复跑
    const sessions = Array.from(new Set(sessionRegistry.values()));
    void Promise.allSettled(sessions.map((session) => session.shutdown())).then(() => {
      // Node 无法在 exit handler 里 await，这里同步收尾作为最后兜底
      sessions.forEach((session) => session.destroy());
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdownAll);
  process.once("SIGINT", shutdownAll);
  // Node cannot await work from an exit handler; direct destruction starts
  // extension cleanup synchronously as a final best effort.
  process.once("exit", () => sessionRegistry.forEach((session) => session.destroy()));
}

function registerWrapper(wrapper: AgentSessionWrapper): void {
  // 双 key：SDK 内部 id（inner.sessionId，uuidv7）与 jsonl 路径都指向同一
  // wrapper。前端/路由层按 jsonl 路径寻址（conversations 路由的 :key），
  // 而 wrapper 事件、流内部用 SDK 的 sessionId——两个都必须可查。
  const sessionId = wrapper.sessionId;
  const aliases: string[] = [];
  if (wrapper.sessionFile) aliases.push(wrapper.sessionFile);
  wrapper.onDestroy(() => {
    sessionRegistry.delete(sessionId);
    for (const alias of aliases) sessionRegistry.delete(alias);
  });
  sessionRegistry.set(sessionId, wrapper);
  for (const alias of aliases) sessionRegistry.set(alias, wrapper);
  wrapper.start();
  registerSignalHandlers();
}

/** 去重后的运行中会话（双 key 注册会让同一会话出现两次）。 */
export function listRunningSessionIds(): string[] {
  const seen = new Set<AgentSessionWrapper>();
  return Array.from(sessionRegistry.values())
    .filter((session) => session.isRunning() && !seen.has(session) && seen.add(session))
    .map((session) => session.sessionId);
}

export function getSessionWrapper(sessionId: string): AgentSessionWrapper | undefined {
  return sessionRegistry.get(sessionId);
}

// ============================================================================
// 会话启动（pi-web startRpcSession 的 pi-teacher 版）
// ============================================================================

/**
 * 创建或复用一个工作区会话。与 pi-web 的关键差异（PRD 实现要点 1/2）：
 * - cwd 契约：SessionManager.create(工作区目录, 工作区目录)，jsonl 平铺
 *   在工作区目录，祖先遍历使全局 AGENTS.md 自动注入（ADR-0029）
 * - resourceLoaderOptions 全开（生产宿主：skills、context files 都要装），
 *   扩展工厂注入 createPiTeacherExtension（SessionToolContext 闭包捕获）
 */
export async function startWorkspaceSession(
  sessionKey: string,
  workspaceRoot: string,
  toolContext: SessionToolContext,
  options: { sessionFile?: string; thinkingLevel?: ThinkingLevel } = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const existing = sessionRegistry.get(sessionKey);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionKey };

  const inflight = startLocks.get(sessionKey);
  if (inflight) return inflight;

  // 惰性 import：避免 pi-coding-agent 在模块顶层就拉起（对 verify 脚本不友好）
  const {
    createAgentSessionFromServices,
    createAgentSessionServices,
    getAgentDir,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");

  const workspaceDir = resolve(workspaceRoot);
  let sessionManager;
  if (options.sessionFile) {
    sessionManager = SessionManager.open(options.sessionFile, workspaceDir);
  } else {
    sessionManager = SessionManager.create(workspaceDir, workspaceDir);
  }
  const sessionCwd = sessionManager.getCwd();

  const starting = (async () => {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(sessionCwd, agentDir);

    // 生产宿主：noSkills 等开关全关（=资源全装载，与 run-real 的全关相反），
    // skills 全局目录 ~/.pi/agent/skills/ 与祖先 AGENTS.md 注入都由此生效
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [createPiTeacherExtension(toolContext)],
      },
    });

    const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(hasExistingMessages ? {} : options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });

    const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike, {
      onAgentRunComplete: (completedSessionId) => {
        // 轮次空闲即通知 hub（标题生成、前端提示等消费者订阅这里）
        emitAgentRunComplete(completedSessionId);
      },
    });
    const realSessionId = inner.sessionId as string;
    registerWrapper(wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => {
    startLocks.delete(sessionKey);
  });

  startLocks.set(sessionKey, starting);
  return starting;
}

/** 按文件路径判断会话是否存在（jsonl 平铺布局，直接查文件系统）。 */
export function isSessionFileAlive(filePath: string): boolean {
  return existsSync(filePath);
}
