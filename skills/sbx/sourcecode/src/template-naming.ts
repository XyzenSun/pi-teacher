import { createHash } from 'node:crypto';
import type { SandboxSource } from './types.js';
import { parseSingleStageDockerfile } from './dockerfile/parser.js';

/**
 * 模板命名结果：名字 = `sbx-<描述段>-<内容hash8>`。
 * 把 parser 的解析结果一并带出，避免调用方重复读文件/解析。
 */
export interface TemplateNaming {
  /** 确定性模板名（内容寻址） */
  name: string;
  /** 人读的来源描述，用于 create 输出回显 */
  description: string;
}

/**
 * 为需要云端构建的来源（dockerfile / image）生成确定性模板名。
 *
 * 设计意图：云平台把 Dockerfile/镜像构建为模板是分钟级操作，
 * 内容寻址命名（描述段可读 + hash8 唯一）让同一来源只构建一次：
 * - 描述段：基础镜像名/tag 归一化而来，人能看出环境是什么
 * - hash8：内容指纹，Dockerfile 文本或镜像引用一变即产生新名，
 *   天然防重复、防串环境
 *
 * default / template 来源无需构建，返回 null。
 */
export async function nameTemplate(source: SandboxSource): Promise<TemplateNaming | null> {
  if (source.kind === 'dockerfile') {
    // parser 同时完成单阶段校验与 baseImage 提取，一箭双雕
    const parsed = await parseSingleStageDockerfile(source.path);
    const hash = contentHash(parsed.content);
    const name = `sbx-${slugify(parsed.baseImage)}-${hash}`;
    return {
      name,
      description: `dockerfile ${source.path} (base: ${parsed.baseImage}) → template "${name}"`,
    };
  }
  if (source.kind === 'image') {
    // 镜像引用本身即内容：规范化小写后 hash，避免 tag 大小写造成缓存分裂
    const normalized = source.image.toLowerCase();
    const hash = contentHash(normalized);
    const name = `sbx-${slugify(normalized)}-${hash}`;
    return {
      name,
      description: `image ${source.image} → template "${name}"`,
    };
  }
  return null;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

/**
 * 把镜像引用压成 slug：`python:3.12-slim` → `python-3.12-slim`，
 * `registry.com/org/app:v2` → `registry-com-org-app-v2`。
 * 非法字符（路径分隔、冒号、@digest）统一折叠为 `-`。
 */
function slugify(ref: string): string {
  // 点号折叠为横线：E2B 模板名不允许点号（400 Invalid alias format），
  // 统一三家规则，避免按平台分叉命名逻辑
  const slug = ref
    .toLowerCase()
    .replace(/[/@:.]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'base';
}
