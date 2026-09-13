// 业务编排层：转写 / 结果 / 导出的完整流程。
// server.js（HTTP 网关）与 cli.js（命令行）共享本模块——听悟协议的编排细节
// (本地上传或听悟服务器下载 -> 转写 -> 轮询) 只在此维护一份,
// 两个入口各自只关心参数解析与输出格式.
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  generatePutLink,
  syncPutLink,
  parseNetSourceUrl,
  queryNetSourceParse,
  putNetSourceUrl,
  queryNetSourceUpload,
  getTransList,
  getTransStatus,
  getTransResult,
  getExportStatus,
  exportTrans,
} from './tingwu-client.js';
import { uploadFileToOss } from './oss-uploader.js';
import { parseTransResult } from './result-parser.js';
import { getCurrentCookie, isCookieInvalid } from './cookie-store.js';

const TRANSCRIBE_POLL_INTERVAL_MS = 2000;
const TRANSCRIBE_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 长音频转写可能持续较久
const NET_SOURCE_POLL_INTERVAL_MS = 1000;
const NET_SOURCE_TIMEOUT_MS = 120 * 1000;
const EXPORT_POLL_INTERVAL_MS = 1000;
const EXPORT_TIMEOUT_MS = 120 * 1000;

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  amr: 'audio/amr', wma: 'audio/x-ms-wma', flac: 'audio/flac', ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', flv: 'video/x-flv', webm: 'video/webm',
  '3gp': 'video/3gpp', ts: 'video/mp2t',
};
// 视频格式需要在 tag.originalTag 里标记 isVideo=1（抓包验证过音频样本）
const VIDEO_FORMATS = new Set(['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', '3gp', 'ts']);
// 导出文件类型映射。目前只有 srt=fileType 2 经抓包验证，其余格式请显式传 fileType（见 references/api.md）
const EXPORT_FILE_TYPE_BY_FORMAT = { srt: 2 };

// 两个入口共用的业务错误类型：自带 HTTP 状态映射与错误码，
// server 用于响应体，cli 用于 stderr JSON，调用方无需二次翻译。
export class GatewayError extends Error {
  constructor(httpStatus, code, message, detail) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.detail = detail;
  }
}

export function requireCookie({ allowInvalid = false } = {}) {
  const cookie = getCurrentCookie();
  if (!cookie) {
    throw new GatewayError(401, 'COOKIE_MISSING',
      '尚未配置 Cookie，请先通过 cli.js cookie set 或 POST /cookie 提供纯 Cookie 值');
  }
  if (!allowInvalid && isCookieInvalid()) {
    throw new GatewayError(401, 'COOKIE_INVALID',
      '登录已过期，已暂停业务请求，请更新 Cookie 后重试');
  }
  return cookie;
}

export function getFileFormat(filenameOrPath) {
  const extension = path.extname(filenameOrPath ?? '').replace('.', '').toLowerCase();
  if (extension && !MIME_BY_FORMAT[extension]) {
    throw new GatewayError(400, 'UNSUPPORTED_FORMAT',
      `无法识别的文件扩展名 "${extension}"，支持的格式：${Object.keys(MIME_BY_FORMAT).join('/')}`);
  }
  if (!extension) {
    throw new GatewayError(400, 'MISSING_EXTENSION', '文件名缺少扩展名，无法判断媒体格式');
  }
  return extension;
}

// 生成与前端同构的 taskId（抓包中格式为 rc-upload-<毫秒时间戳>-<序号>）
let taskIdSequence = 0;
function newFrontendTaskId() {
  taskIdSequence += 1;
  return `rc-upload-${Date.now()}-${taskIdSequence}`;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new GatewayError(400, 'INVALID_TIMEOUT', '超时必须是正数, 换算为毫秒后须为整数且不超过 2147483647');
  }
}

// 截止时间同时约束 HTTP 请求和轮询间隔, 避免上游请求挂起后超时失效.
async function withPollingTimeout(timeoutMs, message, detail, operation) {
  validateTimeout(timeoutMs);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await operation(signal);
  } catch (cause) {
    if (signal.aborted) throw new GatewayError(504, 'POLL_TIMEOUT', message, detail);
    throw cause;
  }
}

