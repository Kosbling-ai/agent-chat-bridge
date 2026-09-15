# Changelog

## [0.2.6] — Unreleased

- Narrow business integration to durable outbound hooks. Remove the public `/v1` run, event, resource, recovery, message-delivery and upload endpoints together with bearer-client configuration and caller-only run policy.
- Preserve the human Feishu bridge path for Codex execution cards, Typing, replies, attachments, stop and fork callbacks, and durable internal recovery. An explicit non-zero Feishu response is a confirmed rejection, while malformed responses, thrown transport errors and timeouts remain unknown and are not automatically resent.
- Remove the obsolete `auth.clients` configuration. Existing configs must delete that block before upgrade; per-hook `hooks[].tokenEnv` remains required. Historical API/system rows and the existing storage schema are not automatically migrated or deleted.

No database migration is added. Validation for this change uses offline fixtures; no real database, Feishu or Codex call was made.

## [0.2.5] — Unreleased

- Extend per-bot card copy to tool-group/count templates, safe tool details and user-input forms. Validated placeholders are rendered without code evaluation; active tool labels hot-load from sanitized metadata. Existing saved tool entries and default output remain compatible.

- Add opt-in `feishu.cardTextFile`: per-instance execution-card text is hot-loaded from a workspace JSON file, with last-valid fallback for invalid edits and scoped editing instructions for Codex. Card actions, delivery and colors are unchanged.

- Migration 004 scopes five assistant runtime tables by `connection_id`, including their uniqueness, recovery and context indexes. It also prefixes bridge claim indexes with the existing connection owner. Existing bridge rows keep their ownership.
- Existing assistant rows require an explicit `--legacy-connection-id` when migrating. The migration records that decision, backfills with a parameterized update, and resumes only with the same value after partial MySQL DDL. An empty new database needs no legacy value.
- Stop every old writer and back up the bridge schema and matching workspace/outbox before applying 004. The migration holds the old database-level writer lock while upgrading. Startup does not run DDL; real-instance upgrade and provider validation remain separate authorized operations.
- Ordinary Feishu and API runs now send one failed occupied-session notice on the first `CODEX_THREAD_BUSY` result, including turn-start unknown outcomes. Trusted system busy queue behavior remains unchanged.
- A busy Feishu failure card can explicitly fork the bound Codex thread with its stored history and switch that conversation to the verified fork. The operation never replays the failed prompt; native or commit uncertainty is recorded without retry and requires durable-state inspection.
- Optionally map supported Codex user-input requests to a separate Feishu form for the current turn. The integration is disabled by default and requires explicit `codex.requestUserInput: true`; the original sender can submit multiple single-choice or free-text answers once, while secret, expired, resolved or disconnected requests are rejected without fabricated answers or RPC replay.

## [0.2.4] — Unreleased

- Restore the frozen production runtime defaults: the launching user's shared Codex home, a 60-second idle child close, and `shell_environment_policy.inherit=all` within the explicitly constructed child environment.
- Add optional `codex.sharedHome`. A configured value and inherited `CODEX_HOME` must resolve to the same directory; explicit `codex.idleCloseMs: 0` remains supported.
- Restore the frozen production execution-card controller and ordinary reply path. Cards use the original create/patch throttle and fall back to chat-created post or text messages; ordinary replies use the original Markdown conversion, output cap and 3000/1900-character chunks.
- Add optional `feishu.replyAsPost` (default `true`) and `feishu.maxOutputChars` (default `3500`). Persisted legacy unconfirmed card/text effects remain held without replay during this transition.
- Restore the frozen production Typing lifecycle, private-chat image preparation, and direct executor attachment delivery. Typing add is awaited before live execution, add failure uses the configured text fallback, and final cleanup is best effort. Successful attachment sends remove their source file; individual failures retain it and do not block the text reply.
- Restore the original single forward/recovery loop and Codex response-waiter handoff. Ordinary transient failures retry at most three times with a 60-second delay, while authenticated system callers may explicitly retain the trusted busy-wait policy.

No database migration is added. Validation uses offline configuration, lifecycle and synthetic child-process fixtures; no real message or model acceptance was run.

## [0.2.3] — Unreleased

- Keep the owned Codex app-server open while the bridge service remains running by default. This removes the 60-second idle child close without adding keepalive traffic or changing native writer-lock behavior.
- Add optional `codex.idleCloseMs`: `0` disables automatic idle close; a positive value retains the bounded idle timer. Explicit service shutdown and unexpected child-exit handling remain unchanged.

No database migration is added. Validation uses synthetic child-process and lifecycle fixtures; no real message or model acceptance was run.

## [0.2.2] — Unreleased

