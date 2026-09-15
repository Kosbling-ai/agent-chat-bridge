import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { canDeliverOutboxAttachments } from './outbox-policy.mjs';
import { outboxRelativeDirectory } from './prompt.mjs';

export const OUTBOX_MAX_FILES = 9;
export const OUTBOX_MAX_BYTES = 28 * 1024 * 1024;

export function collectOutboxAttachments(binding, sinceMs, {
  workspace, outboxRelativeRoot = 'data/feishu-outbox', allowedGroupChatIds = new Set(),
  maxFiles = OUTBOX_MAX_FILES, maxBytes = OUTBOX_MAX_BYTES, log = () => {},
} = {}) {
  if (!canDeliverOutboxAttachments({ chatType: binding?.chatType, chatId: binding?.chatId, allowedGroupChatIds })) return [];
  const relativeDirectory = outboxRelativeDirectory({ outboxRelativeRoot, chatId: binding.chatId, bindingOpenId: binding.feishuOpenId });
  const directory = resolve(workspace, relativeDirectory);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code !== 'ENOENT') log('warning', { module: 'agent-chat-bridge', component: 'codex-outbox', operation: 'scan', status: 'failed' });
    return [];
  }
  const threshold = Number(sinceMs || 0) - 1000;
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = resolve(directory, entry.name);
    try {
      const info = statSync(filePath);
      if (info.mtimeMs >= threshold && info.size <= maxBytes) found.push({ filePath, mtimeMs: info.mtimeMs, size: info.size });
    } catch { /* cleanup may race the scan */ }
  }
  found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = 0;
  const selected = [];
  for (const file of found.slice(-maxFiles)) {
    if (total + file.size > maxBytes) continue;
    total += file.size;
    selected.push(file.filePath);
  }
  return selected;
}
