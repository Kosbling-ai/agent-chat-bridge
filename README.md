# agent-chat-bridge

[简体中文](README.zh-CN.md)

Version: `0.2.17` is the current unreleased development version. Version 0.1.1 is the previous implementation. [Changes](CHANGELOG.md), [version and migration policy](MIGRATIONS.md), [staging workflow](docs/staging-workflow.md).

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

```sh
npm test
npm run check
node scripts/test-storage.mjs test/core.integration.test.mjs
```

npm publishing remains disabled (`private: true`). The intended public source repository is [Kosbling-ai/agent-chat-bridge](https://github.com/Kosbling-ai/agent-chat-bridge); creating and pushing it is separate from deployment or platform acceptance. No production replacement has been performed. Licensing is pending: public visibility does not itself grant an open-source license. See [source provenance](docs/provenance.md).

### Custom execution-card text

See [per-bot card text](docs/card-text.md) for opt-in, hot-loaded wording that each bot can edit in its workspace.