- End a manual Feishu request on its first confirmed pre-admission `CODEX_THREAD_BUSY` result and deliver one explicit occupied-session notice without replacing the binding or replaying the request.
- Retain 60-second waiting only for a validated persisted caller/namespace system binding. Other retryable admission failures remain bounded to three claims by default; configuration enforces the original 10-second retry-delay floor.
- Keep known-turn observation, unconfirmed start and unresolved steer confirmation in `held` with their native/intent identity. Reuse the waiting card and keep Typing off between system probes.
- Preserve sanitized RPC method, stable code, phase and bounded retry facts through the service logger and optional reporter.

No database migration is added. Validation is offline with synthetic app-server, Feishu and clock fixtures; no real message or model acceptance was run.

## [0.2.1] — Unreleased

- Use the Codex app-server protocol value `auto_review` for `approvalsReviewer` on thread start, thread resume and turn start. The previous `auto` value is not part of the current protocol enum and caused an existing binding to fail before native turn admission.
- Classify rejected Codex RPCs with a stable bridge error code and RPC method while keeping provider error text out of logs and persisted public state. A rejected turn-start remains conservatively unconfirmed.

No schema or configuration migration is required. Validation uses a schema-strict synthetic app-server; no real message or model turn is part of this patch's acceptance.

## [0.2.0] — Development snapshot

- Replace the generation worker service path with one leased forward worker backed by the production-derived forward, inbound-message and message-event tables in new migrations 002–003. Persist native start/binding, reply-pending delivery, bounded group context and recovery; a known turn is observed without resubmission and an unknown native outcome is held.
- Run one Feishu bot/WebSocket and one Codex app-server/executor. Keep hook/outbox communication independent from Agent routing. Authorized groups use `capabilities` (`bridge`, `hook`, or both); hook filtering does not depend on Agent mention/member triggers.
- Add `executionNamespace` and `deliveryMode` to idempotent run registration. Caller delivery stores `rawAnswer`, safe progress and controlled attachment resources without automatic cards, Typing or replies. Bridge delivery persists cards, Typing, stop and per-item reply receipts, including explicit unknown outcomes that are not automatically resent.
- Preserve ordinary run/event pagination through a safe public projection. Generation-ledger attempt reads and recovery/reset writes return `409 unsupported_execution_model`; existing recovery records remain readable within their original authorization scope.
- Keep business polling, lark-cli reads, scheduling, message-ID deduplication and specialized cards in the business producer. Bridge hooks remain lightweight event notifications.

This is development metadata, not a tag, published release, deployment, production replacement or completed Kosbling producer migration. Validation uses synthetic providers and a disposable MySQL 8.4 container; no real Feishu or Codex acceptance was run.

Database migrations 002 and 003 target the bridge's own schema. They do not convert or transparently upgrade the Kosbling production/P schema. The configuration schema remains 1, but group authorization now validates optional `capabilities`; review existing hook-only groups before using this version.

## [0.1.1] — 2026-09-13

- Restore final Agent replies and existing input-rejection notices as Feishu JSON 2.0 cards, preserving Markdown, bounded multipart delivery and durable outbox ordering. This does not add dynamic progress cards, stop callbacks or new native-failure notification semantics.
- Add explicit `codex.proxyEnv` references to configure HTTP/SOCKS proxy variables only for the Codex child. Feishu SDK and bridge HTTP requests retain their existing environment.

No database migration or config-schema bump is needed; the proxy mapping is optional. Version 0.1.0 and its tag remain immutable. This batch does not complete the wider production-feature migration or imply production acceptance.

Validation uses targeted offline card/adapter/core/proxy tests and version/syntax checks. A pre-existing media test fails with `finish is not a function` on both the 0.1.0 baseline and the card branch; this batch does not claim a clean full-suite run. Real-platform validation of these changes remains pending.

## [0.1.0] — 2026-09-13

Initial independent Feishu + Codex bridge source release candidate. This entire extraction batch shares one version.

- Explicit configuration, scoped authenticated task/chat APIs and static hooks.
- Durable MySQL inbox/jobs/outbox, session fencing, first-receipt catchup, active-turn guidance and audited recovery.
- Private image input, Agent-produced media delivery, controlled cleanup and resource retirement.
- Idle/rules/archived thread replacement and structured lifecycle/error reporting.

Validation is bounded: earlier isolated MySQL tests used synthetic providers. Latest retirement paging and selected recovery paths still await local integrated validation. No real bot/model acceptance or production replacement is implied. See [local validation](docs/local-validation.md).

Schema migration: initial `001-initial.sql` for a new dedicated database. Configuration schema: 1. No automatic migration of Kosbling business data. License selection remains pending; npm publication is disabled.
