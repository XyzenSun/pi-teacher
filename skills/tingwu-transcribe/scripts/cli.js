#!/usr/bin/env node
// 通义听悟命令行入口（供 AI / 自动化使用）：无 UI，纯 CLI 操作转写全流程。
// 与 server.js（HTTP 网关）共享 core.js 业务编排，无需先启动服务。
//
// 输出约定（便于调用方程序化解析）：
//   - 成功：JSON 到 stdout（export/txt 的文件内容模式除外）
//   - 业务失败：{error, code, detail} JSON 到 stderr，退出码 1
//   - 用法错误：提示文本到 stderr，退出码 2
import fs from 'node:fs';
import path from 'node:path';

import {
  loadCookieFromDisk,
  setCookieValue,
  normalizeCookieValue,
  markCookieValid,
} from './cookie-store.js';
import { getTransStatus, getTransList, checkCookieValid, TingwuApiError } from './tingwu-client.js';
import {
  GatewayError,
  requireCookie,
  transcribeFile,
  getTranscriptResultParsed,
  exportTranscript,
  buildTxtContent,
} from './core.js';

const USAGE = `用法: node cli.js <command> [args] [options]

命令:
  transcribe <文件路径|URL>   上传并转写音视频
  status <transId>           查询转写状态
  result <transId>           获取转写结果（--text 只出全文纯文本）
  list                       列出转写任务
  export <transId>           导出 SRT（-o 写文件，省略则输出到 stdout）
  txt <transId>              导出带说话人时间戳的纯文本
  cookie set <纯Cookie值>     设置并验证 Cookie（值传 - 则从 stdin 读）
  cookie check               检查当前 Cookie 是否有效
  help                       显示本帮助

完整参数说明见 references/cli.md`;

// 用法错误与业务错误分开：前者是调用方笔误，提示文本即可，不必输出 JSON
class CliUsageError extends Error {}

