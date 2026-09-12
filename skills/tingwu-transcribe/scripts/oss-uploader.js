// 文件直传到听悟分配的阿里云 OSS。
//
// 主路径：generatePutLink 返回的 getLink 是带签名的整文件 PUT 直传链接
//         （OSS 单次 PUT 最大支持 5GB），不必复刻前端 JS SDK 的分片上传。
// 兜底：getLink 上传失败时（例如签名对 header 的绑定校验不过），改用响应里的
//         STS 临时凭证走分片上传 —— 本文件内置 OSS V1 签名实现，保持零依赖。
import crypto from 'node:crypto';

const STS_PART_SIZE_BYTES = 8 * 1024 * 1024; // 分片大小 8MB（前端 SDK 用 1MB 过于零碎）

export class OssUploadError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'OssUploadError';
    this.detail = detail;
  }
}

// 按预签名 URL 整文件直传。Content-Type 必须与 generatePutLink 时声明的
// fileContentType 一致 —— 签名 URL 可能绑定了该头，不一致会被 OSS 拒绝（403）。
async function putFileBySignedUrl(getLink, fileContentType, fileBuffer) {
  const response = await fetch(getLink, {
    method: 'PUT',
    headers: { 'content-type': fileContentType },
    body: fileBuffer,
  });
  if (!response.ok) {
    throw new OssUploadError(
      `预签名直传失败：HTTP ${response.status}`,
      (await response.text()).slice(0, 500),
    );
  }
}

// ---- STS 分片上传兜底实现 ----

// OSS V1 签名：Signature = base64(hmac-sha1(accessKeySecret, stringToSign))
// stringToSign = VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedOSSHeaders + CanonicalizedResource
// 签名 Date 段的取值经真实请求验证：使用 x-oss-date 头时该头会被计入日期段，
// 留空反而导致 SignatureDoesNotMatch；因此这里发标准 Date 头并让签名段取同值，最无歧义。
function buildOssAuthorization({ method, contentType, dateHeader, ossHeaders, canonicalResource, sts }) {
  const canonicalOssHeaderString = Object.keys(ossHeaders)
    .sort()
    .map((name) => `${name}:${ossHeaders[name].trim()}\n`)
    .join('');
  const stringToSign = [method, '', contentType ?? '', dateHeader, canonicalOssHeaderString + canonicalResource].join('\n');
  const signature = crypto.createHmac('sha1', sts.accessKeySecret).update(stringToSign, 'utf-8').digest('base64');
  return `OSS ${sts.accessKeyId}:${signature}`;
}

function buildOssRequestHeaders({ method, contentType, canonicalResource, sts, extraHeaders = {} }) {
  const dateHeader = new Date().toUTCString();
  // 仅 x-oss-* 前缀的头计入 CanonicalizedOSSHeaders，标准 Date 头不算
  const ossHeaders = { 'x-oss-security-token': sts.securityToken };
  return {
    ...ossHeaders,
    'date': dateHeader,
    // Content-Type 参与 V1 签名，必须随请求一起带上，否则 OSS 端按空值计算导致不匹配
    ...(contentType ? { 'content-type': contentType } : {}),
    ...extraHeaders,
    authorization: buildOssAuthorization({ method, contentType, dateHeader, ossHeaders, canonicalResource, sts }),
  };
}

// 子资源 query（uploads / partNumber / uploadId）属于 OSS 签名范围，必须按字典序拼进
// CanonicalizedResource；无值的子资源不带等号（实测 "?uploads=" 参与签名会 403）
function buildCanonicalResource(bucket, fileKey, query) {
  const sortedQueryKeys = Object.keys(query).sort();
  const queryPart = sortedQueryKeys.length
    ? '?' + sortedQueryKeys.map((key) => (query[key] ? `${key}=${query[key]}` : key)).join('&')
    : '';
  return `/${bucket}/${fileKey}${queryPart}`;
}

async function ossRequest({ method, url, contentType, query, sts, requestBody }) {
  const canonicalResource = buildCanonicalResource(sts.bucket, sts.fileKey, query);
  const headers = buildOssRequestHeaders({ method, contentType, canonicalResource, sts });
  const response = await fetch(url, { method, headers, body: requestBody });
  if (!response.ok) {
    throw new OssUploadError(`OSS ${method} 请求失败：HTTP ${response.status}`, (await response.text()).slice(0, 500));
  }
  return response;
}

function extractFromXml(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
  return match ? match[1] : '';
}

async function multipartUploadWithSts(sts, fileBuffer) {
  // 听悟的 bucket 开启了三级域名访问限制（实测返回 SecondLevelDomainForbidden），
  // 必须用 {bucket}.endpoint 虚拟主机风格寻址，不能用 /bucket/key 路径风格
  const host = new URL(sts.endpoint).host;
  const objectUrl = `https://${sts.bucket}.${host}/${sts.fileKey}`;

  // 1. 初始化分片上传，取得 uploadId
  const initResponse = await ossRequest({
    method: 'POST',
    url: `${objectUrl}?uploads`,
    query: { uploads: '' },
    contentType: undefined,
    sts,
  });
  const uploadId = extractFromXml(await initResponse.text(), 'UploadId');

  // 2. 顺序上传各分片，记录每片 ETag（OSS 要求 complete 时逐一回传）
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < fileBuffer.length; offset += STS_PART_SIZE_BYTES, partNumber += 1) {
    const partBuffer = fileBuffer.subarray(offset, Math.min(offset + STS_PART_SIZE_BYTES, fileBuffer.length));
    const putResponse = await ossRequest({
      method: 'PUT',
      url: `${objectUrl}?partNumber=${partNumber}&uploadId=${uploadId}`,
      query: { partNumber: String(partNumber), uploadId },
      contentType: 'application/octet-stream',
      sts,
      requestBody: partBuffer,
    });
    // 响应的 etag 头自带引号（"..."），去掉后统一在 complete 的 XML 里包一层，
    // 实测双层引号会让 OSS 报 InvalidPart
    const rawEtag = putResponse.headers.get('etag') ?? '';
    parts.push({ partNumber, etag: rawEtag.replaceAll('"', '') });
  }

  // 3. 通知 OSS 合并分片
  const completeXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n' +
    parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`)
      .join('\n') +
    '\n</CompleteMultipartUpload>';
  await ossRequest({
    method: 'POST',
    url: `${objectUrl}?uploadId=${uploadId}`,
    query: { uploadId },
    contentType: 'application/xml',
    sts,
    requestBody: completeXml,
  });
}

// 统一入口：优先走预签名整传，失败且有 STS 凭证时自动降级为分片上传
export async function uploadFileToOss({ getLink, sts }, fileContentType, fileBuffer) {
  try {
    await putFileBySignedUrl(getLink, fileContentType, fileBuffer);
    return { method: 'signed-url' };
  } catch (signedUrlError) {
    if (!sts) {
      throw signedUrlError;
    }
    // 主路径失败原因必须留下来：否则兜底路径再失败时无从排查
    console.warn(`[oss] 预签名直传失败，降级为 STS 分片上传。原因: ${signedUrlError.message}`,
      signedUrlError.detail ?? '');
    await multipartUploadWithSts(sts, fileBuffer);
    return { method: 'sts-multipart', reason: signedUrlError.message };
  }
}
