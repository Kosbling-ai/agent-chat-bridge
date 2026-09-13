# Versions and migrations

Application version: `0.1.1`

`VERSION` is the application release version. Keep package.json, both root package-lock versions, README and CHANGELOG aligned; `npm run version:check` and `npm run check` enforce this. Use an explicit stable `MAJOR.MINOR.PATCH` number, with 0.x denoting ongoing initial development. Bump once per delivery batch, not per fix. Once released, do not move its tag or rewrite its versioned history; subsequent fixes get a new release. Documentation-only corrections need no empty migration or release bump.

Application versions, config `schemaVersion` and numbered database migrations are separate contracts. Changing one does not mechanically increment the others. Startup validates the DB migration ledger and checksum; only the explicit migrate command performs DDL. Applied SQL is immutable. After this initial release, schema changes require a new numbered forward migration and corresponding runner support, not edits to 001. MySQL DDL is not transactionally reversible; do not promise an automatic down migration.

## 0.1.1 upgrade

This batch changes final reply presentation and adds optional `codex.proxyEnv`
references. Config schema stays 1; migration 001 and the database checksum are
unchanged. Do not rerun initialization or reset the existing trial database.

Before switching code, stop the existing writer gracefully and preserve the
workspace and database. Start exactly one bridge instance with the reviewed
configuration. Existing persisted text effects retain their original payload;
only newly finalized replies use cards. Unknown native work and unknown sends
retain their recovery state and must not be replayed during upgrade. Proxy
references resolve at startup and affect only the Codex child; missing values
fail before provider startup. See [proxy configuration](docs/codex-proxy.md).

Rollback to 0.1.0 uses the same unchanged schema, but remove the optional
`codex.proxyEnv` field before starting the old strict config validator. Stop
the current writer first. Do not move the published v0.1.0 tag or erase external
effects to simulate rollback. Dynamic progress cards and the broader migration
parity audit remain outside this batch.

## 0.1.0 initial installation

This release targets a new, dedicated MySQL 8.4 database and config schema 1. It does not import or modify the existing Kosbling database. Choose an owned Agent workspace and inject credentials through the host's controlled secret mechanism; never commit local configuration or secrets. Follow [runtime setup](docs/runtime.md) for explicit configuration and migration commands.

Before upgrading an existing local trial installation, stop its writer and preserve a database backup plus the Agent workspace/media directories together. Development databases with a different initial-schema checksum cannot be upgraded by silently editing the ledger: use a separately reviewed data-preserving migration, or explicitly discard only a disposable synthetic test database and initialize a fresh one. Do not reset a real database to make startup pass.

Run version/syntax/config checks before starting. Confirm schema validation, health readiness and scoped delivery/recovery according to [local validation](docs/local-validation.md). These commands are checks, not proof of completed provider acceptance. The current release does not add an automatic host version-acceptance marker or deployment process.

For rollback, stop the bridge before selecting the previous code version. Reuse the database only if its schema is compatible with that version. Otherwise restore the deliberately captured database and filesystem backup as an operator-controlled procedure; account for already-sent external effects before resuming. Never replay unknown sends or native attempts as a rollback shortcut.

## Source publication

A release commit records version and changes; an annotated `v0.1.0` tag may identify its exact source snapshot once publication is authorized. Public GitHub source, a GitHub release, npm publication and production deployment are separate actions. Keep `private: true`; do not deploy, publish npm packages or claim real-platform acceptance merely because source was pushed.
