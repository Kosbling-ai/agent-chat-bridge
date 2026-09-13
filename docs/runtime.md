# Runtime and API

This stage assembles an independent Feishu + Codex process and MySQL Store. It is locally validated with synthetic provider protocols and an isolated real MySQL database. It has not been validated against a real bot/model and is not yet the complete migration of the old application's chat features.

## Start and configuration

Use `examples/bridge.json` as a shape example. Replace IDs and executable/workspace paths; paths are relative to the config file. `codex.bin` is an explicit file path, not PATH lookup. The workspace must be owned by the runtime UID; neither workspace nor executable can be world writable. Constructor policy is fixed to approvalPolicy=never and sandbox=workspace-write; HTTP callers cannot override these settings or cwd. Only environment names listed in codex.envNames are copied into the child. Choosing HOME/CODEX_HOME gives Codex access to that explicit native environment; operators are responsible for assigning an appropriately restricted Agent workspace/account.

Secrets are resolved from explicitly named environment variables only at start/migrate, never from `.env` or repository credentials. `check-config` validates shape without resolving them. API tokens must have at least 24 characters and be distinct. Every client has an explicit conversation list and admin boolean; there is no wildcard or default full access. Health remains public and contains fixed component states.

```sh
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs migrate --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs start --config ./examples/bridge.json
```

Migration is explicit and should use the deployment's controlled migration credentials; start only checks schema and acquires a single-writer lock. A config containing only schemaVersion/listen retains health-only operation with ready=503. A partial provider configuration is rejected. The legacy health-only auth.tokenEnv placeholder does not grant API access.

`/health/ready` requires Store schema and writer health, Codex handshake, actual Feishu socket OPEN, and running workers. `/health/live` only checks the HTTP process. SIGTERM/SIGINT stop HTTP admission, stop Feishu ingress, drain workers, close Codex, close Store and error reporting. Unknown work stays durable. The CLI explicitly exits after cleanup because the locked Feishu SDK retains a cache interval; embedders must account for that SDK limitation.

## Routing and execution

Private messages require actor.openId in privateUserIds. Group routing requires an explicit group and allowed userIds, then either mention or all trigger. Self/app messages are excluded from Agent and hook routing. Passive context is an explicit group policy, independent from hooks, and only contains admitted human messages not triggering Agent. The first routing snapshot is preserved on duplicate input. Recall tombstones exclude passive context even when recall arrives first; recalls never launch another model turn.

Inbox and independent agent/hook jobs commit before the Feishu handler resolves. Agent work persists an attempt before native RPC; thread/turn binding uses lease/generation fencing. Native notifications are buffered durably before admission bookkeeping, then associated by thread/turn. Random receive keys preserve repeated deltas as distinct receipts; they are not semantic deduplication keys. Terminal effects use stable per-run outbox keys and fenced atomic completion. A known admitted turn can recover by thread/read; a missing native admission ID becomes status=unknown, locks the session and is never replayed automatically. GET run exposes that state. There is currently no operator recovery mutation for an unknown session; production migration must supply a reviewed recovery workflow before relying on it.

Same-conversation work is **durably deferred** and later resumes the shared native thread. This stage does not steer an active turn. Reset requires admin plus conversation authorization and exact generation, and rejects active/unknown runs. Passive context reads are bounded to 100 rows per turn. Active task cancellation on message recall and history catch-up have not been wired; recalled pending Agent jobs are not retroactively cancelled.

Hook subscriptions are static `{id,url,tokenEnv,conversationIds}`. Each delivery is `{deliveryId,event}`, with `Idempotency-Key: deliveryId`. The consumer must durably accept/deduplicate before returning **204**. This acknowledges durable receipt, not completion of business processing. Redirects are forbidden, requests time out after 3 seconds, bodies are cancelled immediately, and delivery retries stop after 8 attempts. Hook failure never recreates Agent output. Business document/Base APIs remain outside this service.

## Authenticated HTTP APIs

All `/v1/` operations require `Authorization: Bearer <token>`. Run/delivery reads check stored connection and conversation ownership. Message/resource reads verify platform message membership before returning content. No caller-provided actor or connection/workspace overrides are accepted.

| Endpoint | Contract |
| --- | --- |
| POST /v1/runs | `{conversationId,idempotencyKey,text}` → 202 `{id,duplicate}`; text <=2048 chars |
| GET /v1/runs/:id | durable status/result/errorCode/timestamps |
| GET /v1/runs/:id/events | `after` sequence, `limit` 1–100; read-only |
| POST /v1/deliveries | common `{conversationId,idempotencyKey,kind,...}` → 202; see below |
| GET /v1/deliveries/:id | durable delivery status/result/errorCode |
| POST /v1/sessions/reset | `{conversationId,generation}`; admin required; busy/conflict=409 |
| GET /v1/conversations/:id/messages | bounded platform page, `limit` and `pageToken` |
| GET /v1/conversations/:id/members | same pagination, no global contacts |
| GET /v1/messages/:id | verify message chat membership before returning |
| GET /v1/messages/:id/reactions | bounded platform reaction page |
| GET /v1/messages/:id/resources | `fileKey`, `type=image\|file`; authorized streaming attachment |

Delivery kinds: create/reply accept `messageKind=text|post|interactive|image|file` and platform content object; text also accepts a string. Reply requires messageId belonging to the same authorized conversation. Reaction accepts messageId plus emojiType to add or reactionId to remove. Upload accepts mediaType=image|file and base64; file requires fileName. Upload is capped at 2 MiB and persists bytes in the independent Store; use a subsequent authorized image/file delivery with the returned key. These are separate effects, not one fake atomic send. Content is capped at 20 KB; unsupported operations return 422. Inline source paths are never accepted.

Create/reply retries preserve platform UUID within the Store's conservative 55-minute window. Unknown upload/reaction effects are held for reconciliation, never automatically repeated. A completed model task is never rerun to repair delivery. Unknown result and failed result are distinct API states.

## Capability matrix and remaining work

| Capability | This stage |
| --- | --- |
| Inbound text → Codex → text reply | implemented; real Store + synthetic providers tested |
| Inbound post/image/file → Agent | explicit durable unsupported result and text notice; media ingestion still required before full migration |
| Outbound text/post/interactive/image/file | durable create/reply API wired to adapter; platform acceptance not live tested |
| Reaction add/remove/list | API + adapter wired; unknown writes held |
| Upload image/file | bounded durable API wired; unknown upload held |
| Download resources/history/member reads | authorized adapter API wired |
| Edit events, card actions, revoke pending execution, reconnect catch-up | not implemented in this stage |
| Active steer | deferred-only now; migration must assess behavior difference |
| Automatic unknown-admission recovery without native ID | explicitly unavailable; operator workflow required |

This matrix is a staging boundary, not a declaration that existing required media/chat behavior may be removed. The missing existing capabilities remain follow-up work before production replacement.

## Observability and tests

Logs contain fixed module/component/operation/status/code/duration fields and no raw payload/SDK errors. Optional errorReporting `{url,tokenEnv}` forwards terminal structured error events to a trusted HTTP endpoint with a 2-second deadline and at most four concurrent requests. Failed/full reporting emits warning without recursion; response bodies are cancelled and redirects rejected. Without this option only structured logs are emitted; configure a production error collector before deployment.

Run `npm test`, `npm run check`, and `node scripts/test-storage.mjs test/core.integration.test.mjs`. The latter creates disposable local MySQL and injects synthetic credentials. It does not contact a real bot/model. Core coverage includes early terminal notifications, duplicate input, independent hooks, authorization, unknown admission no-replay, reset busy rejection and recovery of an already-completed native turn.
