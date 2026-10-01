import { createHash } from 'node:crypto';
import { escapeMarkdown } from '../../shared/text-template.mjs';
import { normalizeUserInputAnswers } from './user-input-request.mjs';

export const COMPUTER_USE_REQUEST = 'mcpServer/elicitation/request';
const allow = '允许本次请求';
const allowForTurn = '本轮任务内允许该应用';
const deny = '拒绝';
const appTools = new Set(['get_app_state', 'click', 'drag', 'scroll', 'press_key', 'paste', 'type_text', 'set_value', 'select_text', 'perform_secondary_action']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);
const invalid = () => Object.assign(new Error('Unsupported computer use approval'), { code: 'CODEX_COMPUTER_USE_UNSUPPORTED' });

// Only app-access approvals from the bundled CUA runtime are understood here.
// In particular, URL/auth/secret/audio requests and arbitrary MCP forms must not
// be turned into an approval just because they have a similar message.
export function normalizeComputerUseApproval(request) {
  const p = request?.params;
  const meta = p?._meta;
  if (!Number.isSafeInteger(request?.generation) || request.generation < 1
      || !object(p) || !text(p.threadId, 255) || !text(p.turnId, 255)
      || p.serverName !== 'cua_repl' || !['form', 'openai/form', 'openaiForm'].includes(p.mode)
      || !object(meta) || meta.codex_approval_kind !== 'mcp_tool_call' || meta.connector_id !== 'computer-use'
      || !object(meta.tool_params) || Object.keys(meta.tool_params).some(key => key !== 'app') || !text(meta.tool_params.app, 255)
      || !appTools.has(meta.tool_name)
      || meta.tool_params.app === 'computer-audio'
      || !Array.isArray(meta.persist) || !meta.persist.includes('session')) throw invalid();
  const schema = p.requestedSchema;
  if (!object(schema) || Object.keys(schema).some(key => !['type', 'properties', 'required'].includes(key))
      || schema.type !== 'object' || !object(schema.properties)
      || Object.keys(schema.properties).length || (schema.required != null && (!Array.isArray(schema.required) || schema.required.length))) throw invalid();
  const app = meta.tool_params.app;
  const display = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display.find(field => field?.name === 'app')?.value : undefined;
  const name = text(display, 255) ? display : app;
  if (meta.riskLevel != null && !text(meta.riskLevel, 40)) throw invalid();
  if (meta.subtitle != null && meta.subtitle !== '' && !text(meta.subtitle, 700)) throw invalid();
  const risk = text(meta.riskLevel, 40) ? meta.riskLevel : '未提供';
  const subtitle = text(meta.subtitle, 700) ? meta.subtitle : '';
  const warning = subtitle ? `\n提示：${escapeMarkdown(subtitle)}` : '';
  const question = `Codex 请求通过 Computer Use 操作应用：${escapeMarkdown(name)}\n应用标识：${escapeMarkdown(app)}\n工具：${escapeMarkdown(meta.tool_name)}\n风险等级：${escapeMarkdown(risk)}${warning}\n允许后可读取该应用内容并执行界面操作；此选择不保存为永久授权。后续涉及敏感或不可逆操作时仍须单独确认。`;
  const identity = `${request.generation}:${p.threadId}:${p.turnId}:${typeof request.requestId}:${JSON.stringify(request.requestId)}`;
  const turnGrantKey = createHash('sha256').update(JSON.stringify([request.generation, app, risk, subtitle])).digest('hex');
  return {
    requestId: request.requestId, threadId: p.threadId, turnId: p.turnId,
    itemId: `computer-use-${createHash('sha256').update(identity).digest('hex')}`,
    computerUseGrant: { app, key: turnGrantKey },
    isBlocking: true, kind: 'computerUse',
    questions: [{ id: 'computer_use', header: 'Computer Use 应用授权', question, isOther: false,
      options: [
        { label: deny, description: '不允许此次应用访问' },
        { label: allow, description: '仅继续本次应用访问' },
        { label: allowForTurn, description: '本轮任务内相同风险提示的该应用访问无需再次确认' },
      ] }],
  };
}

export function computerUseApprovalDecision(questions, answers) {
  const result = normalizeUserInputAnswers(questions, answers);
  const choice = result.answers.computer_use.answers[0];
  return {
    result: { action: choice === deny ? 'decline' : 'accept', content: null, _meta: null },
    grantForTurn: choice === allowForTurn,
  };
}

export function computerUseApprovalResult(questions, answers) {
  return computerUseApprovalDecision(questions, answers).result;
}

export const cancelComputerUseApproval = () => ({ action: 'cancel', content: null, _meta: null });
