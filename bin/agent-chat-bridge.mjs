#!/usr/bin/env node
import { ConfigError, loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { readFile } from 'node:fs/promises';
import { StoreError } from '../src/storage/errors.mjs';

const SAFE_MIGRATION_CODES = new Set(['legacy_connection_id_required', 'legacy_connection_id_mismatch', 'invalid_legacy_connection_id', 'writer_busy', 'migration_busy', 'schema_version_mismatch']);
const SAFE_IMPORT_CODES = new Set(['invalid_binding_snapshot', 'unsupported_binding_snapshot_version',
  'binding_import_connection_mismatch', 'binding_import_source_not_drained', 'binding_import_mapping_missing',
  'binding_import_mapping_unused', 'binding_import_identity_mismatch', 'binding_import_duplicate_identity',
  'binding_import_duplicate_thread', 'binding_import_target_jobs', 'binding_import_conflict',
  'binding_import_thread_conflict', 'binding_import_rules_rollover_enabled', 'writer_busy', 'schema_version_mismatch',
  'commit_unknown']);

const HELP = `agent-chat-bridge

Usage:
  agent-chat-bridge --help
  agent-chat-bridge --version
  agent-chat-bridge check-config --config <path>
  agent-chat-bridge start --config <path>
  agent-chat-bridge migrate --config <path> [--legacy-connection-id <original-connection-id>]
  agent-chat-bridge import-bindings --config <path> --input <snapshot.json> [--apply]

An explicit JSON config path is required; no config or .env auto-discovery.
check-config validates syntax only and never resolves environment secrets.
start assembles explicitly configured Feishu, Codex and MySQL components.
Health-only configuration remains live but readiness returns 503.
migrate explicitly applies the configured Store schema; start never migrates.
import-bindings validates and previews by default; --apply is required to write bindings.
`;

const log = createLogger();
const [command, flag, path, ...extra] = process.argv.slice(2);
try {
  if (command === '--help' && flag === undefined) {
    process.stdout.write(HELP);
  } else if (command === '--version' && flag === undefined) {
    process.stdout.write(await readFile(new URL('../VERSION', import.meta.url), 'utf8'));
  } else {
    const importArgsValid = command === 'import-bindings' && flag === '--config' && path && !path.startsWith('--')
      && (extra.length === 2 || (extra.length === 3 && extra[2] === '--apply')) && extra[0] === '--input'
      && extra[1] && !extra[1].startsWith('--');
    if ((!['check-config', 'start', 'migrate'].includes(command) || flag !== '--config'
        || !path || path.startsWith('--') || (command === 'migrate' ? (extra.length !== 0 && (extra.length !== 2 || extra[0] !== '--legacy-connection-id' || !extra[1])) : extra.length !== 0))
        && !importArgsValid) {
      throw new ConfigError('invalid_arguments');
    }
    const config = await loadConfig(path);
    if (command === 'check-config') {
      log('info', 'check_config', 'succeeded');
    } else if (command === 'migrate') {
      const { migrateService } = await import('../src/service.mjs');
      await migrateService({ config, legacyConnectionId: extra[1] });
      log('info', 'migration', 'succeeded');
    } else if (command === 'import-bindings') {
      if (!config.storage) throw new ConfigError('storage_unconfigured');
      const { createPoolFromEnvironment } = await import('../src/storage/connection.mjs');
      const { bindingSnapshotHash, importBindingSnapshot } = await import('../src/storage/binding-import.mjs');
      const bytes = await readFile(extra[1]);
      if (bytes.length > 2 * 1024 * 1024) throw new ConfigError('binding_snapshot_too_large');
      let snapshot;
      try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { throw new ConfigError('invalid_binding_snapshot'); }
      const pool = createPoolFromEnvironment(config.storage);
      try {
        const result = await importBindingSnapshot({ pool, connectionId: config.feishu.connectionId,
          rolloverOnRulesUpdate: config.codex.rolloverOnRulesUpdate, snapshot, apply: extra[2] === '--apply' });
        log('info', 'binding_import', result.applied ? 'succeeded' : 'previewed', {
          snapshotSha256: bindingSnapshotHash(bytes), total: result.total, inserted: result.inserted,
          unchanged: result.unchanged, legacyUnknown: result.sourceQueue.unknown, legacyHeld: result.sourceQueue.held,
          mappings: result.mappings,
        });
      } finally { await pool.end(); }
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
        service = await startService({ config, configPath: path, log, signal: controller.signal, onRestartRequired: () => exitAfterShutdown(0) });
        if (controller.signal.aborted) shutdown();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        process.exit(0);
      }
    }
  }
} catch (error) {
  const safeMigrationCode = command === 'migrate' && error instanceof StoreError && SAFE_MIGRATION_CODES.has(error.code);
  const safeImportCode = command === 'import-bindings' && error instanceof StoreError && SAFE_IMPORT_CODES.has(error.code);
  log(error instanceof ConfigError || safeMigrationCode || safeImportCode ? 'warning' : 'error',
    command === 'import-bindings' ? 'binding_import' : 'startup', 'failed', {
    code: error instanceof ConfigError || safeMigrationCode || safeImportCode ? error.code : command === 'import-bindings' ? 'binding_import_failed' : 'startup_failed',
  });
  process.exitCode = 1;
  // Locked SDK owns a cache interval even after WS close. All service cleanup
  // has completed before startup rejects; do not leave a failed CLI resident.
  process.stdout.write('', () => process.exit(1));
}
