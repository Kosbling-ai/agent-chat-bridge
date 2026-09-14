import { readFile } from 'node:fs/promises';
import { createPoolFromEnvironment } from './connection.mjs';
import { migrate } from './migrations.mjs';
import { StoreError } from './errors.mjs';

const SAFE_MIGRATION_CODES = new Set(['legacy_connection_id_required', 'legacy_connection_id_mismatch', 'invalid_legacy_connection_id', 'writer_busy', 'migration_busy', 'schema_version_mismatch']);

const args = process.argv.slice(2);
const valid = (args.length === 2 || (args.length === 4 && args[2] === '--legacy-connection-id' && args[3]))
  && args[0] === '--config' && args[1];
if (!valid) {
  process.stderr.write('Usage: node src/storage/migrate-cli.mjs --config <storage-reference-json> [--legacy-connection-id <original-connection-id>]\n');
  process.exitCode = 1;
} else {
  let pool;
  try {
    pool = createPoolFromEnvironment(JSON.parse(await readFile(args[1], 'utf8')));
    const result = await migrate(pool, { legacyConnectionId: args[3] });
    process.stdout.write(JSON.stringify({ module: 'bridge', component: 'storage', operation: 'migrate', status: 'succeeded', version: result.version, applied: result.applied }) + '\n');
  } catch (error) {
    const code = error instanceof StoreError && SAFE_MIGRATION_CODES.has(error.code) ? error.code : 'migration_failed';
    process.stderr.write(JSON.stringify({ module: 'bridge', component: 'storage', operation: 'migrate', status: 'failed', code }) + '\n');
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); }
}
