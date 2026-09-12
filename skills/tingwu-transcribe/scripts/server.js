// 通义听悟本地网关（HTTP 层）：WebUI + REST API，供用户浏览器使用。
// AI 命令行入口见 cli.js；两者共享 core.js 的业务编排，本文件只关心
// HTTP 关注点（请求解析、路由、响应序列化），不包含听悟协议细节。
//
// 设计要点：
//   - 默认监听 0.0.0.0 以便局域网访问；网关持有登录 Cookie，请仅在可信网络使用
//   - /transcribe 一次调用自动编排「generatePutLink -> OSS 上传 -> syncPutLink」，
//     调用方无需感知听悟协议细节
//   - 所有听悟业务错误统一转换为 { error, code, detail } 的 JSON 响应
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCookieFromDisk,
  setCookieValue,
  normalizeCookieValue,
  getCurrentCookie,
  getCookieState,
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

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(MODULE_DIR, 'ui.html');
const PORT = Number(process.env.TW_PORT ?? 8787);
// 默认监听 0.0.0.0 以便局域网其他设备（如本机之外的电脑/手机）访问；
// 网关无鉴权且持有登录 cookie，公开网络环境请自行加防火墙或反代鉴权
const HOST = process.env.TW_HOST ?? '0.0.0.0';
// wait 模式轮询超时（秒）。README 约定 waitTimeout 为秒数，这里统一乘 1000 转毫秒
const WAIT_TIMEOUT_DEFAULT_SECONDS = 900;

function sendJson(resp, httpStatus, payload) {
  const body = JSON.stringify(payload);
  resp.writeHead(httpStatus, { 'content-type': 'application/json; charset=utf-8' });
  resp.end(body);
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// 零依赖解析 multipart/form-data：
// 复用 Node 内置 undici 的 Request.formData()，避免手写 multipart 边界解析
async function parseMultipartFormData(req) {
  const contentType = req.headers['content-type'] ?? '';
  const bodyBuffer = await readBodyBuffer(req);
  const webRequest = new Request('http://tingwu-gateway.local/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bodyBuffer,
  });
  return webRequest.formData();
}

// ---- /transcribe：三种请求方式（multipart / JSON fileUrl / 裸 body）归一化后交给 core ----

async function handleTranscribe(req, resp, url) {
  const cookie = requireCookie();
  const wait = ['1', 'true'].includes(url.searchParams.get('wait') ?? '');
  const waitTimeoutMs = Number(url.searchParams.get('waitTimeout') ?? WAIT_TIMEOUT_DEFAULT_SECONDS) * 1000;

  const contentType = req.headers['content-type'] ?? '';
  let fileBuffer;
  let filename;
  let options = {};

  if (contentType.startsWith('multipart/form-data')) {
    const form = await parseMultipartFormData(req);
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new GatewayError(400, 'MISSING_FILE', 'multipart 请求必须包含 file 文件字段');
    }
    fileBuffer = Buffer.from(await file.arrayBuffer());
    filename = file.name;
    // 便捷参数（均可省略）：showName 任务显示名 / lang 语言 / roleSplitNum 说话人分离人数 / dirId 文件夹
    options = {
      showName: form.get('showName') || undefined,
      lang: form.get('lang') || 'cn',
      roleSplitNum: Number(form.get('roleSplitNum') ?? 0) || 0,
      dirId: Number(form.get('dirId') ?? 0) || 0,
    };
  } else if (contentType.startsWith('application/json')) {
    // JSON 模式：直接给一个可下载的文件 URL，网关代为下载后转写（适合转写网络音频）
    const body = JSON.parse((await readBodyBuffer(req)).toString('utf-8') || '{}');
    if (!body.fileUrl) {
      throw new GatewayError(400, 'MISSING_FILE_URL', 'JSON 请求体必须包含 fileUrl 字段');
    }
    const downloadResponse = await fetch(body.fileUrl);
    if (!downloadResponse.ok) {
      throw new GatewayError(400, 'FILE_DOWNLOAD_FAILED', `下载 fileUrl 失败：HTTP ${downloadResponse.status}`);
    }
    fileBuffer = Buffer.from(await downloadResponse.arrayBuffer());
    // URL 以 / 结尾时 pop() 得空串，用 || 兜底；body.filename 传空串同样无意义，统一用 || 链
    filename = body.filename || decodeURIComponent(new URL(body.fileUrl).pathname.split('/').pop() || '') || 'input.mp3';
    options = {
      showName: body.showName,
      lang: body.lang ?? 'cn',
      roleSplitNum: Number(body.roleSplitNum ?? 0) || 0,
      dirId: Number(body.dirId ?? 0) || 0,
    };
  } else {
    // 裸 body 模式：请求体即文件内容，媒体格式经 query filename 或请求头声明
    fileBuffer = await readBodyBuffer(req);
    filename = url.searchParams.get('filename') ?? req.headers['x-filename'];
    options = {
      showName: url.searchParams.get('showName') ?? req.headers['x-show-name'],
      lang: url.searchParams.get('lang') ?? 'cn',
      roleSplitNum: Number(url.searchParams.get('roleSplitNum') ?? 0) || 0,
      dirId: Number(url.searchParams.get('dirId') ?? 0) || 0,
    };
  }

  if (!filename) filename = 'input.mp3';
  const summary = await transcribeFile({
    fileBuffer,
    filename,
    showName: options.showName,
    lang: options.lang,
    roleSplitNum: options.roleSplitNum,
    dirId: options.dirId,
    wait,
    waitTimeoutMs,
  }, cookie);
  sendJson(resp, 201, summary);
}