function checkTranscriptionStatus(item, transId, netSource) {
  // 官方前端确认 3=已上传待转写, 网络来源还会经历 4=等待下载和 5=下载中.
  if (![0, 1, 3, ...(netSource ? [4, 5] : [])].includes(item.status)) {
    throw new GatewayError(502, 'TRANSCRIPTION_FAILED',
      `听悟返回异常任务状态 ${item.status} (transId=${transId})`,
      { transId, status: item.status, statusMsg: item.statusMsg });
  }
}

async function waitUntilTranscribed(transId, cookie, timeoutMs, { netSource = false } = {}) {
  return withPollingTimeout(timeoutMs,
    `轮询转写超过 ${Math.round(timeoutMs / 1000)} 秒, 可稍后用 status 命令或 GET /transcripts/${transId} 再查`,
    { transId, phase: 'transcribe' }, async (signal) => {
      while (true) {
        const statusResponse = await getTransStatus({ transIds: [transId], preview: 1, signal }, cookie);
        const item = statusResponse.data?.find((entry) => entry.transId === transId);
        if (!item) {
          throw new GatewayError(502, 'TRANSCRIPTION_NOT_FOUND', `听悟查不到任务 ${transId}`, { transId });
        }
        checkTranscriptionStatus(item, transId, netSource);
        if (item.status === 0) return item;
        if (netSource && [4, 5].includes(item.status)) {
          const downloadResponse = await queryNetSourceUpload({ transIds: [transId], signal }, cookie);
          const download = downloadResponse.data?.find((entry) => entry.transId === transId);
          if (download && ![-1, 0].includes(download.status)) {
            throw new GatewayError(502, 'NET_SOURCE_DOWNLOAD_FAILED',
              `听悟服务器下载失败 (transId=${transId}, status=${download.status})`,
              { transId, status: download.status, message: download.message });
          }
        }
        await delay(TRANSCRIBE_POLL_INTERVAL_MS, undefined, { signal });
      }
    });
}

