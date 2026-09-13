import { access, readFile } from 'node:fs/promises';
import { SbxError } from '../types.js';

/**
 * Dockerfile 单阶段校验结果。
 * 设计意图：CodeSandbox/E2B 平台构建能力仅支持单阶段，与其把平台的
 * 隐晦报错透传给用户，不如在 CLI 本地拦截并给出行号级提示。
 */
export interface ParsedDockerfile {
  /** 基础镜像引用（首个 FROM），用于镜像来源回显 */
  baseImage: string;
  /** 规整后的全文（原样返回，便于透传平台） */
  content: string;
}

/** 判断文件可读 */
async function assertFileReadable(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new SbxError('CLI_USAGE', `Dockerfile not found: ${path}`);
  }
}

/**
 * 校验 Dockerfile 必须单阶段构建。
 * 规则：全文只允许出现一条 FROM 指令（含 `FROM x AS y` 形式的多阶段特征）。
 * 语法错误的判定从简：无法解析出任何 FROM 也视为非法。
 */
export async function parseSingleStageDockerfile(path: string): Promise<ParsedDockerfile> {
  await assertFileReadable(path);

  const content = await readFile(path, 'utf-8');

  // 逐行扫描：忽略续行符（\\ 结尾拼接下一行）与注释，记录所有 FROM 出现位置
  const logicalLines: string[] = [];
  let pending = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = pending + rawLine;
    if (line.trimEnd().endsWith('\\')) {
      pending = line.trimEnd().slice(0, -1) + ' ';
      continue;
    }
    pending = '';
    logicalLines.push(line);
  }

  const fromLines: Array<{ lineNo: number; image: string }> = [];
  logicalLines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      return;
    }
    // FROM [--platform=xxx] image[:tag][ AS name]
    const fromMatch = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?$/i.exec(trimmed);
    if (fromMatch) {
      fromLines.push({ lineNo: index + 1, image: fromMatch[1] });
    }
  });

  if (fromLines.length === 0) {
    throw new SbxError(
      'DOCKERFILE_INVALID',
      `Dockerfile "${path}" contains no FROM instruction; a valid single-stage build must start with one FROM`,
    );
  }

  if (fromLines.length > 1) {
    const locations = fromLines.map((f) => `line ${f.lineNo} (FROM ${f.image})`).join(', ');
    throw new SbxError(
      'DOCKERFILE_INVALID',
      `Dockerfile "${path}" is multi-stage (found ${fromLines.length} FROM instructions: ${locations}). ` +
        'Only single-stage builds are supported; merge the stages or pre-build the artifact and COPY it in',
    );
  }

  return { baseImage: fromLines[0].image, content };
}
