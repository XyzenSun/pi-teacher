#!/usr/bin/env node
import { Command } from 'commander';
import type { SandboxSource } from './types.js';
import { SbxError } from './types.js';
import { getProvider, platformMetadata } from './platform-registry.js';
import { parseEnvFile, injectEnvEntries } from './envfile.js';

/**
 * CLI 退出码约定（与 PRD §9 一致）：
 * 0 = 成功；2 = CLI/参数/key 错误；3 = 平台/沙箱级错误；
 * run/result 额外透传沙箱内命令的 exit code。
 */
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_PLATFORM = 3;

const program = new Command();

program
  .name('sbx')
  .description('Unified CLI for cloud sandboxes (Daytona / E2B / CodeSandbox)')
  .version('0.1.0')
  .option('--envfile <path>', 'load env vars from a .env file before the command runs (real env vars take precedence)');

// ── 输出工具 ──────────────────────────────────────────────

/** 掩码 API key：保留前缀与末 4 位，其余打码（永不打印完整 key） */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** JSON 输出统一封装（含错误结构） */
function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

/** 错误归一出口：JSON 模式输出结构化错误，人读模式直接 stderr */
function handleError(error: unknown, json: boolean): never {
  if (error instanceof SbxError) {
    const exitCode = error.code === 'PLATFORM_ERROR' ? EXIT_PLATFORM : EXIT_USAGE;
    if (json) {
      emitJson({
        error: { code: error.code, message: error.message, platform: undefined, cause: String(error.cause ?? '') },
      });
    } else {
      console.error(`[sbx] ${error.message}`);
    }
    process.exit(exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    emitJson({ error: { code: 'PLATFORM_ERROR', message } });
  } else {
    console.error(`[sbx] Unexpected error: ${message}`);
  }
  process.exit(EXIT_PLATFORM);
}

/** 解析重复的 --env K=V 选项为 Record */
function parseEnvVars(envEntries: string[] | undefined): Record<string, string> | undefined {
  if (!envEntries || envEntries.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const entry of envEntries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex <= 0) {
      throw new SbxError('CLI_USAGE', `Invalid --env entry "${entry}" (expected KEY=VALUE)`);
    }
    result[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
  }
  return result;
}

/** --platform 校验与 Provider 获取（错误信息包含 export 提示） */
function resolveProvider(platform: string | undefined, json: boolean) {
  if (!platform) {
    if (process.env.SBX_DEFAULT_PLATFORM) {
      return getProvider(process.env.SBX_DEFAULT_PLATFORM);
    }
    handleError(new SbxError('CLI_USAGE', '--platform is required (or set SBX_DEFAULT_PLATFORM)'), json);
  }
  return getProvider(platform);
}

// ── 命令注册 ──────────────────────────────────────────────

program
  .command('list')
  .description('List available platforms (only those with configured API keys)')
  .option('--json', 'output structured JSON')
  .action((opts: { json?: boolean }) => {
    const configured = platformMetadata()
      .map((meta) => {
        const key = process.env[meta.apiKeyEnvName];
        return { ...meta, configured: Boolean(key && key.length > 0), key };
      })
      .filter((m) => m.configured);

    if (opts.json) {
      emitJson(
        configured.map(({ platform, apiKeyEnvName }) => ({ platform, configured: true, apiKeyEnvName })),
      );
      return;
    }

    if (configured.length === 0) {
      console.log('No platforms configured. Set one of the following environment variables:');
      for (const meta of platformMetadata()) {
        console.log(`  export ${meta.apiKeyEnvName}=<your-key>    # ${meta.displayName}`);
      }
      return;
    }

    console.log('PLATFORM       KEY (masked)          STATUS');
    for (const m of configured) {
      const platformPadded = m.platform.padEnd(14);
      const keyPadded = maskKey(m.key!).padEnd(21);
      console.log(`${platformPadded} ${keyPadded} ready`);
    }
  });

program
  .command('create')
  .description('Create a sandbox')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .option('--template <name>', 'use an existing platform template/snapshot')
  .option('--dockerfile <path>', 'build from a local Dockerfile (must be single-stage)')
  .option('--image <ref>', 'use a public Docker image (e.g. python:3.12-slim)')
  .option('--ttl <minutes>', 'auto-destroy timeout in minutes', '15')
  .option('--env <KEY=VALUE...>', 'environment variables (repeatable)')
  .option('--force-rebuild', 'skip template cache and force rebuild')
  .option('--json', 'output structured JSON')
  .action(async (opts: {
    platform: string;
    template?: string;
    dockerfile?: string;
    image?: string;
    ttl: string;
    env?: string[];
    forceRebuild?: boolean;
    json?: boolean;
  }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));

      // 环境来源三选一互斥校验
      const sources: string[] = ['template', 'dockerfile', 'image'].filter((k) => opts[k as keyof typeof opts]);
      if (sources.length > 1) {
        throw new SbxError('CLI_USAGE', `Options --${sources.join(' and --')} are mutually exclusive`);
      }

      let source: SandboxSource = { kind: 'default' };
      if (opts.template) source = { kind: 'template', template: opts.template };
      else if (opts.dockerfile) source = { kind: 'dockerfile', path: opts.dockerfile };
      else if (opts.image) source = { kind: 'image', image: opts.image };

      const ttlMinutes = Number(opts.ttl);
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
        throw new SbxError('CLI_USAGE', `Invalid --ttl value: ${opts.ttl} (must be a positive integer of minutes)`);
      }

      const info = await provider.createSandbox({
        source,
        ttlMinutes,
        envVars: parseEnvVars(opts.env),
        forceRebuild: opts.forceRebuild,
      });

      if (opts.json) {
        emitJson(info);
      } else {
        console.log(info.sandboxId);
        console.error(`platform: ${info.platform}`);
        console.error(`source:   ${info.sourceDescription}`);
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('run')
  .description('Run a command in a sandbox')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .argument('<command>', 'shell command to execute')
  .option('--cwd <dir>', 'working directory')
  .option('--env <KEY=VALUE...>', 'environment variables (repeatable)')
  .option('--timeout <seconds>', 'command timeout in seconds', '120')
  .option('--background', 'run in background, return commandId immediately')
  .option('--json', 'output structured JSON')
  .action(async (command: string, opts: {
    platform: string;
    sandbox: string;
    cwd?: string;
    env?: string[];
    timeout: string;
    background?: boolean;
    json?: boolean;
  }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      const result = await provider.runCommand({
        sandboxId: opts.sandbox,
        command,
        cwd: opts.cwd,
        env: parseEnvVars(opts.env),
        timeoutSeconds: Number(opts.timeout),
        background: Boolean(opts.background),
        // 人读模式实时流式输出；JSON 模式静默收集
        onStdout: opts.json ? undefined : (chunk) => process.stdout.write(chunk),
        onStderr: opts.json ? undefined : (chunk) => process.stderr.write(chunk),
      });

      if (opts.json) {
        emitJson(result);
      } else if (opts.background) {
        console.log(result.commandId);
        console.error(`poll with: sbx result -p ${opts.platform} -s ${opts.sandbox} ${result.commandId}`);
      } else {
        console.error(`exit code: ${result.exitCode}`);
      }
      // 透传沙箱内命令的退出码（CI/skill 判断成败的依据）
      process.exit(result.exitCode ?? EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('result')
  .description('Get the result of a background command')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .argument('<commandId>', 'command id from sbx run --background')
  .option('--wait', 'block until the command finishes')
  .option('--json', 'output structured JSON')
  .action(async (commandId: string, opts: { platform: string; sandbox: string; wait?: boolean; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      let result = await provider.getCommandResult(opts.sandbox, commandId);

      // --wait：轮询至结束（间隔 2s，无上限，交由用户 Ctrl-C）
      if (opts.wait && result.status === 'running') {
        while (result.status === 'running') {
          await new Promise((r) => setTimeout(r, 2000));
          result = await provider.getCommandResult(opts.sandbox, commandId);
        }
      }

      if (opts.json) {
        emitJson(result);
      } else {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        console.error(`exit code: ${result.exitCode}`);
      }
      process.exit(result.exitCode ?? EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('upload')
  .description('Upload a local file into a sandbox')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .argument('<localPath>', 'local file path')
  .argument('<remotePath>', 'remote destination path')
  .option('--json', 'output structured JSON')
  .action(async (localPath: string, remotePath: string, opts: { platform: string; sandbox: string; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      await provider.uploadFile(opts.sandbox, localPath, remotePath);
      if (opts.json) {
        emitJson({ uploaded: true, localPath, remotePath });
      } else {
        console.log(`uploaded: ${localPath} → ${remotePath}`);
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('download')
  .description('Download a file from a sandbox')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .argument('<remotePath>', 'remote file path')
  .argument('<localPath>', 'local destination path')
  .option('--json', 'output structured JSON')
  .action(async (remotePath: string, localPath: string, opts: { platform: string; sandbox: string; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      await provider.downloadFile(opts.sandbox, remotePath, localPath);
      if (opts.json) {
        emitJson({ downloaded: true, remotePath, localPath });
      } else {
        console.log(`downloaded: ${remotePath} → ${localPath}`);
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('preview')
  .description('Get the public preview URL for a sandbox port')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .requiredOption('--port <port>', 'port number', Number)
  .option('--json', 'output structured JSON')
  .action(async (opts: { platform: string; sandbox: string; port: number; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      const url = await provider.getPreviewUrl(opts.sandbox, opts.port);
      if (opts.json) {
        emitJson({ url, port: opts.port });
      } else {
        console.log(url);
        if (opts.platform === 'e2b') {
          console.error('note: the service inside the sandbox must bind 0.0.0.0');
        }
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('ps')
  .description('List sandboxes on a platform')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .option('--json', 'output structured JSON')
  .action(async (opts: { platform: string; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      const items = await provider.listSandboxes();
      if (opts.json) {
        emitJson(items);
      } else {
        console.log('SANDBOX ID                          STATE');
        for (const item of items) {
          console.log(`${item.sandboxId.padEnd(35)} ${item.state}`);
        }
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('stop')
  .description('Stop a sandbox (state preserved, billing reduced)')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .option('--json', 'output structured JSON')
  .action(async (opts: { platform: string; sandbox: string; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      await provider.stopSandbox(opts.sandbox);
      if (opts.json) {
        emitJson({ stopped: true, sandboxId: opts.sandbox });
      } else {
        console.log(`stopped: ${opts.sandbox}`);
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

program
  .command('destroy')
  .description('Permanently destroy a sandbox')
  .requiredOption('-p, --platform <platform>', 'daytona | e2b | codesandbox')
  .requiredOption('-s, --sandbox <id>', 'sandbox id')
  .option('--yes', 'skip confirmation (for scripts/skills)')
  .option('--json', 'output structured JSON')
  .action(async (opts: { platform: string; sandbox: string; yes?: boolean; json?: boolean }) => {
    try {
      const provider = resolveProvider(opts.platform, Boolean(opts.json));
      if (!opts.yes && !opts.json) {
        const answer = await new Promise<string>((resolve) => {
          process.stdout.write(`Destroy sandbox ${opts.sandbox} on ${opts.platform}? [y/N] `);
          process.stdin.once('data', (data) => resolve(data.toString().trim().toLowerCase()));
        });
        if (answer !== 'y' && answer !== 'yes') {
          console.error('aborted');
          process.exit(EXIT_USAGE);
        }
      }
      await provider.destroySandbox(opts.sandbox);
      if (opts.json) {
        emitJson({ destroyed: true, sandboxId: opts.sandbox });
      } else {
        console.log(`destroyed: ${opts.sandbox}`);
      }
      process.exit(EXIT_OK);
    } catch (error) {
      handleError(error, Boolean(opts.json));
    }
  });

// --envfile 注入钩子：对全部命令生效（含 list——key 只存在于文件时
// list 也要能显示平台）。真实环境变量优先，文件只补缺，key 永不打印。
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const envfilePath = program.opts().envfile;
  if (!envfilePath) return;
  try {
    injectEnvEntries(await parseEnvFile(envfilePath));
  } catch (error) {
    // hook 阶段的错误也要走统一出口（--json 结构化 + 约定退出码），
    // 否则 commander 会以未处理异常崩栈
    handleError(error, Boolean(actionCommand.opts().json));
  }
});

program.parseAsync(process.argv);
