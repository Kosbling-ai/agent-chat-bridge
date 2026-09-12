#!/usr/bin/env node
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { startServer } from '../src/server.mjs';

const HELP = `agent-chat-bridge (foundation only)

Usage:
  agent-chat-bridge --help
  agent-chat-bridge check-config --config <path>
  agent-chat-bridge start --config <path>

An explicit JSON config path is required; no config or .env auto-discovery.
check-config validates syntax only and never resolves environment secrets.
start runs local HTTP health endpoints; Feishu, Codex and Store are not wired.
GET /health/live returns 200; GET /health/ready returns 503.
`;

const log = createLogger();
const [command, flag, path, ...extra] = process.argv.slice(2);
try {
  if (command === '--help' && flag === undefined) {
    process.stdout.write(HELP);
  } else {
    if (!['check-config', 'start'].includes(command) || flag !== '--config'
        || !path || path.startsWith('--') || extra.length) {
      throw new ConfigError('invalid_arguments');
    }
    const config = await loadConfig(path);
    if (command === 'check-config') {
      log('info', 'check_config', 'succeeded');
    } else {
      const service = await startServer({ config, log });
      const shutdown = () => {
        service.close().catch(() => {
          log('error', 'shutdown', 'failed', { code: 'shutdown_failed' });
          process.exitCode = 1;
        });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
  }
} catch (error) {
  log(error instanceof ConfigError ? 'warning' : 'error', 'startup', 'failed', {
    code: error instanceof ConfigError ? error.code : 'startup_failed',
  });
  process.exitCode = 1;
}
