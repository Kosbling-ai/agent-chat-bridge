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

Private messages require actor.openId in privateUserIds. Group routing requires an explicit group, then either mention or all trigger. All human group members are admitted by default; optional group.userIds narrows membership only when explicitly configured (an empty list admits none). Hook conversation scopes remain independent from Agent user/group admission. Self/app messages are excluded from Agent and hook routing. Passive context is an explicit group policy, independent from hooks, and only contains admitted human messages not triggering Agent. The first routing snapshot is preserved on duplicate input. Recall tombstones exclude passive context even when recall arrives first; recalls never launch another model turn.

Inbox and independent agent/hook jobs commit before the Feishu handler resolves. Agent work persists an attempt before native RPC; thread/turn binding uses lease/generation fencing. Native notifications are buffered durably before admission bookkeeping, then associated by thread/turn. Random receive keys preserve repeated deltas as distinct receipts; they are not semantic deduplication keys. Terminal effects use stable per-run outbox keys and fenced atomic completion. A known admitted turn can recover by thread/read; graceful shutdown keeps that attempt pending for recovery rather than classifying its admission as unknown. A missing native admission ID becomes status=unknown, locks the session and is never replayed automatically. GET run exposes that state. There is currently no operator recovery mutation for an unknown session; production migration must supply a reviewed recovery workflow before relying on it.

Same-conversation work is **durably deferred** and later resumes the shared native thread. This stage does not steer an active turn. Reset requires admin plus conversation authorization and exact generation, and rejects active/unknown runs. Passive context reads are bounded to 100 rows per turn. Recalls do not retroactively cancel Agent jobs, matching the old runtime. History catch-up is being restored only for missing first receipts, not as a public edit stream.

RPC failures are classified by phase: an explicit refusal of this run's thread/turn admission may fail the run and release its session. A rejected native read, including the final item read after a terminal notification, cannot prove that an admitted turn failed. The known attempt remains pending for reconciliation with its session binding intact; successful later reads finish delivery without a new turn/start.

Hook subscriptions are static `{id,url,tokenEnv,conversationIds}`. Each delivery is `{deliveryId,event}`, with `Idempotency-Key: deliveryId`. The consumer must durably accept/deduplicate before returning **204**. This acknowledges durable receipt, not completion of business processing. Redirects are forbidden, requests time out after 3 seconds, bodies are cancelled immediately, and delivery retries stop after 8 attempts. Hook failure never recreates Agent output. Business message/history/member/resource queries and document/Base APIs remain outside this service. Existing business SDK/REST readers stay in the business process; no forced lark-cli rewrite.

## Authenticated HTTP APIs

All `/v1/` operations require `Authorization: Bearer <token>`. Run/delivery reads check stored connection and conversation ownership. Reply/reaction writes verify platform message membership internally before registration. No caller-provided actor or connection/workspace overrides are accepted.

| Endpoint | Contract |
| --- | --- |
| POST /v1/runs | `{conversationId,idempotencyKey,text}` → 202 `{id,duplicate}`; text <=64 KiB UTF-8; JSON body <=512 KiB including escaping |
| GET /v1/runs/:id | durable status/result/errorCode/timestamps |
| GET /v1/runs/:id/events | `after` sequence, `limit` 1–100; read-only |
| POST /v1/deliveries | common `{conversationId,idempotencyKey,kind,...}` → 202; see below |
| GET /v1/deliveries/:id | durable delivery status/result/errorCode |
| POST /v1/sessions/reset | `{conversationId,generation}`; admin required; busy/conflict=409 |

Delivery kinds: create/reply accept `messageKind=text|post|interactive|image|file` and platform content object; text also accepts a string. Reply requires messageId belonging to the same authorized conversation. Reaction accepts messageId plus emojiType to add or reactionId to remove. Upload accepts mediaType=image|file and base64; file requires fileName. Upload is capped at 2 MiB and persists bytes in the independent Store; use a subsequent authorized image/file delivery with the returned key. These are separate effects, not one fake atomic send. Content is capped at 20 KB; unsupported operations return 422. Inline source paths are never accepted.

Create/reply retries preserve platform UUID within the Store's conservative 55-minute window. Multipart replies have durable predecessor links: the next piece is eligible only after the previous piece is confirmed sent, including after restart. A failed predecessor blocks later pieces and makes the run delivery_failed; it does not make the model eligible to rerun. Unknown upload/reaction effects are held for reconciliation, never automatically repeated. Unknown result and failed result are distinct API states.

