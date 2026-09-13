import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Daytona, Image } from '@daytona/sdk';
import type { CreateSandboxFromSnapshotParams, CreateSandboxFromImageParams, DaytonaConfig } from '@daytona/sdk';
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

const API_KEY_ENV = 'DAYTONA_API_KEY';

/**
 * Daytona 的所有 CLI 命令复用同一个 session id：
 * stateless 模式下 stdout/stderr 合并返回，session 模式才有独立
 * stdout/stderr/exitCode/cmdId —— 这是统一结果结构的前提。
 * 固定 id 还让沙箱内 shell 状态跨命令保持（cd/环境变量生效）。
 */
const SESSION_ID = 'sbx-cli';

export class DaytonaProvider implements SandboxProvider {
  readonly platform = 'daytona' as const;
  readonly displayName = 'Daytona';
  readonly apiKeyEnvName = API_KEY_ENV;

  private readonly daytona: Daytona;

  constructor() {
    if (!process.env[API_KEY_ENV]) {
      throw new SbxError('MISSING_API_KEY', `Environment variable ${API_KEY_ENV} is not set`);
    }
    const config: DaytonaConfig = { apiKey: process.env[API_KEY_ENV] };
    // 支持经反代访问：显式 env 优先（SDK 自身也读 DAYTONA_API_URL，双保险）
    if (process.env.DAYTONA_API_URL) {
      config.apiUrl = process.env.DAYTONA_API_URL;
    }
    this.daytona = new Daytona(config);
  }

  isConfigured(): boolean {
    return Boolean(process.env[API_KEY_ENV]);
  }

  async createSandbox(params: CreateSandboxParams): Promise<SandboxInfo> {
    const { source, ttlMinutes, envVars } = params;

    let createParams: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams;
    let sourceDescription: string;

    if (source.kind === 'template') {
      createParams = { snapshot: source.template };
      sourceDescription = `snapshot: ${source.template}`;
    } else if (source.kind === 'image') {
      // Daytona 支持直接从公共镜像创建（平台自动做 snapshot），无需预构建
      // 注意：镜像必须带具体 tag/digest（latest/stable/lts 不被接受）
      createParams = { image: source.image };
      sourceDescription = `image: ${source.image}`;
    } else if (source.kind === 'dockerfile') {
      // 单阶段校验 + 内容寻址命名，然后 Daytona 云端构建为 snapshot（缓存复用）
      const parsed = await parseSingleStageDockerfile(source.path);
      const naming = await nameTemplate(source);
      const snapshotName = naming!.name;
      await this.buildSnapshotWithCache(source.path, snapshotName, params.forceRebuild ?? false);
      createParams = { snapshot: snapshotName };
      sourceDescription = naming!.description;
    } else {
      createParams = {}; // 默认快照 daytona-small
      sourceDescription = 'daytona-small (default snapshot)';
    }

    if (envVars) {
      createParams.envVars = envVars;
    }
    // TTL 映射：停止 N 分钟后自动删除；到期强制销毁用 autoDestroyAt 语义近似
    if (ttlMinutes > 0) {
      createParams.autoDeleteInterval = ttlMinutes;
    }

    const sandbox = await this.daytona.create(createParams);
    return {
      sandboxId: sandbox.id,
      platform: this.platform,
      sourceDescription,
    };
  }

  /**
   * 幂等确保 session 存在：session 不存在时 executeSessionCommand 会报
   * "session not found"。已存在时 getSession 成功，直接复用。
   */
  private async ensureSession(sandbox: import('@daytona/sdk').Sandbox): Promise<void> {
    try {
      await sandbox.process.getSession(SESSION_ID);
    } catch {
      await sandbox.process.createSession(SESSION_ID);
    }
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    const { sandboxId, command, cwd, env, timeoutSeconds, background, onStdout, onStderr } = params;
    const sandbox = await this.daytona.get(sandboxId);

    // session 必须先创建才能执行：幂等保证（已存在时 createSession 报错，先查后建）
    await this.ensureSession(sandbox);

    // 有 env/cwd 需求时前置一条 export/cd：session API 本身不带 env 参数
    const effectiveCommand = composeSessionCommand(command, cwd, env);

    // session 模式：独立 stdout/stderr/exitCode/cmdId（stateless 模式做不到）
    const response = await sandbox.process.executeSessionCommand(
      SESSION_ID,
      { command: effectiveCommand, runAsync: background },
      timeoutSeconds,
    );

    if (background) {
      return {
        commandId: response.cmdId,
        stdout: '',
        stderr: '',
        exitCode: null,
        status: 'running',
      };
    }

    // 同步模式：整体返回后一次性回放（Daytona session 同步执行无逐块回调）
    const stdout = response.stdout ?? '';
    const stderr = response.stderr ?? '';
    const exitCode = response.exitCode ?? null;
    if (onStdout && stdout) onStdout(stdout);
    if (onStderr && stderr) onStderr(stderr);
    return {
      commandId: response.cmdId,
      stdout,
      stderr,
      exitCode,
      status: exitCode === 0 ? 'finished' : 'failed',
    };
  }

