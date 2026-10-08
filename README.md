# agent-chat-bridge

[简体中文](README.zh-CN.md)

Version: `0.2.24` adds bounded recovery for uncertain queue-claim commits without replaying business execution. No schema/config migration.

Version `0.2.23` is the current unreleased development version. 0.2.23 adds the optional card text key `commandTitleTemplate` (placeholders `{name}`, `{label}`; default `{name}`, so output is unchanged) to retitle execution-card command lines that show only a program name, for example `{label}` for 「执行命令」; no migration. 0.2.22 compacts the execution card: the answer (or latest progress while running) and status stay visible and the process folds into at most one collapsed, non-nested panel; no card text key was removed (one optional key, `processGroup`, was added) and stored state is unchanged. See [the execution-card layout](docs/runtime.md). 0.2.21 adds the optional per-group `routing.groups[].codex` permission override (`approvalPolicy`, `approvalsReviewer`, `sandbox`) for a `bridge` group's human thread and for business-event threads whose hook `inbound.defaultChatId` is that group; Codex full access needs `approvalPolicy: "never"` with `sandbox: "danger-full-access"`. See [per-group Codex permissions](docs/runtime.md#per-group-codex-permissions). Version 0.1.1 is the previous implementation. [Changes](CHANGELOG.md), [version and migration policy](MIGRATIONS.md), [staging workflow](docs/staging-workflow.md).

Independent Feishu + Codex bridge process. Business code, Skills/MCP and document/table APIs stay in the Agent environment or hook consumer.

Version 0.2.5 adds migration 004 for multiple bot processes sharing one dedicated bridge MySQL schema. Existing assistant rows need an explicit original `connection_id` at migration time; see [upgrade instructions](MIGRATIONS.md).

It can also map supported Codex user-input requests to a separate Feishu question card for the current turn. This integration is disabled by default; set `codex.requestUserInput` to `true` to opt in. The original sender can submit multiple single-choice or free-text answers; secret questions are rejected, and expired or disconnected requests cannot be resumed.

The runtime assembles an independent MySQL schema, one Codex app-server/executor, one Feishu bot and WebSocket owner, and scoped hooks. Version 0.2.10 adds the authenticated Events API for configured business hooks; the bridge still exposes no public run, resource, upload or message-delivery API. It includes the production-derived forward lease, reply-pending delivery, bounded recovery, group context, execution card, Typing, stop callback and replies for human Feishu conversations. Business systems keep their own native SDK, scheduling and delivery paths. The runtime also uses the Codex app-server's `auto_review` approval-reviewer enum for new and resumed threads. See the [forward runtime contract](docs/runtime.md) and [Chinese supplement](docs/zh-CN/forward-runtime.md).

Synthetic tests, a disposable MySQL container, and offline implementation review cover the new runtime and storage paths. No real bot/model acceptance, deployment, business-producer adaptation, or production replacement has been completed.

Requires Node.js 24.x, npm and MySQL 8.4. Dependencies are pinned in package-lock.json. No real provider or business database is used by default tests.

```sh
npm ci
node bin/agent-chat-bridge.mjs --help
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
```

Configure explicit environment references and an owned workspace before migration/start. Never put tokens in JSON, `.env`, logs or source control. [Runtime configuration](docs/runtime.md), [Store](docs/storage.md), [Codex executor](docs/codex-adapter.md), [optional Codex proxy](docs/codex-proxy.md), [optional Feishu proxy](docs/feishu-proxy.md), [boundaries](docs/boundaries.md).

For an Agent reply that needs to notify someone, write `<at user_id="ou_example1"></at>`, `<at open_id="ou_example1"></at>`, or `@{ou_example1}` in the answer. The bridge sends each valid open_id (`ou_` followed by lowercase letters or digits) as a Feishu post `at` element, including when `feishu.replyAsPost` is `false`. Invalid IDs remain literal text. To let a specific group use `<at user_id="all"></at>`, set `allowMentionAll: true` on that group's `routing.groups[]` entry; the default is `false`, and private chats cannot use it. Interactive cards are unchanged.

