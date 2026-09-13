# Changelog

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