  async getCommandResult(sandboxId: string, commandId: string): Promise<CommandResult> {
    const sandbox = await this.daytona.get(sandboxId);
    await this.ensureSession(sandbox);
    // 后台命令轮询：取命令状态与分离日志
    const command = await sandbox.process.getSessionCommand(SESSION_ID, commandId);
    const logs = await sandbox.process.getSessionCommandLogs(SESSION_ID, commandId);
    const exitCode = command.exitCode ?? null;
    return {
      commandId,
      stdout: logs.stdout ?? '',
      stderr: logs.stderr ?? '',
      exitCode,
      status: exitCode == null ? 'running' : exitCode === 0 ? 'finished' : 'failed',
    };
  }

  async uploadFile(sandboxId: string, localPath: string, remotePath: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.fs.uploadFile(localPath, remotePath);
  }

  async downloadFile(sandboxId: string, remotePath: string, localPath: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    const buffer = await sandbox.fs.downloadFile(remotePath);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, buffer);
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<string> {
    const sandbox = await this.daytona.get(sandboxId);
    // 签名 URL（token 内嵌，浏览器可直开，默认 1h 有效）
    const signed = await sandbox.getSignedPreviewUrl(port, 3600);
    return signed.url;
  }

  async listSandboxes(): Promise<SandboxSummary[]> {
    // list() 返回异步迭代器而非数组：收集为统一结构
    const items: SandboxSummary[] = [];
    for await (const sbx of this.daytona.list()) {
      items.push({
        sandboxId: sbx.id,
        platform: this.platform,
        state: sbx.state ?? 'unknown',
      });
    }
    return items;
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.stop();
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.delete();
  }

  /**
   * Dockerfile → Daytona snapshot（构建在 Daytona 云端）+ 按 name 缓存。
   * 设计意图：snapshot 构建是分钟级操作；内容寻址命名（sbx-<base>-<hash8>）
   * 让同一 Dockerfile 只构建一次。--force-rebuild 时先删旧再建。
   */
  private async buildSnapshotWithCache(dockerfilePath: string, snapshotName: string, forceRebuild: boolean): Promise<string> {
    if (!forceRebuild) {
      try {
        const existing = await this.daytona.snapshot.get(snapshotName);
        if (existing) {
          return existing.name ?? snapshotName;
        }
      } catch {
        // 不存在（404）或查询失败：走正常构建
      }
    }

    const image = Image.fromDockerfile(dockerfilePath);
    const snapshot = await this.daytona.snapshot.create({ name: snapshotName, image });
    return snapshot.name ?? snapshotName;
  }
}

/**
 * 组装 session 命令：session API 不接收 cwd/env 参数，
 * 通过 shell 前缀注入。env 值做单引号转义防注入。
 */
function composeSessionCommand(command: string, cwd?: string, env?: Record<string, string>): string {
  const parts: string[] = [];
  if (cwd) {
    parts.push(`cd ${shellQuote(cwd)} || exit 1`);
  }
  if (env && Object.keys(env).length > 0) {
    const exports = Object.entries(env)
      .map(([key, value]) => `${shellEscapeKey(key)}=${shellQuote(String(value))}`)
      .join(' ');
    parts.push(`export ${exports}`);
  }
  parts.push(command);
  return parts.join(' && ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEscapeKey(key: string): string {
  // env key 只允许字母数字下划线，其余直接拒绝（防注入）
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new SbxError('CLI_USAGE', `Invalid environment variable name: ${key}`);
  }
  return key;
}
