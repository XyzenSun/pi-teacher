import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { E2B, Template as E2BTemplateBuilder, CommandExitError } from 'e2b';
import type {
  CommandResult,
  CreateSandboxParams,
  RunCommandParams,
  SandboxInfo,
  SandboxProvider,
  SandboxSummary,
} from '../types.js';
import { SbxError } from '../types.js';
import { nameTemplate } from '../template-naming.js';

const API_KEY_ENV = 'E2B_API_KEY';

export class E2BProvider implements SandboxProvider {
  readonly platform = 'e2b' as const;
  readonly displayName = 'E2B';
  readonly apiKeyEnvName = API_KEY_ENV;

  private readonly client: E2B;

  constructor() {
    if (!process.env[API_KEY_ENV]) {
      throw new SbxError('MISSING_API_KEY', `Environment variable ${API_KEY_ENV} is not set`);
    }
    // E2B SDK 自动读取 E2B_API_KEY / E2B_DOMAIN / E2B_API_URL
    this.client = new E2B();
  }

  isConfigured(): boolean {
    return Boolean(process.env[API_KEY_ENV]);
  }

  async createSandbox(params: CreateSandboxParams): Promise<SandboxInfo> {
    const { source, ttlMinutes, envVars } = params;
    // E2B Hobby 档沙箱上限 1h：TTL 按上限截断，避免创建被平台拒绝
    const timeoutMs = Math.min(ttlMinutes, 60) * 60 * 1000;

    let template: string | undefined;
    let sourceDescription = 'base (default template)';

    if (source.kind === 'template') {
      template = source.template;
      sourceDescription = `template: ${source.template}`;
    } else if (source.kind === 'dockerfile' || source.kind === 'image') {
      // 单阶段校验在 nameTemplate 内部完成（复用 parser）
      const naming = (await nameTemplate(source))!;
      template = await this.buildTemplateWithCache(source, naming.name, params.forceRebuild ?? false);
      sourceDescription = naming.description;
    }

    const sandbox = await this.client.Sandbox.create({
      template,
      envs: envVars,
      // 超时即销毁（kill），与 CLI 的 TTL 语义保持一致
      timeoutMs,
    });

    return {
      sandboxId: sandbox.sandboxId,
      platform: this.platform,
      sourceDescription,
    };
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    const { sandboxId, command, cwd, env, timeoutSeconds, background, onStdout, onStderr } = params;
    const sandbox = await this.client.Sandbox.connect(sandboxId);

    if (background) {
      const handle = await sandbox.commands.run(command, {
        cwd,
        envs: env,
        timeoutMs: timeoutSeconds * 1000,
        background: true,
      });
      return {
        commandId: String(handle.pid),
        stdout: '',
        stderr: '',
        exitCode: null,
        status: 'running',
      };
    }

    // 前台模式：等待完成并取分离的 stdout/stderr（E2B 原生支持）。
    // 非零退出时 SDK 抛 CommandExitError（实现 CommandResult），须捕获归一化——
    // 业务命令失败是“结果”而非“错误”
    let result;
    try {
      result = await sandbox.commands.run(command, {
        cwd,
        envs: env,
        timeoutMs: timeoutSeconds * 1000,
        onStdout,
        onStderr,
      });
    } catch (error) {
      if (error instanceof CommandExitError) {
        result = error;
      } else {
        throw error;
      }
    }
    return {
      // 同步模式无独立句柄 ID：标记为一次性命令（不可再查询，语义与 --background 区分）
      commandId: 'sync',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? 'finished' : 'failed',
    };
  }

  async getCommandResult(sandboxId: string, commandId: string): Promise<CommandResult> {
    const sandbox = await this.client.Sandbox.connect(sandboxId);
    // 后台命令标识是 pid：connect(pid) 重挂载句柄后 wait 拿分离结果
    const handle = await sandbox.commands.connect(Number(commandId));
    let result;
    try {
      result = await handle.wait();
    } catch (error) {
      if (error instanceof CommandExitError) {
        result = error;
      } else {
        throw error;
      }
    }
    return {
      commandId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? 'finished' : 'failed',
    };
  }

  async uploadFile(sandboxId: string, localPath: string, remotePath: string): Promise<void> {
    const sandbox = await this.client.Sandbox.connect(sandboxId);
    // E2B files.write(path, data) 的 data 是内容而非本地路径：读文件后写入
    const bytes = await readFile(localPath);
    // SDK 类型面收 string/ArrayBuffer/Blob/ReadableStream：Buffer → ArrayBuffer
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await sandbox.files.write(remotePath, arrayBuffer);
  }

  async downloadFile(sandboxId: string, remotePath: string, localPath: string): Promise<void> {
    const sandbox = await this.client.Sandbox.connect(sandboxId);
    const bytes = await sandbox.files.read(remotePath, { format: 'bytes' });
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, bytes);
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<string> {
    const sandbox = await this.client.Sandbox.connect(sandboxId);
    return `https://${sandbox.getHost(port)}`;
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    // SandboxPaginator 提供 hasNext/nextItems 分页协议（非 async iterator）
    const paginator = this.client.Sandbox.list();
    const items: SandboxSummary[] = [];
    while (paginator.hasNext) {
      for (const info of await paginator.nextItems()) {
        items.push({
          sandboxId: info.sandboxId,
          platform: this.platform,
          state: info.state,
          createdAt: info.startedAt?.toISOString(),
        });
      }
    }
    return items;
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.client.Sandbox.connect(sandboxId);
    await sandbox.pause(); // pause 保留完整内存且不计费，是 E2B 的“停止”最优解
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.client.Sandbox.kill(sandboxId);
  }

  /**
   * E2B 模板构建 + 缓存：同名模板存在则直接复用。
   * 设计意图：构建是分钟级操作，内容寻址命名让同一 Dockerfile/镜像
   * 只构建一次；--force-rebuild 走 skipCache 让平台全量重建。
   */
  private async buildTemplateWithCache(
    source: { kind: 'dockerfile'; path: string } | { kind: 'image'; image: string },
    cacheName: string,
    forceRebuild: boolean,
  ): Promise<string> {
    if (!forceRebuild) {
      try {
        const exists = await this.client.Template.exists(cacheName);
        if (exists) {
          return cacheName;
        }
      } catch {
        // exists 查询失败不阻断流程，走正常构建兜底
      }
    }

    // fromDockerfile 接收路径或全文；fromImage 接收镜像引用。
    // build 是静态方法（非链式）：Template.build(builder, name, opts)
    const builder =
      source.kind === 'dockerfile'
        ? E2BTemplateBuilder().fromDockerfile(source.path)
        : E2BTemplateBuilder().fromImage(source.image);

    await this.client.Template.build(
      builder,
      cacheName,
      forceRebuild ? { skipCache: true } : undefined,
    );
    return cacheName;
  }
}
