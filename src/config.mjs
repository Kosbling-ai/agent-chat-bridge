import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function object(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ConfigError(code);
  }
}

export function isLoopback(host) {
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}

export function validateConfig(raw) {
  object(raw, ['schemaVersion', 'listen', 'auth'], 'invalid_config_fields');
  if (raw.schemaVersion !== 1) throw new ConfigError('unsupported_config_version');
  const listen = raw.listen === undefined ? {} : raw.listen;
  object(listen, ['host', 'port', 'allowRemote'], 'invalid_listen_fields');
  const { host = '127.0.0.1', port = 18830, allowRemote = false } = listen;
  if (typeof host !== 'string' || !isIP(host)) throw new ConfigError('invalid_listen_host');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('invalid_listen_port');
  if (typeof allowRemote !== 'boolean') throw new ConfigError('invalid_remote_flag');
  if (!isLoopback(host) && !allowRemote) throw new ConfigError('remote_listen_not_allowed');

  let tokenEnv;
  if (raw.auth !== undefined) {
    object(raw.auth, ['tokenEnv'], 'invalid_auth_fields');
    tokenEnv = raw.auth.tokenEnv;
    if (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv)) {
      throw new ConfigError('invalid_token_env_reference');
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    listen: Object.freeze({ host, port, allowRemote }),
    auth: tokenEnv ? Object.freeze({ tokenEnv }) : undefined,
  });
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(resolve(path), 'utf8');
  } catch {
    throw new ConfigError('config_unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON parser errors can contain user-supplied secrets. Never expose them.
    throw new ConfigError('invalid_config_json');
  }
  return validateConfig(raw);
}
