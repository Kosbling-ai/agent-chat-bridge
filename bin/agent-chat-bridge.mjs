#!/usr/bin/env node
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { startService, migrateService } from '../src/service.mjs';

const HELP = `agent-chat-bridge

Usage:
  agent-chat-bridge --help
  agent-chat-bridge check-config --config <path>
  agent-chat-bridge start --config <path>
  agent-chat-bridge migrate --config <path>

An explicit JSON config path is required; no config or .env auto-discovery.
check-config validates syntax only and never resolves environment secrets.
start assembles explicitly configured Feishu, Codex and MySQL components.
Health-only configuration remains live but readiness returns 503.
migrate explicitly applies the configured Store schema; start never migrates.
`;

const log = createLogger();
const [command, flag, path, ...extra] = process.argv.slice(2);
try {
  if (command === '--help' && flag === undefined) {
    process.stdout.write(HELP);
  } else {
    if (!['check-config', 'start', 'migrate'].includes(command) || flag !== '--config'
        || !path || path.startsWith('--') || extra.length) {
      throw new ConfigError('invalid_arguments');
    }
    const config = await loadConfig(path);
    if (command === 'check-config') {
      log('info', 'check_config', 'succeeded');
    } else if (command === 'migrate') {
      await migrateService({ config });
      log('info', 'migration', 'succeeded');
    } else {
      const controller = new AbortController();
      let service;
      const shutdown = () => {
        controller.abort();
        if (!service) return;
        service.close().then(() => { if (config.storage) process.exit(0); }).catch(() => {
          log('error', 'shutdown', 'failed', { code: 'shutdown_failed' });
          process.exit(1);
        });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      try {
        service = await startService({ config, configPath: path, log, signal: controller.signal });
        if (controller.signal.aborted) shutdown();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        process.exit(0);
      }
    }
  }
} catch (error) {
  log(error instanceof ConfigError ? 'warning' : 'error', 'startup', 'failed', {
    code: error instanceof ConfigError ? error.code : 'startup_failed',
  });
  process.exitCode = 1;
  // Locked SDK owns a cache interval even after WS close. All service cleanup
  // has completed before startup rejects; do not leave a failed CLI resident.
  process.stdout.write('', () => process.exit(1));
}
