import test from 'node:test';
import assert from 'node:assert/strict';
import { codexTurnError } from '../src/agents/codex/turn-error.mjs';
test('terminal classifications accept only structured enums and sanitize all provider text', () => {
  for (const error of [{ codexErrorInfo: 'usageLimitExceeded' }, { codex_error_info: 'usage_limit_exceeded' }]) {
    assert.equal(codexTurnError({ ...error, message: 'private token' }).code, 'CODEX_USAGE_LIMIT_EXCEEDED');
    assert.equal(codexTurnError(error, 'interrupted').code, 'CODEX_TURN_INTERRUPTED');
  }
  const overloaded = codexTurnError({ codexErrorInfo: 'server_overloaded', message: 'private token' });
  assert.equal(overloaded.code, 'CODEX_SERVER_OVERLOADED');
  assert.equal(overloaded.publicMessage, 'Codex 模型服务当前繁忙，本次执行未完成。请稍后重试。');
  for (const error of [{ message: 'usage_limit_exceeded SECRET' }, { codexErrorInfo: 'unknown', message: 'SECRET' }, { codexErrorInfo: { other: 'SECRET' } }]) {
    const mapped = codexTurnError(error);
    assert.equal(mapped.code, 'CODEX_TURN_FAILED');
    assert.equal(mapped.message, '执行未完成，请稍后重试。');
  }
});
