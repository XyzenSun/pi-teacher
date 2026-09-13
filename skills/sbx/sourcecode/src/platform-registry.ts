import type { PlatformId, SandboxProvider } from './types.js';
import { SbxError } from './types.js';
import { DaytonaProvider } from './providers/daytona-provider.js';
import { E2BProvider } from './providers/e2b-provider.js';
import { CodeSandboxProvider } from './providers/codesandbox-provider.js';

/**
 * 平台注册表：新增平台只需在此追加一行（构造函数懒加载，
 * 避免“仅 list 其他平台”时因某平台缺 key 而整体失败）。
 */
const REGISTRY: ReadonlyArray<{
  platform: PlatformId;
  displayName: string;
  apiKeyEnvName: string;
  create: () => SandboxProvider;
}> = [
  {
    platform: 'daytona',
    displayName: 'Daytona',
    apiKeyEnvName: 'DAYTONA_API_KEY',
    create: () => new DaytonaProvider(),
  },
  {
    platform: 'e2b',
    displayName: 'E2B',
    apiKeyEnvName: 'E2B_API_KEY',
    create: () => new E2BProvider(),
  },
  {
    platform: 'codesandbox',
    displayName: 'CodeSandbox',
    apiKeyEnvName: 'CODESANDBOX_API_KEY',
    create: () => new CodeSandboxProvider(),
  },
];

/** 静态元信息（list 命令用，不触发 SDK 构造） */
export function platformMetadata(): ReadonlyArray<{
  platform: PlatformId;
  displayName: string;
  apiKeyEnvName: string;
}> {
  return REGISTRY.map(({ platform, displayName, apiKeyEnvName }) => ({ platform, displayName, apiKeyEnvName }));
}

/** 取平台 Provider 实例（key 未配置时抛 CLI_USAGE 级错误） */
export function getProvider(platform: string): SandboxProvider {
  const entry = REGISTRY.find((r) => r.platform === platform);
  if (!entry) {
    const valid = REGISTRY.map((r) => r.platform).join(', ');
    throw new SbxError('CLI_USAGE', `Unknown platform "${platform}". Valid values: ${valid}`);
  }
  return entry.create();
}
