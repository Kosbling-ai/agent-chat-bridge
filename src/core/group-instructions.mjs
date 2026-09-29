import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

// Combined cap for one group's configured text plus instruction files.
export const GROUP_INSTRUCTIONS_MAX_BYTES = 200 * 1024;

class InstructionFileError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export function resolveInstructionPath(path, configDir) {
  return isAbsolute(path) ? path : resolve(configDir, path);
}

function fileFailure(error) {
  if (error instanceof InstructionFileError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return new InstructionFileError('missing');
  if (error instanceof TypeError) return new InstructionFileError('invalid_utf8');
  return new InstructionFileError('unreadable');
}

// Reads at most maxBytes + 1 bytes so a file that grows after stat is still rejected.
async function readInstructionFile(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new InstructionFileError('not_file');
    if (info.size > maxBytes) throw new InstructionFileError('too_large');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new InstructionFileError('too_large');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (!text.trim()) throw new InstructionFileError('empty');
    return { text: text.trim(), bytes: length };
  } catch (error) {
    throw fileFailure(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

const configuredGroups = groups => groups.filter(group => group.instructionText || group.instructionFiles?.length);

// check-config preflight: every configured file must exist, be a readable
// UTF-8 regular file, and fit the combined per-group cap.
export async function checkGroupInstructions(groups = [], { configDir, maxBytes = GROUP_INSTRUCTIONS_MAX_BYTES } = {}) {
  const problems = [];
  for (const group of configuredGroups(groups)) {
    let total = group.instructionText ? Buffer.byteLength(group.instructionText) : 0;
    if (total > maxBytes) problems.push({ chatId: group.conversationId, stage: 'text', reason: 'total_too_large' });
    for (const [index, path] of (group.instructionFiles || []).entries()) {
      try {
        total += (await readInstructionFile(resolveInstructionPath(path, configDir), maxBytes)).bytes;
        if (total > maxBytes) problems.push({ chatId: group.conversationId, stage: `file_${index}`, reason: 'total_too_large' });
      } catch (error) {
        problems.push({ chatId: group.conversationId, stage: `file_${index}`, reason: fileFailure(error).reason });
      }
    }
  }
  return problems;
}

const MODE_NOTES = Object.freeze({
  append: '说明：以下内容由 bridge 按本群配置注入，内容由配置方维护，是对 bridge 默认群聊上下文的补充，适用于本群线程的后续回合；若本线程此前已收到群指令，以本次内容为准。',
  replace: '说明：以下内容由 bridge 按本群配置注入，内容由配置方维护，取代 bridge 默认的群名称、群介绍和会话说明，适用于本群线程的后续回合；chat_id、回发文件目录、附件和消息标识等运行时说明仍然有效。若本线程此前已收到群指令，以本次内容为准。',
});

function header(chatId, mode) {
  return ['【飞书群指令】', `chat_id：${chatId}`, MODE_NOTES[mode]].join('\n');
}

// Runtime provider. Files are re-read only when their stat signature changes;
// an unusable file is skipped with one warning per failure state and never blocks a turn.
export function createGroupInstructions({ groups = [], configDir, maxBytes = GROUP_INSTRUCTIONS_MAX_BYTES, log = () => {} } = {}) {
  const configured = new Map(configuredGroups(groups).map(group => [group.conversationId, {
    mode: group.instructionMode === 'replace' ? 'replace' : 'append',
    text: group.instructionText || '',
    files: (group.instructionFiles || []).map(path => resolveInstructionPath(path, configDir)),
  }]));
  const cache = new Map();
  const warnings = new Map();
  const observe = (...args) => { try { Promise.resolve(log(...args)).catch(() => {}); } catch { /* logging never blocks a turn */ } };
  function skipped(chatId, index, reason) {
    const key = `${chatId}\0${index}`;
    if (warnings.get(key) === reason) return;
    warnings.set(key, reason);
    observe('warning', 'group_instructions', 'skipped', { code: 'group_instruction_file_skipped', reason, chatId, stage: `file_${index}` });
  }
  function usable(chatId, index) {
    if (warnings.delete(`${chatId}\0${index}`)) observe('info', 'group_instructions', 'recovered', { code: 'group_instruction_file_recovered', chatId, stage: `file_${index}` });
  }
  async function load(path) {
    let info;
    try { info = await stat(path); }
    catch (error) { cache.delete(path); throw fileFailure(error); }
    const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = cache.get(path);
    if (cached?.signature === signature) return cached;
    try {
      const entry = { signature, ...(await readInstructionFile(path, maxBytes)) };
      cache.set(path, entry);
      return entry;
    } catch (error) { cache.delete(path); throw error; }
  }
  return Object.freeze({
    configured: chatId => configured.has(chatId),
    async forChat(chatId) {
      const group = configured.get(chatId);
      if (!group) return null;
      const sections = [];
      let bytes = 0;
      if (group.text) { sections.push(group.text); bytes += Buffer.byteLength(group.text); }
      for (const [index, path] of group.files.entries()) {
        let file;
        try { file = await load(path); }
        catch (error) { skipped(chatId, index, fileFailure(error).reason); continue; }
        if (bytes + file.bytes > maxBytes) { skipped(chatId, index, 'total_too_large'); continue; }
        usable(chatId, index);
        bytes += file.bytes;
        sections.push(`【指令文件 ${index + 1}】\n${file.text}`);
      }
      if (!sections.length) return null;
      const text = [header(chatId, group.mode), ...sections].join('\n\n');
      return Object.freeze({ text, hash: createHash('sha256').update(text).digest('hex'), mode: group.mode, bytes, sources: sections.length });
    },
  });
}
