# Versions and migrations

Application version: `0.2.2`

`VERSION` is the application release version. Keep package.json, both root package-lock versions, README and CHANGELOG aligned; `npm run version:check` and `npm run check` enforce this. Use an explicit stable `MAJOR.MINOR.PATCH` number, with 0.x denoting ongoing initial development. Bump once per delivery batch, not per fix. Once released, do not move its tag or rewrite its versioned history; subsequent fixes get a new release. Documentation-only corrections need no empty migration or release bump.

Application versions, config `schemaVersion` and numbered database migrations are separate contracts. Changing one does not mechanically increment the others. Startup validates the DB migration ledger and checksum; only the explicit migrate command performs DDL. Applied SQL is immutable. After this initial release, schema changes require a new numbered forward migration and corresponding runner support, not edits to 001. MySQL DDL is not transactionally reversible; do not promise an automatic down migration.

## 0.2.2 busy retry policy

Version 0.2.2 adds no database migration. Optional `codex.jobRetryMs` defaults to 60000 and accepts 10000–1800000; `codex.jobMaxAttempts` defaults to 3 and accepts 1–10. Existing configurations may omit both fields.

## 0.2.1 protocol fix

Version 0.2.1 adds no database migration. It corrects the Codex app-server approval-reviewer enum used by new and resumed threads.

## 0.2.0 development migration

Version 0.2.0 is unreleased. Migrations `002-codex-sessions.sql` and `003-forward-runtime.sql` add the Codex binding/event tables and the forward/inbound/message-event tables to a **dedicated bridge schema**. Migration 003 also adds the indexes and source-message receipt field used by exact event reads and API-created runs.

Do not point this build at the Kosbling production/P database and do not treat the similarly named production-derived tables as an in-place conversion. The bridge schema also contains migration 001 communication tables and has its own checksum ledger. For a new development instance, create an empty dedicated schema and run the explicit migrate command. For an existing 0.1.1 bridge trial, stop its only writer, preserve the database and workspace/outbox together, review the new configuration and run the same explicit migration once. Startup itself never applies DDL.

Configuration `schemaVersion` stays 1. Add every authorized group to `routing.groups`. Omitted `capabilities` means `['bridge','hook']`; use `['bridge']`, `['hook']`, or `[]` deliberately. A group listed only in `hooks[].conversationIds` is no longer sufficient. Keep one Feishu bot/WebSocket and one Codex app-server/executor for the instance. Existing API clients must account for `deliveryMode`, the run execution/delivery split, decimal-string event cursors, controlled resource indexes and `409 unsupported_execution_model` on generation-ledger management writes.

Rollback after applying migrations 002–003 requires stopping the writer and restoring the pre-migration bridge database and matching workspace/outbox, or starting 0.1.1 against a separate compatible schema. Version 0.1.1's strict schema assertion does not accept the later ledger. Do not delete later ledger rows, replay unknown external effects or reuse the Kosbling production database as a rollback shortcut.

No current P instance, production data, credentials or real provider was touched to prepare this migration. The Kosbling business producer still needs a separately reviewed change for scheduled submissions, caller-mode result consumption and hook-triggered lark-cli reads before any production replacement can be considered.

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