The original config.example.json remains a health-only configuration: live=200, ready=503. A complete runtime configuration reports readiness from actual components. Live never means provider readiness.

For an authorized group, set `routing.groups[].replyTriggers` to `true` to trigger the Agent when a human replies to a message from this bot without `@` (default `false`). Text and cards both qualify; `trigger: "all"` remains unchanged. See [routing and reply context](docs/runtime.md).

`GET /health/tasks?window_minutes=120` has the same access conditions as `/health/ready` and reads only this process's configured `connection_id`. The integer window is 5–1440 minutes (default 120); invalid values return 400 `invalid_window_minutes`. It includes failed chat (`bridge`) and business-event (`caller`) jobs whose `finished_at` falls in the window. A failed job with code `CODEX_TURN_INTERRUPTED` is counted only in `interrupted.total`; deferred jobs are excluded. At most the 500 most recently finished jobs are counted, with `failed.truncated=true` if more match. Codes outside `[A-Z0-9_]{1,64}` become `OTHER`; at most 10 code entries are returned in descending count order, with remaining codes folded into `OTHER`. Storage failure returns 503 `task_health_unavailable` rather than zero counts. The response contains no prompts, message bodies, sender or group identifiers, or raw error text.

Example response:

```json
{"window_minutes":120,"checked_at":1790000000000,"failed":{"total":3,"truncated":false,"latest_finished_at":1789999000000,"by_code":[{"code":"CODEX_USAGE_LIMIT_EXCEEDED","count":2},{"code":"OTHER","count":1}],"by_mode":{"bridge":1,"caller":2}},"interrupted":{"total":0}}
```

Runtime health notifications still first fire after a persistent issue has lasted 30 minutes. Failed jobs do not automatically retry when quota returns. A failure remains visible until it leaves the selected window, which does not imply quota is still exhausted.

```sh
npm test
npm run check
node scripts/test-storage.mjs test/core.integration.test.mjs
```

npm publishing remains disabled (`private: true`). The intended public source repository is [Kosbling-ai/agent-chat-bridge](https://github.com/Kosbling-ai/agent-chat-bridge); creating and pushing it is separate from deployment or platform acceptance. No production replacement has been performed. Licensing is pending: public visibility does not itself grant an open-source license. See [source provenance](docs/provenance.md).

### Silent-reply sentinel

An Agent can signal that a group turn needs no answer by replying with an operator-configured sentinel. Set `routing.silentReply` (defaults for every `bridge` group) and/or `routing.groups[].silentReply` (per-group override, field by field):

```json
{ "routing": { "silentReply": { "tokens": ["NO_REPLY"], "card": "delete" } } }
```

`tokens` defaults to `[]` (feature off) and `card` to `"delete"`. When a completed Agent answer, trimmed of surrounding whitespace, exactly equals a token (case-sensitive; no prefix or substring matching), the bridge sends no text reply. `card: "delete"` recalls the execution card and falls back to `"complete"` if the recall fails (Feishu allows recalling only the bot's own messages within 24 hours); `"complete"` closes the card as completed with the neutral card text `silentReply` (default `已处理，无需回复。`). The sentinel is never displayed. The job finishes as `completed` with `result.silentReply.status = "silent"`; a card that can be neither recalled nor patched is retried within `codex.jobMaxAttempts`. Private chats, failed or deferred turns and non-matching answers are unchanged; outbox attachments are still delivered. The bridge does not tell the Agent the tokens: put the convention, with the same literal value, into the group instructions or workspace rules. Recalls of the bot's own messages are no longer delivered to hooks. See [upgrade and rollback notes](MIGRATIONS.md).

### Custom execution-card text

See [per-bot card text](docs/card-text.md) for opt-in, hot-loaded wording that each bot can edit in its workspace.
