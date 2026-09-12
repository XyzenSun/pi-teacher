// Cookie 管理：只接受浏览器复制出的纯 Cookie 值，例如：
//   cna=xxx; hssid=xxx; login_aliyunid_ticket=xxx
// 不接受 cURL 命令、"cookie: ..." 请求头或其它包装格式，避免把无关内容写入凭证文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// Cookie 文件默认放在网关目录下，可用环境变量 TW_COOKIE_FILE 覆盖。
const COOKIE_FILE = process.env.TW_COOKIE_FILE ?? path.join(MODULE_DIR, 'cookie.txt');
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

let currentCookie = '';
let cookieStatus = 'missing';
let cookieError = '';
let cookieCheckedAt = null;

// 严格校验 Cookie 头的键值对格式；Cookie 值本身可以包含 =、/、+、% 等字符。
export function normalizeCookieValue(rawValue) {
  const cookie = String(rawValue ?? '').trim();
  if (!cookie || /[\r\n]/.test(cookie)) return '';

  const pairs = cookie.split(';').map((part) => part.trim()).filter(Boolean);
  if (!pairs.length) return '';
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) return '';
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || /\s/.test(value)) return '';
  }
  return pairs.join('; ');
}

// 启动时从磁盘加载纯 Cookie；文件不存在或格式不正确则保持未配置。
export function loadCookieFromDisk() {
  if (!fs.existsSync(COOKIE_FILE)) {
    currentCookie = '';
    cookieStatus = 'missing';
    cookieError = '';
    cookieCheckedAt = null;
    return currentCookie;
  }
  currentCookie = normalizeCookieValue(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  cookieStatus = currentCookie ? 'unknown' : 'missing';
  cookieError = currentCookie ? '' : 'Cookie 文件格式无效';
  cookieCheckedAt = null;
  return currentCookie;
}

// 只保存已经完成格式校验的纯 Cookie。调用方应先用真实听悟接口验证，再调用本函数。
export function setCookieValue(rawValue) {
  const cookie = normalizeCookieValue(rawValue);
  if (!cookie) return '';
  currentCookie = cookie;
  cookieStatus = 'unknown';
  cookieError = '';
  cookieCheckedAt = null;
  fs.writeFileSync(COOKIE_FILE, `${cookie}\n`, 'utf-8');
  // Cookie 等同登录凭证，落盘后限制为仅当前用户可读。
  try {
    fs.chmodSync(COOKIE_FILE, 0o600);
  } catch {
    // 某些文件系统不支持 chmod；写入本身已完成，不能因此阻断请求。
  }
  return cookie;
}

export function markCookieValid() {
  cookieStatus = 'valid';
  cookieError = '';
  cookieCheckedAt = Date.now();
}

export function markCookieInvalid(message = '登录凭证已失效') {
  cookieStatus = 'invalid';
  cookieError = message;
  cookieCheckedAt = Date.now();
}

export function isCookieInvalid() {
  return cookieStatus === 'invalid';
}

export function getCookieState() {
  return {
    configured: Boolean(currentCookie),
    status: currentCookie ? cookieStatus : 'missing',
    checkedAt: cookieCheckedAt,
    error: cookieError || null,
  };
}

// 用于候选 Cookie 验证：候选值尚未落盘时，不应改变当前 Cookie 的状态。
export function isCurrentCookie(cookie) {
  return Boolean(cookie) && cookie === currentCookie;
}

export function getCurrentCookie() {
  return currentCookie;
}
