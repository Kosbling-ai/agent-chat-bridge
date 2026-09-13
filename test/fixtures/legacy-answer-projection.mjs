// Frozen production pure functions from agent-server.mjs at 2c16174.
// SHA256 of source functions: 628dbef9e34ba5054636635d4305edcbe133a12aa9bbbfb3b09f8bbee80ff586
function projectCodexItem(item) {
  switch (item?.type) {
    case 'message':
      {
        const text = codexMessageText(item);
        if (!text.trim()) return null;
        const role = item.role === 'user' ? 'user' : 'assistant';
        return {
          eventType: role === 'user' ? 'user_message' : 'agent_message',
          role,
          title: role === 'user' ? '用户' : (item.phase === 'final_answer' ? 'Codex 回复' : 'Codex'),
          text,
          detail: { phase: item.phase || '' },
        };
      }
    case 'function_call':
      return {
        eventType: 'tool_call',
        role: 'activity',
        title: `工具调用 · ${item.name || 'function'}`,
        text: compactJsonText(item.arguments || {}),
        detail: {
          callId: item.call_id || item.callId || '',
          name: item.name || '',
        },
      };
    case 'function_call_output':
      return {
        eventType: 'tool_output',
        role: 'activity',
        title: `工具结果${item.call_id ? ` · ${item.call_id}` : ''}`,
        text: limitText(item.output || '', 12000),
        detail: {
          callId: item.call_id || item.callId || '',
        },
      };
    case 'agentMessage':
      return {
        eventType: 'agent_message',
        role: 'assistant',
        title: item.phase === 'final_answer' ? 'Codex 回复' : 'Codex',
        text: item.text || '',
        detail: { phase: item.phase || '' },
      };
    case 'plan':
      return {
        eventType: 'plan',
        role: 'activity',
        title: '计划更新',
        text: item.text || '',
      };
    case 'reasoning':
      {
        const text = [...(item.summary || []), ...(item.content || [])].join('\n');
        if (!text.trim()) return null;
        return {
          eventType: 'reasoning',
          role: 'activity',
          title: '推理摘要',
          text,
        };
      }
    case 'commandExecution':
      return {
        eventType: 'command_execution',
        role: 'activity',
        title: `运行命令${item.exitCode == null ? '' : ` · exit ${item.exitCode}`}`,
        text: item.command || '',
        detail: {
          cwd: item.cwd || '',
          status: item.status || '',
          output: limitText(item.aggregatedOutput || '', 12000),
        },
      };
    case 'fileChange':
      return {
        eventType: 'file_change',
        role: 'activity',
        title: '文件变更',
        text: (item.changes || []).map((change) => [change.kind || change.type || 'change', change.path || change.file || change.oldPath || change.newPath || ''].filter(Boolean).join(' ')).join('\n'),
      };
    case 'mcpToolCall':
      return {
        eventType: 'tool_call',
        role: 'activity',
        title: `MCP 工具 · ${[item.server, item.tool].filter(Boolean).join('.')}`,
        text: JSON.stringify(item.arguments ?? {}),
      };
    case 'dynamicToolCall':
      return {
        eventType: 'tool_call',
        role: 'activity',
        title: `工具调用 · ${[item.namespace, item.tool].filter(Boolean).join('.')}`,
        text: JSON.stringify(item.arguments ?? {}),
      };
    case 'webSearch':
      return {
        eventType: 'web_search',
        role: 'activity',
        title: '网页搜索',
        text: item.query || '',
      };
    case 'contextCompaction':
      return {
        eventType: 'context_compaction',
        role: 'activity',
        title: '上下文压缩',
        text: 'Codex 已压缩上下文以继续会话。',
      };
    default:
      return null;
  }
}


function extractFinalAnswer(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const final = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.phase === 'final_answer' && String(item.text || '').trim());
  if (final) return String(final.text || '').trim();
  const finalMessage = [...items].reverse().find((item) => (
    item?.type === 'message'
    && item.role === 'assistant'
    && item.phase === 'final_answer'
    && codexMessageText(item).trim()
  ));
  if (finalMessage) return codexMessageText(finalMessage).trim();
  const last = [...items].reverse().find((item) => item?.type === 'agentMessage' && String(item.text || '').trim());
  return last ? String(last.text || '').trim() : '';
}


function codexMessageText(item = {}) {
  if (typeof item.text === 'string') return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return part.text || part.input_text || part.output_text || '';
  }).filter(Boolean).join('\n');
}


function compactJsonText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value || '');
  }
}

function limitText(value, max) {
  const text = String(value || '');
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}


function appendLimitedText(current, delta, max) {
  const text = `${current || ''}${delta || ''}`;
  if (!max || text.length <= max) return text;
  return text.slice(-max);
}


export { projectCodexItem, extractFinalAnswer, appendLimitedText };
