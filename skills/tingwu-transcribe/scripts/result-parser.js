// 解析听悟 getTransResult 返回的内嵌 result JSON 字符串。
//
// result 的结构（抓包验证）：
//   { pg: [ { pi: 段落编号, sc: [ { bt: 字起始毫秒, et: 字结束毫秒, id, si: 说话人编号, tc: 文本 } ] } ] }
// pg = paragraph（段落），sc = 字符级切片。字级时间戳在原始数据里逐字给出，
// 这里按段落聚合，拼出带说话人与起止时间的可读结构。
export function parseTransResult(resultString) {
  if (!resultString) {
    return { text: '', paragraphs: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(resultString);
  } catch {
    // result 结构变化时避免整个接口不可用：保留原始字符串由调用方兜底
    return { text: '', paragraphs: [], parseFailed: true };
  }

  const paragraphs = (parsed.pg ?? []).map((paragraph) => {
    const slices = paragraph.sc ?? [];
    const text = slices.map((slice) => slice.tc ?? '').join('');
    return {
      speaker: slices[0]?.si ?? null,
      startTimeMs: slices[0]?.bt ?? null,
      endTimeMs: slices[slices.length - 1]?.et ?? null,
      text,
    };
  });

  return {
    text: paragraphs.map((paragraph) => paragraph.text).join(''),
    paragraphs,
  };
}
