# agent-chat-bridge

[English](README.md) | [简体中文](README.zh-CN.md)

Version: `0.1.0` — initial development release. [Changes](CHANGELOG.md), [version and migration policy](MIGRATIONS.md).

Independent Feishu + Codex bridge process. Business code, Skills/MCP and document/table APIs stay in the Agent environment or hook consumer.

The runtime assembles MySQL, Codex app-server, one Feishu WebSocket owner, scoped hooks and authenticated task/chat APIs. It implements private image input, Agent-generated file delivery, first-receipt catchup, durable active-turn guidance, audited recovery, idle/rules/archived thread replacement and sealed resource retirement. Business edit/reconcile and document/table/contact tools remain outside the bridge. See the [capability matrix and boundaries](docs/runtime.md).

Earlier isolated-MySQL tests used synthetic providers. The latest retirement/cursor and error-only recovery changes have fast unit and source-check coverage; their integrated paths await the requested later local testing. No real bot/model acceptance or production replacement has been completed. The [local validation checklist](docs/local-validation.md) records what remains, including deliberate differences from the old predecessor/orphan interruption behavior.

Requires Node.js 24.x, npm and MySQL 8.4. Dependencies are pinned in package-lock.json. No real provider or business database is used by default tests.

```sh
npm ci
node bin/agent-chat-bridge.mjs --help
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
```

Configure explicit environment references and an owned workspace before migration/start. Never put tokens in JSON, `.env`, logs or source control. [Runtime configuration and API](docs/runtime.md), [Store](docs/storage.md), [Codex adapter](docs/codex-adapter.md), [boundaries](docs/boundaries.md).

The original config.example.json remains a health-only configuration: live=200, ready=503. A complete runtime configuration reports readiness from actual components. Live never means provider readiness.

```sh
npm test
npm run check
node scripts/test-storage.mjs test/core.integration.test.mjs
```

npm publishing remains disabled (`private: true`). The intended public source repository is [Kosbling-ai/agent-chat-bridge](https://github.com/Kosbling-ai/agent-chat-bridge); creating and pushing it is separate from deployment or platform acceptance. No production replacement has been performed. Licensing is pending: public visibility does not itself grant an open-source license. See [source provenance](docs/provenance.md).
