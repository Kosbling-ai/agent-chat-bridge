# Versions and migrations

Application version: `0.2.10`

Version 0.2.10 does not add a database migration.

Version 0.2.9 does not add a database migration.

`VERSION` is the application release version. Keep package.json, both root package-lock versions, README and CHANGELOG aligned; `npm run version:check` and `npm run check` enforce this. Use an explicit stable `MAJOR.MINOR.PATCH` number, with 0.x denoting ongoing initial development. Bump once per delivery batch, not per fix. Once released, do not move its tag or rewrite its versioned history; subsequent fixes get a new release. Documentation-only corrections need no empty migration or release bump.

Application versions, config `schemaVersion` and numbered database migrations are separate contracts. Changing one does not mechanically increment the others. Startup validates the DB migration ledger and checksum; only the explicit migrate command performs DDL. Applied SQL is immutable. After this initial release, schema changes require a new numbered forward migration and corresponding runner support, not edits to 001. MySQL DDL is not transactionally reversible; do not promise an automatic down migration.

## Branch promotion

Development changes are integrated and tested on `staging` before a `staging` to `main` promotion pull request. `main` remains the default branch. Moving source to either branch does not automatically run a migration, deploy an instance, publish npm, create or move a tag, or declare a release. See the [staging workflow](docs/staging-workflow.md).

## 0.2.10 Feishu inbound attachments

Version 0.2.10 adds no database migration. Private inbound attachment metadata and prepared prompts are stored in the existing forward-job execution JSON. Existing configurations may add `feishu.mediaDownloadTimeoutMs`; it defaults to 120000. `feishu.mediaMaxBytes` now defaults to 33554432 and is validated as a hard limit from 1 through 33554432 bytes. Remove the former `feishu.mediaUnsupportedReply` key because strict configuration validation rejects it.

## 0.2.9 writer-lock hotfix

Version 0.2.9 adds no database migration. The writer-lock probe, fail-closed shutdown, and runtime health watchdog change process lifecycle behavior only; they do not alter the database schema.

A schema change must reach `staging` with its immutable forward migration and rollback plan. Apply it only to a dedicated staging database through the explicit migrate command after an authorized backup and writer stop. Promotion to `main` preserves that reviewed migration history; production migration remains a separate, authorized operation.

## 0.2.5 shared-schema bot isolation

Migration `004-bot-connection.sql` adds a required `connection_id` to five assistant runtime tables and places it first in their uniqueness, claim, history and context indexes. It also puts the existing connection first in the bridge job, outbox and recovery claim indexes. Existing `bridge_*` ownership is unchanged; migrations 001–003 and their checksums remain immutable. The configuration schema stays at 1. Each running process still owns one Feishu bot and one Codex executor; multiple processes can use one dedicated bridge database after their storage is scoped by connection.

Stop **all** old bridge writers before migration and keep them stopped until the new version is ready. Back up the bridge database together with its matching workspace/outbox files. For an existing database with any assistant rows, invoke `agent-chat-bridge migrate --config <path> --legacy-connection-id <original-bot-connection-id>` using the original bot's exact connection ID. Do not infer that value from the new bot's config. The separate storage CLI accepts the same optional flag. A completely empty new database can run `migrate --config <path>` without it. The migration refuses missing ownership before 004 DDL, holds the old database-level writer lock, stores the selected ownership for interrupted DDL recovery, and verifies non-null columns and expected indexes before recording ledger version 4. Resume a partial migration with the same explicit legacy ID; a different ID is rejected. A completed 004 is a no-op on rerun.

MySQL DDL commits independently. If migration fails, leave all writers stopped and resolve the cause before resuming with the same legacy ID. Do not delete the scope record or migration ledger to change ownership. Rollback after 004 requires stopping the writers and restoring the pre-migration database and matching workspace/outbox backup; the old binary cannot accept ledger 4. This source change does not authorize migration of a real installation or a provider turn.

## 0.2.4 production runtime defaults

Version 0.2.4 adds no database migration. It restores the 60000 ms app-server idle-close default, controlled `inherit=all` shell policy, production execution-card controller, ordinary post/text replies, Typing lifecycle, private image input and direct attachment delivery. Optional `codex.sharedHome` selects the shared Codex directory and must match an inherited `CODEX_HOME`; configurations may still set `codex.idleCloseMs` to `0` explicitly. Optional `feishu.replyAsPost` defaults to `true`, and `feishu.maxOutputChars` defaults to `3500`.

## 0.2.3 app-server idle lifecycle

Version 0.2.3 adds no database migration. Optional `codex.idleCloseMs` defaults to `0`, which disables automatic idle child close. A nonnegative integer up to 86400000 ms is accepted; explicit service shutdown and crash handling remain active.

## 0.2.2 busy retry policy

Version 0.2.2 adds no database migration. Optional `codex.jobRetryMs` defaults to 60000 and accepts 10000–1800000; `codex.jobMaxAttempts` defaults to 3 and accepts 1–10. Existing configurations may omit both fields.

## 0.2.1 protocol fix

Version 0.2.1 adds no database migration. It corrects the Codex app-server approval-reviewer enum used by new and resumed threads.

## 0.2.0 development migration

Version 0.2.0 is unreleased. Migrations `002-codex-sessions.sql` and `003-forward-runtime.sql` add the Codex binding/event tables and the forward/inbound/message-event tables to a **dedicated bridge schema**. Migration 003 also adds the indexes and source-message receipt field used by exact event reads and API-created runs.

Do not point this build at the Kosbling production/P database and do not treat the similarly named production-derived tables as an in-place conversion. The bridge schema also contains migration 001 communication tables and has its own checksum ledger. For a new development instance, create an empty dedicated schema and run the explicit migrate command. For an existing 0.1.1 bridge trial, stop its only writer, preserve the database and workspace/outbox together, review the new configuration and run the same explicit migration once. Startup itself never applies DDL.

Configuration `schemaVersion` stays 1. Add every authorized group to `routing.groups`. Omitted `capabilities` means `['bridge','hook']`; use `['bridge']`, `['hook']`, or `[]` deliberately. A group listed only in `hooks[].conversationIds` is no longer sufficient. Keep one Feishu bot/WebSocket and one Codex app-server/executor for the instance. Before starting 0.2.6, remove the entire former top-level `auth` block, including an empty `auth` object; strict validation now rejects it. Do not remove `hooks[].tokenEnv`, which still supplies each outbound hook credential. The public `/v1` run, event, resource, recovery, delivery and upload endpoints are removed. No database migration or automatic cleanup of historical API/system rows is performed.

Rollback after applying migrations 002–003 requires stopping the writer and restoring the pre-migration bridge database and matching workspace/outbox, or starting 0.1.1 against a separate compatible schema. Version 0.1.1's strict schema assertion does not accept the later ledger. Do not delete later ledger rows, replay unknown external effects or reuse the Kosbling production database as a rollback shortcut.

No current P instance, production data, credentials or real provider was touched to prepare this migration. The Kosbling business producer keeps its native scheduling, Codex and delivery path and consumes the bridge hook.

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