## Capability matrix and remaining work

| Capability | This stage |
| --- | --- |
| Inbound text → Codex → text reply | implemented; real Store + synthetic providers tested |
| Inbound private image/post → Agent | internal image download and textual path prompt; durable job before prepare, known attempt recovery skips downloads |
| Inbound group post / private file/audio/media | group captions only; originally unsupported private binary types retain explicit rejection |
| Outbound text/post/interactive/image/file | durable create/reply API wired to adapter; platform acceptance not live tested |
| Reaction add/remove | Write API + adapter wired; unknown writes held |
| Upload image/file | bounded durable API wired; unknown upload held |
| Internal resource/history reads | Agent media and catch-up only; business reads remain outside the public bridge API |
| Business edit/reconcile and recall cancellation | Business edit/reconcile remains outside bridge; old recall did not cancel execution |
| Reconnect catch-up | service starts internal first-receipt gap recovery by default; `feishu.catchup:false` disables it |
| Active steer | deferred-only now; migration must assess behavior difference |
| Automatic unknown-admission recovery without native ID | explicitly unavailable; operator workflow required |

This matrix is a staging boundary, not a declaration that existing required media/chat behavior may be removed. The missing existing capabilities remain follow-up work before production replacement. File input was unsupported in the old bridge; cancelling Codex on recall was not old behavior and is not an implied migration requirement.

## Observability and tests

Logs contain fixed module/component/operation/status/code/duration fields and no raw payload/SDK errors. Optional errorReporting `{url,tokenEnv}` forwards terminal structured error events to a trusted HTTP endpoint with a 2-second deadline and at most four concurrent requests. Failed/full reporting emits warning without recursion; response bodies are cancelled and redirects rejected. Without this option only structured logs are emitted; configure a production error collector before deployment.

Run `npm test`, `npm run check`, and `node scripts/test-storage.mjs test/core.integration.test.mjs`. The latter creates disposable local MySQL and injects synthetic credentials. It does not contact a real bot/model. Core coverage includes early terminal notifications, duplicate input, independent hooks, authorization, unknown admission no-replay, reset busy rejection and recovery of an already-completed native turn.

## Receive-gap catchup integration

Service starts catchup after native/WS startup and stops it before workers/Store teardown. It combines configured Agent groups and explicitly declared hook `catchupGroupIds` with keyset-paged previously received private chats, with a hard 1000-conversation bound. Hook `catchupGroupIds` defaults to an empty list and must be a subset of its `conversationIds`. An arbitrary hook target never implies group type; previously received private chats are discovered through Store. Conflicting explicit group and observed private types reject catchup rather than poison canonical receipts. No bot-wide chat enumeration or public read API is exposed. Default private lookback/overlap remains three hours/five minutes.

Live/history canonical first receipt is atomic in Store. Changed history content never fabricates an edit hook. If a history sender lacks the open ID needed for private/group-member admission, or mention IDs cannot identify the configured bot, core rejects before canonical registration. The page checkpoint remains retryable so incomplete history cannot suppress a later complete live event. Groups allowing all members do not require open IDs merely for membership. SDK 1.60.0 message.list has no user_id_type parameter; this safeguard does not guess or translate identities.

## Agent input media lifecycle

The service constructs the internal Feishu image preparer under the configured Codex workspace at `.agent-chat-bridge/inbox`. `feishu.mediaBudgetBytes` defaults to 128 MiB (20 MiB to 1 GiB allowed); individual files remain capped at 20 MiB. No HTTP caller supplies an input path.

Ingress only persists authorized jobs. The worker prepares private image/post inputs before its first native attempt, renews its lease before admission, and adds validated local paths using the existing textual prompt format. Existing native attempts skip preparation during recovery. Text and group post captions use the legacy text extractor; group images are ignored. Failed downloads and unsupported private types produce explicit durable result facts/replies without native execution. Interrupted preparation returns the unadmitted job to pending.

Input resources survive completed turns and restarts. Core does not invoke release until a later retirement workflow can prove there are no native recovery references; there is no age-based deletion. The budget therefore fails explicitly when retained resources fill it. Automatic Agent output upload/send is a separate integration and is not implied by input preparation.
