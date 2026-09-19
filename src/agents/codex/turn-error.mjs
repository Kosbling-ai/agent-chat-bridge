// App-server v2 translates the rollout enum to camelCase. Only explicit
// structured classifications are accepted; user/provider prose is not a code.
export function codexTurnError(error, status = 'failed') {
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const code = status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED'
    : info === 'usageLimitExceeded' || info === 'usage_limit_exceeded' ? 'CODEX_USAGE_LIMIT_EXCEEDED'
      : 'CODEX_TURN_FAILED';
  return Object.assign(new Error(code === 'CODEX_USAGE_LIMIT_EXCEEDED' ? 'Codex usage limit exceeded'
    : code === 'CODEX_TURN_INTERRUPTED' ? 'Codex turn interrupted' : 'Codex turn failed'), { code });
}
