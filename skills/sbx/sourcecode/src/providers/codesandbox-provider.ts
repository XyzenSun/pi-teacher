import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CodeSandbox, type Sandbox, CommandError } from '@codesandbox/sdk';
import type {
  CommandResult,
  CreateSandboxParams,
  RunCommandParams,
  SandboxInfo,
  SandboxProvider,
  SandboxSummary,
} from '../types.js';
import { SbxError } from '../types.js';
import { parseSingleStageDockerfile } from '../dockerfile/parser.js';
import { nameTemplate } from '../template-naming.js';

const API_KEY_ENV = 'CODESANDBOX_API_KEY';

/**
 * CodeSandbox Provider。
 *
 * 平台特性适配（与另两家的关键差异）：
 * - “模板”是可 fork 的沙箱本体（非镜像概念）。Dockerfile 构建走
 *   csb build 同款流程：fork universal 模板 → 上传 Dockerfile →
 *   restart 触发平台构建 → 以该沙箱为模板缓存（title 做缓存键）
 * - 文件/命令 API 走 WebSocket（SandboxClient），须 connect() 后使用
 * - 命令 ID 是 Command 对象内部 shell id；后台命令查询需重新
 *   runBackground 后 getAll() 匹配，故结果查询仅支持本次会话内命令
 */
export class CodeSandboxProvider implements SandboxProvider {
  readonly platform = 'codesandbox' as const;
  readonly displayName = 'CodeSandbox';
  readonly apiKeyEnvName = API_KEY_ENV;

  private readonly client: CodeSandbox;

  constructor() {
    if (!process.env[API_KEY_ENV]) {
      throw new SbxError('MISSING_API_KEY', `Environment variable ${API_KEY_ENV} is not set`);
    }
    // ClientOpts.baseUrl 支持反代；默认 https://api.codesandbox.io
    const opts: { baseUrl?: string } = {};
    if (process.env.CODESANDBOX_API_URL) {
      opts.baseUrl = process.env.CODESANDBOX_API_URL;
    }
    this.client = new CodeSandbox(process.env[API_KEY_ENV], opts);
  }

  isConfigured(): boolean {
    return Boolean(process.env[API_KEY_ENV]);
  }

