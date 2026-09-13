/**
 * 统一平台标识。
 * 值与 CLI `--platform` 参数一一对应；新增平台时在此追加并同步更新
 * `platformRegistry` 与环境变量映射，保持“约定优于配置”。
 */
export type PlatformId = 'daytona' | 'e2b' | 'codesandbox';

/**
 * 沙箱环境来源（四选一）：
 * - default     平台默认模板，零配置快速验证
 * - template    平台已存在的模板/快照名（用户自建或平台内置）
 * - dockerfile  本地 Dockerfile（强制单阶段，见 dockerfile/parser）
 * - image       公共 Docker 镜像引用（须带 tag 或 digest）
 */
export type SandboxSource =
  | { kind: 'default' }
  | { kind: 'template'; template: string }
  | { kind: 'dockerfile'; path: string }
  | { kind: 'image'; image: string };

/** create 命令的完整参数 */
export interface CreateSandboxParams {
  source: SandboxSource;
  /** 自动销毁时间（分钟），防烧钱默认值由 CLI 层决定 */
  ttlMinutes: number;
  envVars?: Record<string, string>;
  /** 模板缓存默认开启；true 时强制重建（--force-rebuild） */
  forceRebuild?: boolean;
}

/** run 命令参数 */
export interface RunCommandParams {
  sandboxId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** 命令超时（秒） */
  timeoutSeconds: number;
  /** true 时立即返回 commandId，不等待结束 */
  background: boolean;
  /** stdout/stderr 实时回调（前台模式流式输出） */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** 归一化命令结果：三家平台的差异在 Provider 内部抹平 */
export interface CommandResult {
  commandId: string;
  stdout: string;
  stderr: string;
  /** null 表示仍在运行（后台模式轮询时） */
  exitCode: number | null;
  status: 'running' | 'finished' | 'failed' | 'timeout';
}

/** create 命令的归一化返回 */
export interface SandboxInfo {
  sandboxId: string;
  platform: PlatformId;
  /** 实际使用的环境来源描述（如模板名/镜像名），用于输出回显 */
  sourceDescription: string;
}

/** ps 命令的归一化条目 */
export interface SandboxSummary {
  sandboxId: string;
  platform: PlatformId;
  state: string;
  createdAt?: string;
}

/**
 * Provider 统一能力面。
 * CLI 层不含任何平台逻辑；所有平台差异（stderr 分离、文件 API 命名、
 * TTL 映射等）都必须封闭在各 Provider 实现内。
 */
export interface SandboxProvider {
  readonly platform: PlatformId;
  readonly displayName: string;
  /** 环境变量名（用于 list 展示与错误提示） */
  readonly apiKeyEnvName: string;

  /** API key 是否已配置（list 命令据此过滤展示） */
  isConfigured(): boolean;

  createSandbox(params: CreateSandboxParams): Promise<SandboxInfo>;
  runCommand(params: RunCommandParams): Promise<CommandResult>;
  /** 按 commandId 查询后台命令状态/日志 */
  getCommandResult(sandboxId: string, commandId: string): Promise<CommandResult>;
  uploadFile(sandboxId: string, localPath: string, remotePath: string): Promise<void>;
  downloadFile(sandboxId: string, remotePath: string, localPath: string): Promise<void>;
  /** 返回端口对应的公网预览 URL（各家 URL 规则不同，由实现拼接） */
  getPreviewUrl(sandboxId: string, port: number): Promise<string>;
  listSandboxes(): Promise<SandboxSummary[]>;
  stopSandbox(sandboxId: string): Promise<void>;
  destroySandbox(sandboxId: string): Promise<void>;
}

/** 业务错误码：决定 CLI 退出码与 --json 错误结构 */
export type ErrorCode =
  | 'CLI_USAGE'          // 参数/用法错误 → 退出码 2
  | 'MISSING_API_KEY'    // key 未配置 → 退出码 2
  | 'DOCKERFILE_INVALID' // Dockerfile 多阶段/语法错误 → 退出码 2
  | 'PLATFORM_ERROR';    // 平台 API/沙箱级错误 → 退出码 3

/** CLI 层统一错误：携带错误码，供退出码映射 */
export class SbxError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SbxError';
  }
}
