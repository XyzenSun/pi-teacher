/**
 * @codesandbox/sdk 类型 shim（本地模块声明补丁）。
 *
 * 根因：SDK 0.210/2.4.2 的 dist/esm/*.d.ts 内部使用无扩展名相对导入
 * （如 `import ... from "./Sandbox"`），在 NodeNext 解析策略下 ESM 模块
 * 必须带显式扩展名，导致其类型树整体解析失败、全部塌缩为 any。
 * 运行时不受影响（CJS/ESM 加载器按目录解析正常）。
 *
 * 此 shim 以最小面积重新声明我们实际用到的 API 面，
 * 与 SDK 真实实现保持同步（升级 SDK 时需复核）。
 */

declare module '@codesandbox/sdk' {
  /** 沙箱本体（API 面经 sandboxes 获取，connect 后才有数据面） */
  export class Sandbox {
    readonly id: string;
    /** 在线热调整 VM 规格（不重启） */
    updateTier(tier: string): Promise<void>;
    /** 无活动 N 秒后自动休眠（秒） */
    updateHibernationTimeout(timeoutSeconds: number): Promise<void>;
    /** 建立数据面连接（文件/命令/端口），用完必须 dispose */
    connect(opts?: {
      env?: Record<string, string>;
      permission?: 'read' | 'write';
    }): Promise<SandboxClient>;
  }

  /** 数据面会话：fs / commands / hosts / ports / setup 命名空间 */
  export interface SandboxClient {
    readonly fs: SandboxFileSystem;
    readonly commands: SandboxCommands;
    readonly hosts: SandboxHosts;
    readonly ports: SandboxPorts;
    readonly setup: SandboxSetup;
    dispose(): void;
  }

  export interface SandboxFileSystem {
    writeFile(path: string, content: Uint8Array, opts?: { overwrite?: boolean }): Promise<void>;
    writeTextFile(path: string, content: string, opts?: { overwrite?: boolean }): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    readTextFile(path: string): Promise<string>;
    readdir(path: string): Promise<Array<{ name: string; type: string }>>;
    /** 返回 5 分钟有效下载 URL（受限 workspace 目录内文件） */
    download(path: string): Promise<{ downloadUrl: string }>;
  }

  export interface SandboxCommand {
    readonly command: string;
    readonly name?: string;
    readonly status: 'RUNNING' | 'FINISHED' | 'ERROR' | 'KILLED' | 'RESTARTING';
    onOutput(cb: (chunk: string) => void): void;
    /** 打开并订阅输出，返回当前累计输出 */
    open(dimensions?: { cols: number; rows: number }): Promise<string>;
    /** 等待命令完成，返回全部输出 */
    waitUntilComplete(): Promise<string>;
    kill(): Promise<void>;
  }

  export interface SandboxCommands {
    /** 后台启动命令，立即返回句柄（流式经 onOutput 订阅） */
    runBackground(
      command: string | string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        name?: string;
        asGlobalSession?: boolean;
      },
    ): Promise<SandboxCommand>;
    /** 阻塞执行并返回合并输出；非零退出抛 CommandError */
    run(command: string | string[], opts?: { cwd?: string; env?: Record<string, string>; asGlobalSession?: boolean }): Promise<string>;
    getAll(): Promise<SandboxCommand[]>;
  }

  export interface SandboxHosts {
    /** 端口对应公网 URL（私有沙箱自动附加 host token） */
    getUrl(port: number, protocol?: string): string;
    getHeaders(): Record<string, string>;
    getCookies(): Record<string, string>;
  }

  export interface SandboxPorts {
    waitForPort(port: number, opts?: { timeoutMs?: number }): Promise<{ port: number; host: string }>;
  }

  export interface SandboxSetup {
    getSteps(): Promise<Array<{ name?: string; status?: string }>>;
  }

  /** 创建选项（template 即 fork 源沙箱 id） */
  export interface CreateSandboxOpts {
    id?: string;
    title?: string;
    description?: string;
    tags?: string[];
    privacy?: 'public' | 'public-hosts' | 'private';
  }

  export interface SandboxListItem {
    id: string;
    title?: string;
    createdAt?: string | Date;
  }

  /** 非零退出码错误：waitUntilComplete 抛出，携带 exitCode 与合并输出 */
  export class CommandError extends Error {
    exitCode: number;
    output: string;
    constructor(message: string, exitCode: number, output: string);
  }

  export class CodeSandbox {
    constructor(apiToken?: string, opts?: { baseUrl?: string; headers?: Record<string, string> });
    readonly sandboxes: {
      create(opts?: CreateSandboxOpts): Promise<Sandbox>;
      /** get 返回轻量 DTO（无 connect 数据面）；resume 返回完整实例 */
      resume(sandboxId: string): Promise<Sandbox>;
      get(sandboxId: string): Promise<Sandbox>;
      list(opts?: { limit?: number }): Promise<{ sandboxes: SandboxListItem[]; totalCount: number }>;
      listRunning(): Promise<SandboxListItem[]>;
      restart(sandboxId: string, opts?: { vmTier?: string }): Promise<Sandbox>;
      hibernate(sandboxId: string): Promise<void>;
      shutdown(sandboxId: string): Promise<void>;
      delete(sandboxId: string): Promise<void>;
    };
    readonly hosts: {
      createToken(sandboxId: string, opts?: { expiresAt?: Date }): Promise<{ token: string }>;
    };
  }
}
