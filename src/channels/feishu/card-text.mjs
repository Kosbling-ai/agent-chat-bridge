import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

export const DEFAULT_CARD_TEXT = Object.freeze({
  title: '', received: '已收到，正在处理你的请求。',
  running: '执行中', completed: '已完成', failed: '执行失败', interrupted: '已中断',
  retrying: '连接恢复中', deferred: '补充已转达',
  stopButton: '停止执行', forkButton: '保留历史并新建会话',
  omitted: '较早的执行过程已收起，仅展示最近进度。', fallback: '结果将通过普通消息送达',
});
const longFields = new Set(['received', 'omitted', 'fallback']);
const MAX_BYTES = 16 * 1024;
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_card_text');
  for (const [key, text] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_CARD_TEXT, key) || typeof text !== 'string' || !text.trim()
      || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) || !text.isWellFormed() || Array.from(text).length > (longFields.has(key) ? 200 : 80)) throw new Error('invalid_card_text');
  }
  return Object.freeze({ ...DEFAULT_CARD_TEXT, ...value });
}

// Each instance keeps its own last valid snapshot. Partial writes never break delivery.
export function createCardTextProvider({ file, root, log = () => {} } = {}) {
  let current = DEFAULT_CARD_TEXT, warned = false, chain = Promise.resolve();
  async function load() {
    if (!file) return current;
    let handle;
    try {
      if (root) {
        const path = relative(await realpath(root), await realpath(file));
        if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('invalid_card_text_path');
      }
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('invalid_card_text_size');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error('invalid_card_text_size');
      current = validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
      warned = false;
    } catch (error) {
      if (error.code === 'ENOENT') { current = DEFAULT_CARD_TEXT; warned = false; }
      else if (!warned) {
        warned = true;
        try { log('warning', 'card_text', 'invalid', { code: 'invalid_card_text_file' }); } catch { /* Logging cannot break replies. */ }
      }
    } finally { await handle?.close().catch(() => {}); }
    return current;
  }
  return () => { const result = chain.then(load); chain = result.catch(() => {}); return result; };
}
