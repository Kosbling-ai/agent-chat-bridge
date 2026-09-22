// App-server v2 translates the rollout enum to camelCase. Only explicit
// structured classifications are accepted; user/provider prose is not a code.
export function codexTurnError(error, status = 'failed') {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const normalized = typeof info === 'string' ? info : '';
  const code = status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED'
    : info === 'usageLimitExceeded' || info === 'usage_limit_exceeded' ? 'CODEX_USAGE_LIMIT_EXCEEDED'
      : ['server_overloaded', 'serverOverloaded', 'model_overloaded'].includes(normalized) ? 'CODEX_SERVER_OVERLOADED'
      : 'CODEX_TURN_FAILED';
  const publicMessage = code === 'CODEX_USAGE_LIMIT_EXCEEDED'
    ? 'Codex 额度不足，本次执行已停止。请在额度恢复后再继续；不会自动重试此任务。'
    : code === 'CODEX_SERVER_OVERLOADED'
      ? 'Codex 模型服务当前繁忙，本次执行未完成。请稍后重试。'
      : code === 'CODEX_TURN_INTERRUPTED' ? '执行已停止。' : '执行未完成，请稍后重试。';
  return Object.assign(new Error(publicMessage), { code, publicMessage });
}