async function waitUntilExportReady(exportTaskId, cookie) {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusResponse = await getExportStatus({ exportTaskId }, cookie);
    const item = statusResponse.data ?? {};
    // 抓包验证：1=导出完成且 data.exportUrls 里带签名下载链接，0=处理中
    if (item.exportStatus === 1 && item.exportUrls?.length) return item.exportUrls[0];
    if (item.exportStatus !== 0) {
      throw new GatewayError(502, 'EXPORT_FAILED',
        `听悟返回异常导出状态 ${item.exportStatus}（exportTaskId=${exportTaskId}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS));
  }
  throw new GatewayError(504, 'POLL_TIMEOUT', `导出任务 ${exportTaskId} 超过 ${EXPORT_TIMEOUT_MS / 1000} 秒未完成`);
}

// 从导出下载链接的 response-content-disposition 参数里还原文件名
function extractExportFilename(exportUrl) {
  const disposition = new URL(exportUrl).searchParams.get('response-content-disposition') ?? '';
  const utf8Name = disposition.split("''")[1];
  return utf8Name ? decodeURIComponent(utf8Name) : 'export.bin';
}

// 转写编排：上传文件 -> 触发转写 ->（可选）等待完成。
// fileBuffer/filename 由调用方准备好：server 从 HTTP 请求解析，cli 从磁盘或 URL 读取。
// waitTimeoutMs 单位为毫秒；wait=false 时立即返回 transId 供调用方轮询。
export async function transcribeFile(
  {
    fileBuffer,
    filename,
    showName,
    lang = 'cn',
    roleSplitNum = 0,
    dirId = 0,
    wait = false,
    waitTimeoutMs = TRANSCRIBE_DEFAULT_TIMEOUT_MS,
  },
  cookie,
) {
  const fileFormat = getFileFormat(filename);
  const fileContentType = MIME_BY_FORMAT[fileFormat];
  const resolvedShowName = showName ?? path.basename(filename, path.extname(filename));

  // 步骤①：申请直传链接与服务端任务（得到 transId）
  const taskId = newFrontendTaskId();
  const putLinkResponse = await generatePutLink({
    taskId,
    fileSize: fileBuffer.length,
    fileContentType,
    dirId,
    tag: {
      showName: resolvedShowName,
      fileFormat,
      fileType: 'local',
      lang,
      roleSplitNum,
      translateSwitch: 0,
      transTargetValue: 0,
      originalTag: JSON.stringify({ isVideo: VIDEO_FORMATS.has(fileFormat) ? 1 : 0 }),
      client: 'web',
    },
  }, cookie);
  const { transId, getLink, sts } = putLinkResponse.data;

  // 步骤②：上传文件；步骤③：通知听悟触发转写
  let uploadMethod;
  try {
    uploadMethod = (await uploadFileToOss({ getLink, sts }, fileContentType, fileBuffer)).method;
  } catch (cause) {
    throw new GatewayError(502, 'OSS_UPLOAD_FAILED', `上传文件到 OSS 失败：${cause.message}`, cause.detail);
  }
  await syncPutLink({ fileLink: getLink, fileSize: fileBuffer.length, transId }, cookie);

  const summary = {
    transId,
    taskId,
    showName: resolvedShowName,
    fileFormat,
    fileSize: fileBuffer.length,
    uploadMethod,
    status: 'transcribing',
  };
  if (!wait) return summary;
  const finishedItem = await waitUntilTranscribed(transId, cookie, waitTimeoutMs);
  return {
    ...summary,
    status: 'done',
    duration: finishedItem.duration,
    wordCount: finishedItem.wordCount,
  };
}

function requireNetSourceUrl(fileUrl) {
  let url;
  try {
    if (typeof fileUrl !== 'string') throw new Error('URL must be a string');
    url = new URL(fileUrl);
  } catch {
    throw new GatewayError(400, 'INVALID_FILE_URL', 'fileUrl 必须是有效的 http(s) 音视频直链');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new GatewayError(400, 'INVALID_FILE_URL', '只支持不含用户名和密码的 http(s) 音视频直链');
  }
  // 不重新编码 URL, 避免改变源站签名参数. 此处也不探测或下载媒体内容.
  return fileUrl.trim();
}

function checkNetSourceResource(data) {
  if (data?.needLinkOssResource) {
    throw new GatewayError(400, 'NET_SOURCE_OSS_REQUIRED', '听悟要求先绑定 OSS 资源, 请在听悟网页完成绑定后重试');
  }
}

function matchesNetSourceFile(item, fileId) {
  if (item.tag?.fileType !== 'net_source') return false;
  try {
    return JSON.parse(item.tag.originalTag).netSourceFileId === fileId;
  } catch {
    return false;
  }
}

async function findNetSourceTranscript(fileId, dirId, cookie, signal) {
  const matches = [];
  for (let pageNo = 1; ; pageNo += 1) {
    // showName 搜索使用异步索引, 实测刚创建的任务会漏掉. 按来源和文件夹分页再精确匹配.
    const response = await getTransList({
      pageNo, pageSize: 100, filter: { fileTypes: ['net_source'], dirId }, signal,
    }, cookie);
    const items = response.data ?? [];
    matches.push(...items.filter((item) => matchesNetSourceFile(item, fileId)));
    const pageSize = response.pageSize || 100;
    if (items.length < pageSize || pageNo * pageSize >= response.total) break;
  }
  if (matches.length > 1) {
    throw new GatewayError(502, 'NET_SOURCE_TASK_AMBIGUOUS', '同一来源文件关联了多个任务, 请通过 list 确认, 不要重复提交',
      { fileId, transIds: matches.map((item) => item.transId), submitted: true });
  }
  return matches[0];
}

// 独立的直链编排: 听悟解析 -> 提交网络来源 -> 找到 transId -> 可选等待下载和转写.
// 不调用 fetch(fileUrl) 或 OSS 上传, 失败时也不自动回退为本机下载.
export async function transcribeUrl(
  {
    fileUrl,
    showName,
    lang = 'cn',
    roleSplitNum = 0,
    dirId = 0,
    wait = false,
    sourceTimeoutMs = NET_SOURCE_TIMEOUT_MS,
    waitTimeoutMs = TRANSCRIBE_DEFAULT_TIMEOUT_MS,
  },
  cookie,
) {
  const url = requireNetSourceUrl(fileUrl);
  validateTimeout(sourceTimeoutMs);
  if (wait) validateTimeout(waitTimeoutMs);
  if (showName !== undefined && (typeof showName !== 'string' || !showName.trim())) {
    throw new GatewayError(400, 'INVALID_SHOW_NAME', 'showName 必须是非空字符串');
  }
  const parseContext = { phase: 'parse' };
  const parsed = await withPollingTimeout(sourceTimeoutMs, '听悟解析直链超时, 尚未提交转写任务', parseContext,
    async (signal) => {
      const response = await parseNetSourceUrl({ url, signal }, cookie);
      checkNetSourceResource(response.data);
      const parseTaskId = response.data?.taskId;
      if (!parseTaskId) throw new GatewayError(502, 'NET_SOURCE_PARSE_FAILED', '听悟未返回直链解析 taskId');
      parseContext.parseTaskId = parseTaskId;
      while (true) {
        const query = await queryNetSourceParse({ taskId: parseTaskId, signal }, cookie);
        checkNetSourceResource(query.data);
        if (query.data?.status === 0) return query.data;
        if (query.data?.status !== -1) {
          throw new GatewayError(502, 'NET_SOURCE_PARSE_FAILED', '听悟无法解析此直链, 请确认链接可公开下载且指向音视频文件',
            { parseTaskId, status: query.data?.status, message: query.data?.message });
        }
        await delay(NET_SOURCE_POLL_INTERVAL_MS, undefined, { signal });
      }
    });
  // 此入口只转写单文件直链, 不自动将 RSS 或播放列表扩展成批量计费任务.
  if (!Array.isArray(parsed.urls) || parsed.urls.length !== 1) {
    throw new GatewayError(400, 'NET_SOURCE_FILE_COUNT', '直链必须解析出恰好一个音视频文件, 不支持批量来源',
      { parseTaskId: parseContext.parseTaskId, fileCount: parsed.urls?.length ?? 0 });
  }
  const file = parsed.urls[0];
  if (!file?.fileId || !Number.isFinite(file.size) || file.size <= 0 || typeof file.isVideo !== 'boolean') {
    throw new GatewayError(502, 'NET_SOURCE_PARSE_FAILED', '听悟返回的来源文件元数据不完整', parseContext);
  }
  const resolvedShowName = showName ?? (file.showName || (file.isVideo ? '网络视频' : '网络音频'));
  const submissionContext = {
    phase: 'submit', parseTaskId: parseContext.parseTaskId, fileId: file.fileId, showName: resolvedShowName,
  };
  await withPollingTimeout(sourceTimeoutMs,
    '提交直链请求超时, 任务可能已创建, 请通过 list 确认, 不要直接重复提交', submissionContext,
    (signal) => putNetSourceUrl({
      signal,
      files: [{
        fileId: file.fileId,
        dirId,
        fileSize: file.size,
        tag: {
          fileType: 'net_source', showName: resolvedShowName, lang, roleSplitNum,
          translateSwitch: 0, transTargetValue: 0, client: 'web',
          // putNetSourceUrl 不返回 transId. 实测 originalTag 会原样保留, 用唯一 fileId 关联,
          // 而不是依赖同名任务、创建时间或列表首项, 从而隔离并发提交和历史任务.
          originalTag: JSON.stringify({ isVideo: file.isVideo ? 1 : 0, netSourceFileId: file.fileId }),
        },
      }],
    }, cookie));
  const task = await withPollingTimeout(sourceTimeoutMs,
    '直链已提交但尚未找到对应任务, 请稍后通过 list 确认, 不要重复提交',
    { ...submissionContext, phase: 'resolve', submitted: true }, async (signal) => {
      while (true) {
        const item = await findNetSourceTranscript(file.fileId, dirId, cookie, signal);
        if (item?.transId) return item;
        await delay(NET_SOURCE_POLL_INTERVAL_MS, undefined, { signal });
      }
    });
  checkTranscriptionStatus(task, task.transId, true);
  const summary = {
    transId: task.transId,
    taskId: task.taskId,
    parseTaskId: parseContext.parseTaskId,
    fileId: file.fileId,
    showName: resolvedShowName,
    fileSize: file.size,
    isVideo: file.isVideo,
    source: 'net_source',
    status: [4, 5].includes(task.status) ? 'downloading' : 'transcribing',
  };
  if (!wait && task.status !== 0) return summary;
  const finished = task.status === 0 ? task
    : await waitUntilTranscribed(task.transId, cookie, waitTimeoutMs, { netSource: true });
  return { ...summary, status: 'done', duration: finished.duration, wordCount: finished.wordCount };
}

// 取解析后的转写结果：友好结构（text/paragraphs）+ 去掉内嵌 result 的原始数据
export async function getTranscriptResultParsed(transId, cookie) {
  const resultResponse = await getTransResult({ transId }, cookie);
  const parsed = parseTransResult(resultResponse.data?.result);
  const { result: rawResult, ...dataWithoutRawResult } = resultResponse.data ?? {};
  return { ...dataWithoutRawResult, transId, ...parsed, rawResult };
}

// 导出编排：解析 fileType -> 取归属 userId -> 发起导出 -> 轮询就绪 -> 下载文件内容。
// rawUrl=true 时只返回签名下载链接（有时效），否则代理下载为 buffer。
export async function exportTranscript(
  {
    transId,
    fileType,
    format,
    docType = 1,
    withSpeaker = true,
    withTimeStamp = true,
    rawUrl = false,
  },
  cookie,
) {
  // fileType 缺省时按 format 别名映射；两者都没给则默认导出 SRT（抓包验证过的组合）
  const resolvedFileType = fileType ?? EXPORT_FILE_TYPE_BY_FORMAT[format ?? 'srt'];
  if (!resolvedFileType) {
    throw new GatewayError(400, 'UNKNOWN_EXPORT_FORMAT',
      `未知导出格式 "${format}"；srt 之外请直接指定 fileType 数值（枚举需自行验证）`);
  }
  // 听悟的 exportTrans 需要归属 userId，先取结果接口顺带拿到（并顺带确认任务存在）
  const resultResponse = await getTransResult({ transId }, cookie);
  const userId = resultResponse.data.userId;

  const exportResponse = await exportTrans({
    transIds: [transId],
    userId,
    exportDetails: [{ docType, fileType: resolvedFileType, withSpeaker, withTimeStamp }],
  }, cookie);
  const exportUrlItem = await waitUntilExportReady(exportResponse.data.exportTaskId, cookie);

  if (rawUrl) {
    return { downloadUrl: exportUrlItem.url, filenameHint: extractExportFilename(exportUrlItem.url) };
  }
  // 默认代理下载：把导出文件内容直接返回，省去调用方处理 OSS 签名 URL 的有效期问题
  const fileResponse = await fetch(exportUrlItem.url);
  if (!fileResponse.ok) {
    throw new GatewayError(502, 'EXPORT_DOWNLOAD_FAILED', `下载导出文件失败：HTTP ${fileResponse.status}`);
  }
  return {
    buffer: Buffer.from(await fileResponse.arrayBuffer()),
    filename: extractExportFilename(exportUrlItem.url),
  };
}

// 拼装带说话人与相对时间的纯文本（[mm:ss][说话人N] 前缀）。
// 不走听悟导出接口，避免依赖未验证的导出格式枚举。
export function buildTxtContent(parsed) {
  const formatClock = (ms) => {
    if (ms == null) return '00:00';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  };
  return parsed.paragraphs
    .map((paragraph) => `[${formatClock(paragraph.startTimeMs)}][说话人${paragraph.speaker ?? '?'}] ${paragraph.text}`)
    .join('\n');
}
