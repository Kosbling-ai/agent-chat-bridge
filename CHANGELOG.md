# Changelog

## [0.1.0] — 2026-09-13

Initial independent Feishu + Codex bridge source release candidate. This entire extraction batch shares one version.

- Explicit configuration, scoped authenticated task/chat APIs and static hooks.
- Durable MySQL inbox/jobs/outbox, session fencing, first-receipt catchup, active-turn guidance and audited recovery.
- Private image input, Agent-produced media delivery, controlled cleanup and resource retirement.
- Idle/rules/archived thread replacement and structured lifecycle/error reporting.

Validation is bounded: earlier isolated MySQL tests used synthetic providers. Latest retirement paging and selected recovery paths still await local integrated validation. No real bot/model acceptance or production replacement is implied. See [local validation](docs/local-validation.md).

Schema migration: initial `001-initial.sql` for a new dedicated database. Configuration schema: 1. No automatic migration of Kosbling business data. License selection remains pending; npm publication is disabled.
