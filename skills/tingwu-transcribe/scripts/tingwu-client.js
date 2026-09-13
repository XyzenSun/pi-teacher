// 通义听悟网页版（tingwu.aliyun.com）私有 Web API 客户端。
//
// 协议特征 (来自 2026-09-02 和 2026-09-13 的真实抓包分析):
//   - 请求都是 POST + application/json, 常规接口在 query 和 body 中携带 action
//   - 网络来源接口仅在 body 中携带 action, URL 只附加 c=web
//   - 鉴权完全依赖浏览器同源 Cookie，没有 CSRF token、没有请求签名
//   - 响应统一为 { code: "0", message, requestId, data, success }，code 非 "0" 即业务失败
//
// 注意：getTransResult 的路径与其它 trans 系列不同（/api/trans/getTransResult，
// action 只在 body 里），这是抓包验证过的事实，不要"统一"成 /request 格式。
import { isCurrentCookie, markCookieInvalid, markCookieValid } from './cookie-store.js';

const TINGWU_ORIGIN = 'https://tingwu.aliyun.com';

// 与浏览器请求保持一致，降低被服务端或风控（bx 系列头来自阿里 baxia SDK）识别为异常流量的概率
const BASE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'origin': TINGWU_ORIGIN,
  // 抓包显示 getTransResult / export 发生于文件详情页（/folders/0），其余发生于首页
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'bx-v': '2.5.37',
};

export class TingwuApiError extends Error {
  constructor(message, { httpStatus = 502, code = 'TINGWU_API_ERROR', detail } = {}) {
    super(message);
    this.name = 'TingwuApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.detail = detail;
  }
}

async function callTingwuApi({ apiPath, action, body, cookie, requireVersion = true, actionInQuery = true, signal }) {
  if (!cookie) {
    throw new TingwuApiError('网关尚未配置 cookie，请先通过 POST /cookie 提供纯 Cookie 值', {
      httpStatus: 401,
      code: 'COOKIE_MISSING',
    });
  }
  const url = `${TINGWU_ORIGIN}${apiPath}?${actionInQuery ? `${action}&` : ''}c=web`;
  const refererPath = action === 'getTransResult' || action === 'exportTrans' || action === 'getExportStatus'
    ? '/folders/0'
    : '/home';
  const payload = { action, ...(requireVersion ? { version: '1.0' } : {}), ...body };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...BASE_HEADERS, referer: `${TINGWU_ORIGIN}${refererPath}`, cookie },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (cause) {
    throw new TingwuApiError(`请求听悟服务失败：${cause.message}`, { code: 'TINGWU_UNREACHABLE', detail: String(cause) });
  }

  // cookie 失效时听悟可能返回重定向到登录页的 HTML，而不是 JSON。
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    const message = `听悟返回了非 JSON 响应（HTTP ${response.status}），登录凭证很可能已失效，请更新 cookie`;
    if (isCurrentCookie(cookie)) markCookieInvalid(message);
    throw new TingwuApiError(message, {
      httpStatus: 401,
      code: 'COOKIE_INVALID',
      detail: `content-type: ${contentType}`,
    });
  }

  const result = await response.json();
  if (response.status !== 200 || result.code !== '0') {
    // 实测（伪造 cookie 请求）：登录失效时听悟返回 code="CMN.NotLogin"、message="Not login."
    const notLoggedIn = result.code === 'CMN.NotLogin' || /not\s*login/i.test(result.message ?? '');
    if (notLoggedIn && isCurrentCookie(cookie)) {
      markCookieInvalid(`登录凭证已失效（听悟返回 ${result.code}），请更新 Cookie`);
    }
    throw new TingwuApiError(
      notLoggedIn
        ? `登录凭证已失效（听悟返回 ${result.code}），请更新 Cookie`
        : `听悟接口 ${action} 调用失败：${result.message ?? `HTTP ${response.status}`}`,
      {
        httpStatus: notLoggedIn ? 401 : 502,
        code: notLoggedIn ? 'COOKIE_INVALID' : 'TINGWU_API_ERROR',
        detail: { httpStatus: response.status, tingwuCode: result.code, requestId: result.requestId },
      },
    );
  }
  // 只有当前正在使用的 Cookie 成功访问业务接口时，才更新全局有效状态；
  // 更新接口验证候选 Cookie 时不会污染正在运行的旧会话状态。
  if (isCurrentCookie(cookie)) markCookieValid();
  return result;
}

