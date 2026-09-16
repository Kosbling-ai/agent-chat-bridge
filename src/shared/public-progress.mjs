// Only public assistant commentary and tool lifecycle enter the chat channel.
// Never project reasoning, raw shell, arbitrary arguments or output.
import { isAbsolute, relative } from 'node:path';
import { formatText } from './text-template.mjs';
export function publicText(value, limit = 1200) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[已隐藏凭据]')
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|(?:token|password|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+)/gi, '[已隐藏凭据]')
    .replace(/\b(?:mysql|postgres(?:ql)?):\/\/\S+/gi, '[已隐藏连接信息]')
    .slice(0, limit);
}
const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'function_call', 'fileChange', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall']);
export const DEFAULT_TOOL_COPY = Object.freeze({
  toolCommandExecutionLabel: '执行命令', toolFileChangeLabel: '更新文件', toolWebSearchLabel: '搜索资料',
  toolImageViewLabel: '查看图片', toolImageGenerationLabel: '生成图片', toolCollabAgentLabel: '协作任务',
  toolOrderLabel: '处理订单', toolDocumentLabel: '处理文档', toolSearchLabel: '搜索资料',
  toolSheetLabel: '处理表格', toolReadLabel: '读取信息', toolGenericLabel: '调用工具',
  actionReadLabel: '读取', actionListFilesLabel: '列出文件', actionSearchLabel: '搜索',
  skillLabel: '技能', fileLabel: '文件', durationLabel: '耗时', secondsLabel: '秒',
  exitCodeLabel: '退出码', commandLabel: '命令', toolLabel: '工具',
  toolTitleTemplate: '{name} · {label}', fieldTemplate: '{label}：{value}',
  readTargetTemplate: '{action} {target}', readFallbackTemplate: '{action}{file}',
  skillReadTemplate: '{action} {skill} {skillLabel}', actionTargetTemplate: '{action}：{target}',
  durationTemplate: '{label}：{seconds} {unit}',
});
const toolLabelKeys = Object.freeze({
  commandExecution: 'toolCommandExecutionLabel', fileChange: 'toolFileChangeLabel', webSearch: 'toolWebSearchLabel',
  imageView: 'toolImageViewLabel', imageGeneration: 'toolImageGenerationLabel', collabAgent: 'toolCollabAgentLabel',
  order: 'toolOrderLabel', document: 'toolDocumentLabel', search: 'toolSearchLabel', sheet: 'toolSheetLabel',
  read: 'toolReadLabel', generic: 'toolGenericLabel',
});
function toolVariant(item) {
  if (item.type === 'commandExecution') return 'commandExecution';
  if (item.type === 'fileChange') return 'fileChange';
  if (item.type === 'webSearch') return 'webSearch';
  if (item.type === 'imageView') return 'imageView';
  if (item.type === 'imageGeneration') return 'imageGeneration';
  if (item.type === 'collabAgentToolCall') return 'collabAgent';
  const name = String(item.tool || item.name || '').toLowerCase();
  if (/order/.test(name)) return 'order';
  if (/doc|wiki/.test(name)) return 'document';
  if (/search/.test(name)) return 'search';
  if (/sheet|base/.test(name)) return 'sheet';
  if (/read|fetch|get/.test(name)) return 'read';
  return 'generic';
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
    return { version: 1, kind: 'tool', variant: toolVariant(item), data: { name } };
  }
  const actions = Array.isArray(item.commandActions) ? item.commandActions.slice(0, 4) : [];
  const programs = [...new Set((actions.length ? actions : [item]).map((a) => programName(a.command || item.command)))];
  const targets = actions.map((a) => {
    const path = safeTarget(a.path, item.cwd);
    if (a.type === 'read') {
      // SKILL.md is a conventional structured target. Publish only its skill
      // name, never the absolute personal skills directory.
      const skill = String(a.path || '').match(/(?:^|\/)skills\/([A-Za-z0-9_-]{1,64})\/SKILL\.md$/)?.[1];
      if (skill && safeName(skill)) return { kind: 'skill', target: skill };
      const name = safeTarget(String(a.name || '').split(/[\\/]/).pop());
      return name || path ? { kind: 'read', target: name || path } : { kind: 'readFile' };
    }
    return a.type === 'listFiles' || a.type === 'search' ? { kind: a.type, ...(path ? { target: path } : {}) } : null;
  }).filter(Boolean);
  return { version: 1, kind: 'command', data: { programs, actions: targets } };
}
function addCompletionFacts(presentation, item) {
  const data = { ...presentation.data };
  if (Number.isFinite(item.durationMs) && item.durationMs >= 0) data.durationMs = item.durationMs;
  if (Number.isInteger(item.exitCode)) data.exitCode = item.exitCode;
  return { ...presentation, data };
}
function renderAction(action, copy) {
  if (action.kind === 'skill' && safeName(action.target)) return formatText(copy.skillReadTemplate, { action: copy.actionReadLabel, skill: action.target, skillLabel: copy.skillLabel });
  if (action.kind === 'read' && safeTarget(action.target)) return formatText(copy.readTargetTemplate, { action: copy.actionReadLabel, target: action.target });
  if (action.kind === 'readFile') return formatText(copy.readFallbackTemplate, { action: copy.actionReadLabel, file: copy.fileLabel });
  const label = action.kind === 'listFiles' ? copy.actionListFilesLabel : action.kind === 'search' ? copy.actionSearchLabel : '';
  if (!label) return '';
  const target = safeTarget(action.target);
  return target ? formatText(copy.actionTargetTemplate, { action: label, target }) : label;
}
function validProgram(value) {
  const text = String(value || '');
  return safeName(text) || (/^git (?:status|diff|log|show|test|check|run|build)$/.test(text) ? text : '');
}
export function renderPublicToolEntry(entry, copy = {}) {
  const merged = { ...DEFAULT_TOOL_COPY, ...copy };
  const presentation = entry?.presentation;
  if (!presentation || presentation.version !== 1 || !presentation.data || typeof presentation.data !== 'object') {
    return { title: publicText(entry?.title, 100), summary: publicText(entry?.summary, 500) };
  }
  const data = presentation.data;
  const details = [];
  let title = '';
  if (Number.isFinite(data.durationMs) && data.durationMs >= 0) {
    details.push(formatText(merged.durationTemplate, { label: merged.durationLabel, seconds: (data.durationMs / 1000).toFixed(1), unit: merged.secondsLabel }));
  }
  if (Number.isInteger(data.exitCode)) details.push(formatText(merged.fieldTemplate, { label: merged.exitCodeLabel, value: data.exitCode }));
  if (presentation.kind === 'tool' && Object.hasOwn(toolLabelKeys, presentation.variant)) {
    const name = safeName(data.name);
    if (!name) return { title: publicText(entry?.title, 100), summary: publicText(entry?.summary, 500) };
    title = formatText(merged.toolTitleTemplate, { name, label: merged[toolLabelKeys[presentation.variant]] });
    details.push(formatText(merged.fieldTemplate, { label: merged.toolLabel, value: name }));
  } else if (presentation.kind === 'command' && Array.isArray(data.programs) && Array.isArray(data.actions)) {
    const programs = data.programs.slice(0, 4).map(validProgram).filter(Boolean);
    const actions = data.actions.slice(0, 4).map((action) => action && typeof action === 'object' ? renderAction(action, merged) : '').filter(Boolean);
    if (!programs.length) return { title: publicText(entry?.title, 100), summary: publicText(entry?.summary, 500) };
    const name = programs.join(' / ');
    title = actions[0] || name;
    details.push(formatText(merged.fieldTemplate, { label: merged.commandLabel, value: name }), ...actions);
  } else {
    return { title: publicText(entry?.title, 100), summary: publicText(entry?.summary, 500) };
  }
  return { title: publicText(title, 100), summary: publicText(details.join('\n'), 500) };
}
export function createPublicProgressProjector() {
  const items = new Map();
  return (method, params = {}) => {
    const item = params.item;
    if ((method === 'item/started' || method === 'item/completed') && item?.id) {
      const previous = items.get(item.id) || {};
      if (items.size >= 100 && !items.has(item.id)) items.delete(items.keys().next().value);
      let presentation = previous.presentation || (toolTypes.has(item.type) ? toolPresentation(item) : null);
      if (presentation && toolTypes.has(item.type)) presentation = addCompletionFacts(presentation, item);
      const meta = { ...previous, presentation, type: item.type, phase: item.phase || previous.phase, text: publicText(item.text || previous.text) };
      items.set(item.id, meta);
      if (method === 'item/completed' && (item.type === 'agentMessage' || item.type === 'message') && meta.phase === 'commentary' && item.role !== 'user') {
        const text = item.text || (item.content || []).filter((x) => x.type === 'output_text').map((x) => x.text || '').join('');
        return text ? { kind: 'commentary', id: item.id, text: publicText(text), at: Date.now() } : null;
      }
      if (toolTypes.has(item.type)) {
        const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
        const rendered = renderPublicToolEntry({ presentation });
        return { kind: 'tool', id: item.id, ...rendered, presentation, status: method === 'item/started' ? 'running' : failed ? 'failed' : 'completed', at: Date.now() };
      }
    }
    return null;
  };
}
