#!/usr/bin/env node
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { readFile } from 'node:fs/promises';
import { StoreError } from '../src/storage/errors.mjs';
import { dirname, resolve } from 'node:path';
import { checkGroupInstructions } from '../src/core/group-instructions.mjs';

const SAFE_MIGRATION_CODES = new Set(['legacy_connection_id_required', 'legacy_connection_id_mismatch', 'invalid_legacy_connection_id', 'writer_busy', 'migration_busy', 'schema_version_mismatch']);
const HELP = `agent-chat-bridge

Usage:
  agent-chat-bridge --help
  agent-chat-bridge --version
  agent-chat-bridge check-config --config <path>
  agent-chat-bridge start --config <path>
  agent-chat-bridge migrate --config <path> [--legacy-connection-id <original-connection-id>]

An explicit JSON config path is required; no config or .env auto-discovery.
check-config validates syntax and configured group instruction files; it never resolves environment secrets.
start assembles explicitly configured Feishu, Codex and MySQL components.
Health-only configuration remains live but readiness returns 503.
migrate explicitly applies the configured Store schema; start never migrates.
`;

const log = createLogger();
const [command, flag, path, ...extra] = process.argv.slice(2);
try {
  if (command === '--help' && flag === undefined) {
    process.stdout.write(HELP);
  } else if (command === '--version' && flag === undefined) {
    process.stdout.write(await readFile(new URL('../VERSION', import.meta.url), 'utf8'));
  } else {
    if ((!['check-config', 'start', 'migrate'].includes(command) || flag !== '--config'
        || !path || path.startsWith('--') || (command === 'migrate' ? (extra.length !== 0 && (extra.length !== 2 || extra[0] !== '--legacy-connection-id' || !extra[1])) : extra.length !== 0))) {
      throw new ConfigError('invalid_arguments');
    }
    const config = await loadConfig(path);
    if (command === 'check-config') {
      const problems = await checkGroupInstructions(config.routing?.groups ?? [], { configDir: dirname(resolve(path)) });
      for (const problem of problems) log('warning', 'check_config', 'failed', { code: 'invalid_group_instruction_file', ...problem });
      if (problems.length) throw new ConfigError('invalid_group_instruction_file');
      log('info', 'check_config', 'succeeded');
    } else if (command === 'migrate') {
      const { migrateService } = await import('../src/service.mjs');
      await migrateService({ config, legacyConnectionId: extra[1] });
      log('info', 'migration', 'succeeded');
    } else {
      const { startService } = await import('../src/service.mjs');
      const controller = new AbortController();
      let service;
      const exitAfterShutdown = code => { if (config.storage) process.exit(code); };
      const shutdown = () => {
        controller.abort();
        if (!service) return;
        service.close().then(() => exitAfterShutdown(0)).catch(() => {
          log('error', 'shutdown', 'failed', { code: 'shutdown_failed' });
          process.exit(1);
        });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      try {
        service = await startService({ config, configPath: path, log, signal: controller.signal,
          onRestartRequired: (_reason, exitCode = 0) => exitAfterShutdown(exitCode) });
        if (controller.signal.aborted) shutdown();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        process.exit(0);
      }
    }
  }
} catch (error) {
  const safeMigrationCode = command === 'migrate' && error instanceof StoreError && SAFE_MIGRATION_CODES.has(error.code);
  log(error instanceof ConfigError || safeMigrationCode ? 'warning' : 'error',
    'startup', 'failed', {
    code: error instanceof ConfigError || safeMigrationCode ? error.code : 'startup_failed',
  });
  process.exitCode = 1;
  // Locked SDK owns a cache interval even after WS close. All service cleanup
  // has completed before startup rejects; do not leave a failed CLI resident.
  process.stdout.write('', () => process.exit(1));
}
