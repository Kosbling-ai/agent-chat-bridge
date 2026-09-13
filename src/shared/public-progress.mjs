// Only public assistant commentary and tool lifecycle enter the chat channel.
// Never project reasoning, raw shell, arbitrary arguments or output.
import { isAbsolute, relative } from 'node:path';
export function publicText(value, limit = 1200) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[已隐藏凭据]')
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|(?:token|password|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+)/gi, '[已隐藏凭据]')
    .replace(/\b(?:mysql|postgres(?:ql)?):\/\/\S+/gi, '[已隐藏连接信息]')
    .slice(0, limit);
}
const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'function_call', 'fileChange', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall']);
function toolLabel(item) {
  if (item.type === 'commandExecution') return '执行命令';
  if (item.type === 'fileChange') return '更新文件';
  if (item.type === 'webSearch') return '搜索资料';
  if (item.type === 'imageView') return '查看图片';
  if (item.type === 'imageGeneration') return '生成图片';
  if (item.type === 'collabAgentToolCall') return '协作任务';
  const name = String(item.tool || item.name || '').toLowerCase();
  if (/order/.test(name)) return '处理订单';
  if (/doc|wiki/.test(name)) return '处理文档';
  if (/search/.test(name)) return '搜索资料';
  if (/sheet|base/.test(name)) return '处理表格';
  if (/read|fetch|get/.test(name)) return '读取信息';
  return '调用工具';
}
// Deliberately parse only a program token, never execute or expand shell syntax.
function safeName(value) {
  const name = String(value || '');
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) && !/secret|token|password|sk-/i.test(name) ? name : '';
}
function programName(command) {
  let text = String(command || '').trim().slice(0, 4000);
  const wrapper = text.match(/^(?:\/[^\s]+\/)?(?:ba|z|fi)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/);
  if (wrapper) text = wrapper[2].trim();
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+)*/, '');
  const match = text.match(/^([A-Za-z0-9_./-]+)(?:\s|$)/);
  const name = safeName(match?.[1]?.split('/').pop());
  if (!name) return 'shell';
  const rest = text.slice(match[0].length).trim();
  const sub = rest.match(/^(status|diff|log|show|test|check|run|build)(?:\s|$)/)?.[1];
  return name === 'git' && sub ? `${name} ${sub}` : name;
}
function safeTarget(value, cwd) {
  let path = String(value || '');
  if (isAbsolute(path)) {
    if (!cwd || !isAbsolute(cwd)) return '';
    path = relative(cwd, path);
  }
  if (!path || path.length > 140 || path.split('/').includes('..') || /(?:^|\/)(?:\.env[^/]*|local\.env[^/]*|\.ssh|\.aws|credentials[^/]*)(?:\/|$)/i.test(path)) return '';
  return /^[A-Za-z0-9_./\-\u4e00-\u9fff]+$/.test(path) && !/secret|token|password|credential|sk-/i.test(path) ? path : '';
}
function toolPresentation(item) {
  if (item.type !== 'commandExecution') {
    const name = safeName(item.tool || item.name) || item.type;
    return { title: `${name} · ${toolLabel(item)}`, detail: `工具：${name}` };
  }
  const actions = Array.isArray(item.commandActions) ? item.commandActions.slice(0, 4) : [];
  const programs = [...new Set((actions.length ? actions : [item]).map((a) => programName(a.command || item.command)))];
  const targets = actions.map((a) => {
    const path = safeTarget(a.path, item.cwd);
    const verb = { read: '读取', listFiles: '列出文件', search: '搜索' }[a.type];
    if (a.type === 'read') {
      // SKILL.md is a conventional structured target. Publish only its skill
      // name, never the absolute personal skills directory.
      const skill = String(a.path || '').match(/(?:^|\/)skills\/([A-Za-z0-9_-]{1,64})\/SKILL\.md$/)?.[1];
      if (skill && safeName(skill)) return `读取 ${skill} 技能`;
      const name = safeTarget(String(a.name || '').split(/[\\/]/).pop());
      return `读取${name || path ? ` ${name || path}` : '文件'}`;
    }
    return verb ? `${verb}${path ? `：${path}` : ''}` : '';
  }).filter(Boolean);
  const name = programs.join(' / ');
  return { title: targets[0] || name, detail: [`命令：${name}`, ...targets].join('\n') };
}
export function createPublicProgressProjector() {
  const items = new Map();
  return (method, params = {}) => {
    const item = params.item;
    if ((method === 'item/started' || method === 'item/completed') && item?.id) {
      const previous = items.get(item.id) || {};
      if (items.size >= 100 && !items.has(item.id)) items.delete(items.keys().next().value);
      const presentation = previous.presentation || (toolTypes.has(item.type) ? toolPresentation(item) : null);
      const meta = { ...previous, presentation, type: item.type, phase: item.phase || previous.phase, text: publicText(item.text || previous.text) };
      items.set(item.id, meta);
      if (method === 'item/completed' && (item.type === 'agentMessage' || item.type === 'message') && meta.phase === 'commentary' && item.role !== 'user') {
        const text = item.text || (item.content || []).filter((x) => x.type === 'output_text').map((x) => x.text || '').join('');
        return text ? { kind: 'commentary', id: item.id, text: publicText(text), at: Date.now() } : null;
      }
      if (toolTypes.has(item.type)) {
        const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
        const details = [];
        if (Number.isFinite(item.durationMs) && item.durationMs >= 0) details.push(`耗时：${(item.durationMs / 1000).toFixed(1)} 秒`);
        if (Number.isInteger(item.exitCode)) details.push(`退出码：${item.exitCode}`);
        details.push(presentation?.detail);
        return { kind: 'tool', id: item.id, title: presentation?.title || toolLabel(item), summary: details.filter(Boolean).join('\n').slice(0, 500), status: method === 'item/started' ? 'running' : failed ? 'failed' : 'completed', at: Date.now() };
      }
    }
    return null;
  };
}