// ---- 其余路由 ----

async function handleExport(req, resp, transId) {
  const cookie = requireCookie();
  const rawBody = (await readBodyBuffer(req)).toString('utf-8') || '{}';
  const body = JSON.parse(rawBody);

  const outcome = await exportTranscript({
    transId,
    fileType: body.fileType,
    format: body.format,
    docType: body.docType,
    withSpeaker: body.withSpeaker,
    withTimeStamp: body.withTimeStamp,
    rawUrl: Boolean(body.rawUrl),
  }, cookie);

  if (outcome.downloadUrl) {
    sendJson(resp, 200, { downloadUrl: outcome.downloadUrl, filenameHint: outcome.filenameHint });
    return;
  }
  resp.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(outcome.filename)}`,
  });
  resp.end(outcome.buffer);
}

async function route(req, resp, url) {
  const { pathname } = url;
  const method = req.method;

  // WebUI：单文件内联样式/脚本，随网关一起提供
  if (method === 'GET' && (pathname === '/' || pathname === '/ui.html')) {
    resp.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    resp.end(fs.readFileSync(UI_FILE));
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    const cookie = getCurrentCookie();
    return sendJson(resp, 200, {
      status: 'ok',
      cookieLoaded: Boolean(cookie),
      cookieState: getCookieState(),
    });
  }

  if (method === 'POST' && pathname === '/cookie') {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('text/plain')) {
      throw new GatewayError(415, 'COOKIE_CONTENT_TYPE_REQUIRED',
        'POST /cookie 只接受 text/plain 请求体，内容必须是纯 Cookie 值');
    }
    const candidate = (await readBodyBuffer(req)).toString('utf-8').trim();
    const cookie = normalizeCookieValue(candidate);
    if (!cookie) {
      throw new GatewayError(400, 'COOKIE_INVALID_FORMAT',
        'Cookie 格式无效，请直接粘贴完整的 name=value; name2=value2 内容');
    }

    // 先用候选 Cookie 做真实只读验证；验证成功后才替换当前 Cookie 并落盘，
    // 验证失败时保留旧会话，避免误粘贴导致网关失去原本可用的登录状态。
    try {
      const probe = await checkCookieValid(cookie, { pageSize: 20 });
      setCookieValue(cookie);
      markCookieValid();
      return sendJson(resp, 200, {
        cookieUpdated: true,
        cookieValid: true,
        totalTranscripts: probe.total ?? 0,
        transcripts: probe.data ?? [],
        cookieState: getCookieState(),
      });
    } catch (cause) {
      throw new GatewayError(cause.httpStatus === 401 ? 401 : 502, 'COOKIE_VALIDATION_FAILED',
        `新 Cookie 验证失败：${cause.message}`, cause.detail);
    }
  }

  if (method === 'GET' && pathname === '/cookie/check') {
    const cookie = requireCookie({ allowInvalid: true });
    const probe = await checkCookieValid(cookie, { pageSize: 20 });
    markCookieValid();
    return sendJson(resp, 200, {
      cookieValid: true,
      totalTranscripts: probe.total ?? 0,
      transcripts: probe.data ?? [],
      cookieState: getCookieState(),
    });
  }

  if (method === 'POST' && pathname === '/transcribe') {
    return handleTranscribe(req, resp, url);
  }

  if (method === 'GET' && pathname === '/transcripts') {
    const cookie = requireCookie();
    const query = url.searchParams;
    const listResponse = await getTransList({
      pageNo: Number(query.get('pageNo') ?? 1),
      pageSize: Number(query.get('pageSize') ?? 20),
      filter: {
        status: query.get('status') ? [Number(query.get('status'))] : [],
        showName: query.get('showName') ?? '',
        dirId: Number(query.get('dirId') ?? 0) || 0,
      },
      orderDesc: query.get('orderDesc') !== 'false',
    }, cookie);
    return sendJson(resp, 200, listResponse);
  }

  const transcriptMatch = pathname.match(/^\/transcripts\/([^/]+)(\/[a-z]+)?$/);
  if (transcriptMatch) {
    const transId = decodeURIComponent(transcriptMatch[1]);
    const subAction = transcriptMatch[2] ?? '';
    if (method === 'GET' && subAction === '') {
      const cookie = requireCookie();
      const statusResponse = await getTransStatus({ transIds: [transId], preview: 1 }, cookie);
      return sendJson(resp, 200, statusResponse);
    }
    if (method === 'GET' && subAction === '/result') {
      const cookie = requireCookie();
      return sendJson(resp, 200, await getTranscriptResultParsed(transId, cookie));
    }
    if (method === 'GET' && subAction === '/txt') {
      // 纯文本下载：直接用转写结果拼装，不依赖听悟未验证的导出格式枚举。
      // 文件名经 query name 由前端传入
      const cookie = requireCookie();
      const parsed = await getTranscriptResultParsed(transId, cookie);
      const filename = `${url.searchParams.get('name') || transId}.txt`;
      resp.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      resp.end(buildTxtContent(parsed));
      return;
    }
    if (method === 'POST' && subAction === '/export') {
      return handleExport(req, resp, transId);
    }
    throw new GatewayError(404, 'NOT_FOUND', `不支持的操作：${method} ${pathname}`);
  }

  throw new GatewayError(404, 'NOT_FOUND', `未知路由：${method} ${pathname}`);
}

async function main() {
  loadCookieFromDisk();
  const server = http.createServer(async (req, resp) => {
    try {
      await route(req, resp, new URL(req.url, `http://${req.headers.host ?? 'localhost'}`));
    } catch (cause) {
      // GatewayError 与 TingwuApiError 均自带 httpStatus/code（含 cookie 失效 -> 401 的映射）
      const isKnownError = cause instanceof GatewayError || cause instanceof TingwuApiError;
      const httpStatus = isKnownError ? cause.httpStatus : 500;
      const code = isKnownError ? cause.code : 'INTERNAL_ERROR';
      console.error(`[error] ${req.method} ${req.url} -> ${code}:`, cause.message);
      if (!resp.headersSent) {
        sendJson(resp, httpStatus, { error: cause.message, code, detail: cause.detail });
      } else {
        resp.end();
      }
    }
  });
  server.listen(PORT, HOST, () => {
    const cookieLoaded = Boolean(getCurrentCookie());
    console.log(`通义听悟网关已启动: http://${HOST}:${PORT}`);
    console.log(`cookie 状态: ${cookieLoaded ? '已加载' : '未配置 —— 请编辑 cookie.txt 或 POST /cookie'}`);
    console.log('可用端点: GET /health | POST /cookie | GET /cookie/check | POST /transcribe | GET /transcripts | GET /transcripts/:id/result | POST /transcripts/:id/export');
  });
}

main().catch((error) => {
  console.error('网关启动失败:', error);
  process.exit(1);
});