// 步骤①：申请上传，返回 { transId, getLink（整文件直传签名 URL）, sts（分片上传兜底凭证）, ... }
export function generatePutLink({ taskId, fileSize, fileContentType, dirId = 0, tag }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'generatePutLink',
    cookie,
    body: { taskId, useSts: 1, fileSize, dirId, fileContentType, tag },
  });
}

// 步骤③：告知听悟文件已上传完成，触发转写。fileLink 固定传 generatePutLink 返回的 getLink
export function syncPutLink({ fileLink, fileSize, transId }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'syncPutLink',
    cookie,
    body: { fileLink, fileSize, transId },
  });
}

// 直链解析由听悟服务器执行, 客户端不请求媒体源站.
export function parseNetSourceUrl({ url, signal }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/parseNetSourceUrl',
    action: 'parseNetSourceUrl',
    actionInQuery: false,
    cookie,
    signal,
    body: { url },
  });
}

// status: -1=解析中, 0=成功. data.urls 提供 fileId/size/isVideo/showName.
export function queryNetSourceParse({ taskId, signal }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/queryNetSourceParse',
    action: 'queryNetSourceParse',
    actionInQuery: false,
    cookie,
    signal,
    body: { taskId },
  });
}

// 成功响应可能是 data: [], 不能依赖此响应取得 transId.
export function putNetSourceUrl({ files, signal }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'putNetSourceUrl',
    actionInQuery: false,
    cookie,
    signal,
    body: { files },
  });
}

// 此处 status 与转写状态不是同一枚举: -1=下载中, 0=下载完成, 1/3/4=失败.
export function queryNetSourceUpload({ transIds, signal }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'queryNetSourceUpload',
    actionInQuery: false,
    cookie,
    signal,
    body: { transIds },
  });
}

// 转写状态: 0=完成, 1=转写中, 3=已上传待转写, 4=等待上传/下载, 5=上传/下载中.
export function getTransStatus({ transIds, preview = 1, signal }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'getTransStatus',
    cookie,
    signal,
    body: { userId: '', transIds, preview },
  });
}

// 分页列出转写任务
export function getTransList(
  { pageNo = 1, pageSize = 20, filter = {}, orderType = 0, orderDesc = true, preview = 1, signal },
  cookie,
) {
  const fullFilter = {
    status: filter.status ?? [],
    fileTypes: filter.fileTypes ?? [],
    beginTime: filter.beginTime ?? '',
    mediaType: '',
    endTime: '',
    showName: filter.showName ?? '',
    read: filter.read ?? '',
    dirId: filter.dirId ?? 0,
    lang: '',
    shareUserId: '',
    client: '',
  };
  return callTingwuApi({
    apiPath: '/api/trans/request',
    action: 'getTransList',
    cookie,
    signal,
    body: { userId: '', filter: fullFilter, preview, pageNo, pageSize, orderType, orderDesc },
  });
}

// 获取转写结果。响应 data.result 是内嵌 JSON 字符串（字级时间戳），由 result-parser.js 解析
export function getTransResult({ transId }, cookie) {
  return callTingwuApi({
    apiPath: '/api/trans/getTransResult',
    action: 'getTransResult',
    cookie,
    body: { transId },
  });
}

// 发起导出任务（exportDetails 元素结构见抓包：{docType, fileType, withSpeaker, withTimeStamp}）
export function exportTrans({ transIds, userId, exportDetails }, cookie) {
  return callTingwuApi({
    apiPath: '/api/export/request',
    action: 'exportTrans',
    cookie,
    // 抓包中 export 系列的请求体没有 version 字段
    requireVersion: false,
    body: { transIds, userId, exportDetails },
  });
}

// 查询导出任务状态。exportStatus：1=完成（data.exportUrls 里带签名下载链接），0=处理中
export function getExportStatus({ exportTaskId }, cookie) {
  return callTingwuApi({
    apiPath: '/api/export/request',
    action: 'getExportStatus',
    cookie,
    requireVersion: false,
    body: { exportTaskId },
  });
}

// 用真实任务列表接口验证 Cookie，并可同时返回更新后的列表，避免“更新成功”只有格式校验而没有登录校验。
export function checkCookieValid(cookie, { pageSize = 1 } = {}) {
  return getTransList({ pageNo: 1, pageSize }, cookie);
}