// 解析 --key value / --key=value / 无值 flag；其余归入位置参数。
// 无值 flag 显式列出，避免把下一个位置参数误吞为 flag 值。
const BOOLEAN_FLAGS = new Set(['wait', 'raw-url', 'text']);
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      if (eqIndex > -1) {
        flags[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      } else if (BOOLEAN_FLAGS.has(token.slice(2))) {
        flags[token.slice(2)] = true;
      } else {
        const value = argv[i + 1];
        if (value === undefined) throw new CliUsageError(`选项 ${token} 缺少值`);
        flags[token.slice(2)] = value;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function requirePositional(positional, index, usage) {
  const value = positional[index];
  if (!value) throw new CliUsageError(usage);
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

// ---- 命令实现 ----

async function cmdTranscribe({ positional, flags }) {
  const input = requirePositional(positional, 0, '用法: transcribe <本地文件路径|http(s)URL>');
  // Cookie 检查前置：缺失时立即报 COOKIE_MISSING，比文件读取错误对调用方更有引导性
  const cookie = requireCookie();
  let fileBuffer;
  let filename;
  if (/^https?:\/\//i.test(input)) {
    const downloadResponse = await fetch(input);
    if (!downloadResponse.ok) {
      throw new GatewayError(400, 'FILE_DOWNLOAD_FAILED', `下载 URL 失败：HTTP ${downloadResponse.status}`);
    }
    fileBuffer = Buffer.from(await downloadResponse.arrayBuffer());
    // URL 以 / 结尾时 pop() 得空串，用 || 兜底（?? 捕获不了空串）
    filename = decodeURIComponent(new URL(input).pathname.split('/').pop() || '') || 'input.mp3';
  } else {
    try {
      fileBuffer = fs.readFileSync(input);
    } catch (cause) {
      throw new GatewayError(400, 'FILE_READ_FAILED', `读取本地文件失败：${cause.message}`);
    }
    filename = path.basename(input);
  }
  const summary = await transcribeFile({
    fileBuffer,
    filename,
    showName: flags['show-name'],
    lang: flags.lang,
    roleSplitNum: Number(flags['role-split'] ?? 0) || 0,
    dirId: Number(flags['dir-id'] ?? 0) || 0,
    wait: Boolean(flags.wait),
    // --timeout 单位为秒，与 README/references 约定一致，这里转毫秒
    waitTimeoutMs: Number(flags.timeout ?? 900) * 1000,
  }, cookie);
  printJson(summary);
}

async function cmdStatus({ positional }) {
  const transId = requirePositional(positional, 0, '用法: status <transId>');
  const cookie = requireCookie();
  printJson(await getTransStatus({ transIds: [transId], preview: 1 }, cookie));
}

async function cmdResult({ positional, flags }) {
  const transId = requirePositional(positional, 0, '用法: result <transId> [--text]');
  const cookie = requireCookie();
  const result = await getTranscriptResultParsed(transId, cookie);
  // --text 只出全文纯文本，便于直接贴给用户；默认输出完整 JSON 结构
  if (flags.text) console.log(result.text);
  else printJson(result);
}

async function cmdList({ flags }) {
  const cookie = requireCookie();
  printJson(await getTransList({
    pageNo: Number(flags.page ?? 1),
    pageSize: Number(flags.size ?? 20),
    filter: {
      status: flags.status !== undefined ? [Number(flags.status)] : [],
      showName: flags.name ?? '',
    },
  }, cookie));
}

async function cmdExport({ positional, flags }) {
  const transId = requirePositional(positional, 0, '用法: export <transId> [-o out.srt] [--raw-url]');
  const cookie = requireCookie();
  const outcome = await exportTranscript({
    transId,
    fileType: flags['file-type'],
    rawUrl: Boolean(flags['raw-url']),
  }, cookie);
  if (outcome.downloadUrl) {
    printJson(outcome);
    return;
  }
  // -o 写文件；省略则内容输出到 stdout（文件名打到 stderr，不污染 stdout 内容）
  if (flags.o) {
    fs.writeFileSync(flags.o, outcome.buffer);
    printJson({ written: path.resolve(flags.o), filename: outcome.filename });
  } else {
    process.stderr.write(`# ${outcome.filename}\n`);
    process.stdout.write(outcome.buffer);
  }
}

async function cmdTxt({ positional, flags }) {
  const transId = requirePositional(positional, 0, '用法: txt <transId> [-o out.txt]');
  const cookie = requireCookie();
  const parsed = await getTranscriptResultParsed(transId, cookie);
  const content = buildTxtContent(parsed);
  if (flags.o) {
    fs.writeFileSync(flags.o, content);
    printJson({ written: path.resolve(flags.o) });
  } else {
    console.log(content);
  }
}

async function cmdCookie({ positional }) {
  const subcommand = positional[0];
  if (subcommand === 'set') {
    let rawValue = positional[1];
    if (rawValue === '-') rawValue = await readStdin();
    if (!rawValue) throw new CliUsageError('用法: cookie set <纯Cookie值>（值传 - 则从 stdin 读）');
    const cookie = normalizeCookieValue(rawValue);
    if (!cookie) {
      throw new GatewayError(400, 'COOKIE_INVALID_FORMAT',
        'Cookie 格式无效，请直接粘贴完整的 name=value; name2=value2 内容');
    }
    // 先用候选 Cookie 做真实只读验证；验证成功后才替换当前 Cookie 并落盘，
    // 避免误粘贴导致原本可用的登录状态丢失（与 server 的 POST /cookie 行为一致）。
    const probe = await checkCookieValid(cookie, { pageSize: 5 });
    setCookieValue(cookie);
    markCookieValid();
    printJson({ cookieUpdated: true, cookieValid: true, totalTranscripts: probe.total ?? 0 });
    return;
  }
  if (subcommand === 'check') {
    const cookie = requireCookie({ allowInvalid: true });
    const probe = await checkCookieValid(cookie, { pageSize: 5 });
    markCookieValid();
    printJson({ cookieValid: true, totalTranscripts: probe.total ?? 0 });
    return;
  }
  throw new CliUsageError('用法: cookie set <纯Cookie值> | cookie check');
}

const COMMANDS = {
  transcribe: cmdTranscribe,
  status: cmdStatus,
  result: cmdResult,
  list: cmdList,
  export: cmdExport,
  txt: cmdTxt,
  cookie: cmdCookie,
};

async function main() {
  loadCookieFromDisk();
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new CliUsageError(`未知命令: ${command}\n\n${USAGE}`);
  await handler(parseArgs(rest));
}

main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    process.exit(2);
  }
  // 已知业务错误输出结构化 JSON；未知错误保留堆栈便于排查
  const isKnownError = error instanceof GatewayError || error instanceof TingwuApiError;
  if (isKnownError) {
    console.error(JSON.stringify({ error: error.message, code: error.code ?? 'INTERNAL_ERROR', detail: error.detail }));
  } else {
    console.error(error);
  }
  process.exit(1);
});