  async createSandbox(params: CreateSandboxParams): Promise<SandboxInfo> {
    const { source, ttlMinutes, envVars } = params;

    if (source.kind === 'template') {
      // template 语义：fork 指定模板沙箱
      const sandbox = await this.client.sandboxes.create({ id: source.template });
      await this.applyHibernation(sandbox, ttlMinutes);
      return {
        sandboxId: sandbox.id,
        platform: this.platform,
        sourceDescription: `template sandbox: ${source.template}`,
      };
    }

    if (source.kind === 'dockerfile' || source.kind === 'image') {
      const naming = (await nameTemplate(source))!;
      const templateSandboxId = await this.buildTemplateSandbox(source, naming.name, params.forceRebuild ?? false);
      const sandbox = await this.client.sandboxes.create({ id: templateSandboxId });
      await this.applyHibernation(sandbox, ttlMinutes);
      return {
        sandboxId: sandbox.id,
        platform: this.platform,
        sourceDescription: `${naming.description} (template sandbox: ${templateSandboxId})`,
      };
    }

    // default：universal 模板；env 通过 session 级注入（create 后首个命令生效）
    const sandbox = await this.client.sandboxes.create(envVars ? {} : {});
    await this.applyHibernation(sandbox, ttlMinutes);
    if (envVars && Object.keys(envVars).length > 0) {
      await this.injectGlobalEnv(sandbox.id, envVars);
    }
    return {
      sandboxId: sandbox.id,
      platform: this.platform,
      sourceDescription: 'universal (default template)',
    };
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    const { sandboxId, command, cwd, env, timeoutSeconds, background, onStdout, onStderr } = params;
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();

    try {
      if (background) {
        // 后台命令必须带稳定 name：CSB 的 getAll() 只返回运行中命令且
        // 跨会话仅能按 name 匹配（command 本身不稳定）；结束后命令从
        // 进程表消失，result 只能查询运行中的命令（平台限制，同 E2B）
        const commandName = `sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await session.commands.runBackground(command, { cwd, env, name: commandName });
        return {
          commandId: commandName,
          stdout: '',
          stderr: '',
          exitCode: null,
          status: 'running',
        };
      }

      // 前台执行：runBackground + 订阅输出 + waitUntilComplete。
      // 非零退出时 waitUntilComplete 抛 CommandError（携带 exitCode/output），
      // 捕获归一化——业务命令失败是"结果"而非"错误"
      const cmd = await session.commands.runBackground(command, { cwd, env });
      let mergedOutput = '';
      cmd.onOutput((chunk: string) => {
        mergedOutput += chunk;
        // stdout/stderr 在平台侧不区分，统一按 stdout 流出（平台限制，见类注释）
        onStdout?.(chunk);
      });
      let exitCode = 0;
      try {
        await withTimeout(cmd.waitUntilComplete(), timeoutSeconds * 1000, 'command timed out');
      } catch (err: unknown) {
        if (err instanceof CommandError) {
          exitCode = err.exitCode;
          mergedOutput = err.output || mergedOutput;
        } else {
          throw err;
        }
      }
      return {
        commandId: `sync-${Date.now().toString(36)}`,
        stdout: mergedOutput,
        stderr: '',
        exitCode,
        status: exitCode === 0 ? 'finished' : 'failed',
      };
    } finally {
      session.dispose();
    }
  }

  async getCommandResult(sandboxId: string, commandId: string): Promise<CommandResult> {
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();
    try {
      // 平台限制：getAll() 只返回运行中命令，按 name 匹配（run --background
      // 生成稳定 name）。命令已结束即不可查——CLI 层的 --wait 轮询在命令
      // 消失的瞬间即视为完成，输出需另行经 wait 拿到
      const commands = await session.commands.getAll();
      const target = commands.find((c: { name?: string }) => c.name === commandId);
      if (!target) {
        // 命令已从进程表消失：要么已完成，要么从未存在。区分不了时
        // 如实报告（CLI --wait 循环会因此终止，提示用户前台跑）
        throw new SbxError(
          'PLATFORM_ERROR',
          `Command "${commandId}" is no longer visible in sandbox ${sandboxId} (finished commands are not queryable on this platform; run it in foreground to capture output)`,
        );
      }
      // 平台行为：wait 的输出依赖 open() 先订阅输出流（否则空串）
      await target.open();
      let exitCode: number | null = null;
      let status: CommandResult['status'] = 'running';
      let output = '';
      try {
        output = await target.waitUntilComplete();
        exitCode = 0;
        status = 'finished';
      } catch (err: unknown) {
        if (err instanceof CommandError) {
          exitCode = err.exitCode;
          output = err.output || '';
          status = exitCode === 0 ? 'finished' : 'failed';
        } else {
          throw err;
        }
      }
      return {
        commandId,
        stdout: output,
        stderr: '',
        exitCode,
        status,
      };
    } finally {
      session.dispose();
    }
  }

  async uploadFile(sandboxId: string, localPath: string, remotePath: string): Promise<void> {
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();
    try {
      const bytes = await readFile(localPath);
      await session.fs.writeFile(remotePath, new Uint8Array(bytes));
    } finally {
      session.dispose();
    }
  }

  async downloadFile(sandboxId: string, remotePath: string, localPath: string): Promise<void> {
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();
    try {
      // 平台 fs.download() 仅限 workspace 目录（/project/workspace）；
      // readFile() 无路径限制：统一走内容读取落盘，语义与其他平台对齐
      const bytes = await session.fs.readFile(remotePath);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, Buffer.from(bytes));
    } finally {
      session.dispose();
    }
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<string> {
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();
    try {
      // 公开沙箱直接返回端口 URL；私有沙箱 SDK 自动附加 host token
      return session.hosts.getUrl(port);
    } finally {
      session.dispose();
    }
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    const { sandboxes } = await this.client.sandboxes.list();
    return sandboxes.map((sbx) => ({
      sandboxId: sbx.id,
      platform: this.platform,
      state: 'unknown', // 列表 API 不含运行态，需另查 running 列表（P1 优化）
      createdAt: sbx.createdAt instanceof Date ? sbx.createdAt.toISOString() : sbx.createdAt,
    }));
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    // hibernate：文件保留、内存快照、停止计费，是 CSB 的“停止”语义
    await this.client.sandboxes.hibernate(sandboxId);
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.client.sandboxes.delete(sandboxId);
  }

  /**
   * Dockerfile/镜像 → 模板沙箱（复刻 csb build 核心流程，构建在 CSB 云端）：
   * 1. fork universal 默认模板得到构建沙箱
   * 2. 写入 .codesandbox/Dockerfile（镜像来源则合成 FROM 单阶段文件）
   * 3. restart —— 平台检测到 Dockerfile 后走镜像构建 + setup 流程
   * 4. 以 title=缓存名 落盘为可复用模板（list 查 title 判断缓存命中）
   */
  private async buildTemplateSandbox(
    source: { kind: 'dockerfile'; path: string } | { kind: 'image'; image: string },
    cacheName: string,
    forceRebuild: boolean,
  ): Promise<string> {
    // 缓存查询：workspace 沙箱列表按 title 匹配
    if (!forceRebuild) {
      try {
        const { sandboxes } = await this.client.sandboxes.list();
        const cached = sandboxes.find((s: { title?: string; id: string }) => s.title === cacheName);
        if (cached) {
          return cached.id;
        }
      } catch {
        // 列表查询失败不阻断，走正常构建
      }
    }

    // 1. fork 默认 universal 模板
    const buildSandbox = await this.client.sandboxes.create({ title: cacheName });
    const session = await buildSandbox.connect();
    try {
      // 2. Dockerfile 写入 .devcontainer/：universal 模板的 devcontainer.json
      //    声明 build.dockerfile = "Dockerfile"，restart 时平台据此在 VM 内
      //    Docker 构建新环境（.codesandbox/ 路径仅 csb build CLI 使用，实测无效）
      const dockerfileContent =
        source.kind === 'dockerfile'
          ? (await parseSingleStageDockerfile(source.path)).content
          : `FROM ${source.image}\n`;
      await session.fs.writeTextFile('/project/sandbox/.devcontainer/Dockerfile', dockerfileContent, { overwrite: true });
    } finally {
      session.dispose();
    }

    // 3. restart 触发平台构建（含 Dockerfile 构建与 setup tasks）
    await this.client.sandboxes.restart(buildSandbox.id);
    // restart 后重新连接等待 setup 完成（简单轮询 setup 状态）
    await this.waitForSandboxReady(buildSandbox.id);
    return buildSandbox.id;
  }

  /** 轮询沙箱 setup 就绪：restart 后平台需要时间完成构建 */
  private async waitForSandboxReady(sandboxId: string, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
        const session = await sandbox.connect();
        try {
          // 能连上并取到 setup 步骤即认为就绪（setup 完成由 restart 的 bootup 保证）
          const steps = await session.setup.getSteps();
          if (steps.length >= 0) {
            return;
          }
        } finally {
          session.dispose();
        }
      } catch {
        // 尚未就绪，继续轮询
      }
      await sleep(5_000);
    }
    throw new SbxError('PLATFORM_ERROR', `Sandbox ${sandboxId} not ready within ${timeoutMs / 1000}s`);
  }

  /** TTL 映射：hibernation 超时（无活动 N 秒后休眠，文件保留不计费） */
  private async applyHibernation(sandbox: Sandbox, ttlMinutes: number): Promise<void> {
    if (ttlMinutes > 0) {
      await sandbox.updateHibernationTimeout(ttlMinutes * 60);
    }
  }

  /** default 模板的环境变量：经 global session 命令注入（平台 create 不接收 env） */
  private async injectGlobalEnv(sandboxId: string, envVars: Record<string, string>): Promise<void> {
    // get() 返回轻量 DTO（无 connect）；resume() 返回完整 Sandbox 实例
    const sandbox = await this.client.sandboxes.resume(sandboxId);
    const session = await sandbox.connect();
    try {
      const exports = Object.entries(envVars)
        .map(([k, v]) => `export ${k}=${shellQuote(String(v))}`)
        .join(' && ');
      await session.commands.run(exports, { asGlobalSession: true });
    } finally {
      session.dispose();
    }
  }
}

/** Promise 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SbxError('PLATFORM_ERROR', message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

