import { DEFAULT_CARD_TEXT, CARD_TEXT_TEMPLATES } from '../../channels/feishu/card-text.mjs';
import { createHash } from 'node:crypto';
import { isScheduledBinding } from './thread-scope.mjs';
import { canDeliverOutboxAttachments } from './outbox-policy.mjs';

const clean = (value) => String(value || '').trim();
const chatKey = (value) => String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
const scopeHash = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);

export function outboxRelativeDirectory({ outboxRelativeRoot = 'data/feishu-outbox', chatId, bindingOpenId }) {
  return isScheduledBinding(bindingOpenId)
    ? `${outboxRelativeRoot}/system-${scopeHash(bindingOpenId)}/${chatKey(chatId)}`
    : `${outboxRelativeRoot}/${chatKey(chatId)}`;
}
export function buildInitialPrompt({ binding, prompt, groupChatContext, cardTextFile, outboxRelativeRoot, allowedGroupChatIds = new Set() }) {
  if (!binding) return prompt;
  if (cardTextFile) prompt = `【本机器人执行卡片文案】\n文案文件（相对项目目录）：${cardTextFile}\n用户要求修改自己的飞书卡片文案时，可读取并修改此 JSON 文件，运行时会在下一次卡片更新自动读取，无需重启。只修改用户指定的字段，使用临时文件加原子重命名保存。该文件对本机器人所有会话生效。\n可选字段：${Object.keys(DEFAULT_CARD_TEXT).join("、")}。值必须是非空单行纯文本；模板和较长提示最长 200 字符，其余最长 80 字符；删除字段恢复默认值。模板允许的占位符：${JSON.stringify(CARD_TEXT_TEMPLATES)}，不可增加其他占位符。例如 toolGroup 可设为「{count} 项操作 · {activity}」。只改标签，保留真实工具名称、计数、耗时、退出码和实际回答。保留状态和按钮动作的真实含义。不要修改其他机器人的配置或修改程序代码。\n\n${prompt}`;
  const outbox = outboxRelativeDirectory({ outboxRelativeRoot, chatId: binding.chatId, bindingOpenId: binding.feishuOpenId });
  if (isScheduledBinding(binding.feishuOpenId)) {
    return `【独立系统任务】\n任务：${binding.feishuOpenId}\n结果投递群：${binding.chatId}\n本线程仅承接此系统任务，不承接目标群的人工对话。结果由运行时发送到目标群。\n回发文件目录：${outbox}\n\n${prompt}`;
  }
  if (binding.chatType && binding.chatType !== 'p2p') {
    const context = normalizeGroupChatContext(groupChatContext);
    const lines = [];
    if (binding.created) {
      lines.push('【飞书群聊上下文】');
      if (context?.name) lines.push(`群名称：${context.name}`);
      if (context?.description) lines.push(`群介绍：${context.description}`);
      if (context?.chatId) lines.push(`chat_id：${context.chatId}`);
      lines.push('说明：这是本 Codex 会话绑定的飞书群，后续群成员 @ 机器人都会延续这个会话。');
    }
    if (canDeliverOutboxAttachments({ chatType: binding.chatType, chatId: binding.chatId, allowedGroupChatIds })) {
      if (!lines.length) lines.push('【飞书群聊文件回传】');
      lines.push(`回发文件目录：${outbox}`);
      lines.push('说明：需要给当前群回发文件时，将文件写入该目录；运行时会通过飞书 SDK 发送。');
    }
    return lines.length ? `${lines.join('\n')}\n\n${prompt}` : prompt;
  }
  const lines = [binding.created ? '【飞书私聊会话】' : '【飞书私聊文件回传】'];
  if (binding.created && clean(binding.chatId)) lines.push(`chat_id：${clean(binding.chatId)}`);
  if (binding.created && clean(binding.feishuOpenId)) lines.push(`对方 open_id：${clean(binding.feishuOpenId)}`);
  lines.push(`回发文件目录：${outbox}`);
  lines.push('说明：需要回发本机图片或文件时，必须复制或写入该目录；只在 Markdown 中引用本机路径不会上传。');
  return `${lines.join('\n')}\n\n${prompt}`;
}

export function normalizeGroupChatContext(value) {
  if (!value || typeof value !== 'object') return null;
  const chatId = clean(value.chatId || value.chat_id || value.id);
  const name = clean(value.name || value.chatName || value.chat_name || value.title);
  const description = clean(value.description || value.introduction || value.intro || value.summary);
  return chatId || name || description ? { chatId, name, description } : null;
}
