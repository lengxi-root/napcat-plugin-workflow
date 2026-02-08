// CQ码解析工具（复用于 message-handler 和 scheduler）

/** 文件/Buffer 转字符串 */
export const toFile = (d: string | Buffer): string => typeof d === 'string' ? d : `base64://${d.toString('base64')}`;

/** CQ码转义还原 */
const unescapeCQ = (s: string): string =>
  s.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');

/** 解析CQ码为消息段数组 */
export function parseCQCode (text: string): unknown[] {
  const segments: unknown[] = [];
  const regex = /\[CQ:([a-z_]+)(?:,([^\]]+))?\]/gi;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) segments.push({ type: 'text', data: { text: plain } });
    }

    const type = match[1];
    const paramsStr = match[2] || '';
    const data: Record<string, string> = {};

    if (paramsStr) {
      for (const p of paramsStr.split(/,(?=[a-z_]+=)/i)) {
        const eq = p.indexOf('=');
        if (eq > 0) data[p.slice(0, eq).trim()] = unescapeCQ(p.slice(eq + 1).trim());
      }
    }

    segments.push({ type, data });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    if (plain) segments.push({ type: 'text', data: { text: plain } });
  }

  return segments.length ? segments : [{ type: 'text', data: { text } }];
}
