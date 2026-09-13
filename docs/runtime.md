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

Inbox and independent agent/hook jobs commit before the Feishu handler resolves. Agent work persists an attempt before native RPC; thread/turn binding uses lease/generation fencing. Native notifications are buffered durably before admission bookkeeping, then associated by thread/turn. Random receive keys preserve repeated deltas as distinct receipts; they are not semantic deduplication keys. Terminal effects use stable per-run outbox keys and fenced atomic completion. A known admitted turn can recover by thread/read; graceful shutdown keeps that attempt pending for recovery rather than classifying its admission as unknown. A missing native admission ID becomes status=unknown, locks the session and is never replayed automatically. GET run exposes that state. Trusted admins can register audited adopt_turn/abandon_verified actions through the controlled recovery API described below; there is no automatic replay.

Same-conversation work uses a durable steering intent when a known active native turn is available. Explicitly rejected or not-yet-steerable guidance is durably deferred and later resumes the shared native thread. Reset requires admin plus conversation authorization and exact generation, and rejects active/unknown runs. Passive context reads are bounded to 100 rows per turn. Recalls do not retroactively cancel Agent jobs, matching the old runtime. History catchup runs only for missing first receipts; it does not expose a public edit stream.

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
| Private Agent-generated files | snapshot → upload → predecessor-confirmed send → durable cleanup; unknown upload held |
| Reaction add/remove | Write API + adapter wired; unknown writes held |
| Upload image/file | bounded durable API wired; unknown upload held |
| Internal resource/history reads | Agent media and catch-up only; business reads remain outside the public bridge API |
| Business edit/reconcile and recall cancellation | Business edit/reconcile remains outside bridge; old recall did not cancel execution |
| Reconnect catch-up | service starts internal first-receipt gap recovery by default; `feishu.catchup:false` disables it |
| Active steer | durable single-parent intent; accepted guidance shares parent result, explicit rejection defers, unknown held |
| Unknown admission without native ID | no automatic replay; scoped admin recovery API supports audited adopt or verified abandon |

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

Input resources survive completed turns and restarts. Core does not invoke release until a later retirement workflow can prove there are no native recovery references; there is no age-based deletion. The budget therefore fails explicitly when retained resources fill it. Automatic Agent output upload/send is wired through the separate durable output lifecycle below.

## Final answer projection

Normal completion and restart recovery replay the same persisted assistant projection. Supported shapes are `agentMessage.text`, explicit assistant `message.text` or content strings/text/input_text/output_text, the two agent-message delta methods, completed items, and terminal item arrays. User, tool, reasoning and unknown-role message content never becomes reply fallback. Terminal explicit final answers take precedence; otherwise durable final answers survive later commentary, then terminal/stream assistant text is used. The last two rules deliberately correct the old fallback's commentary overwrite and unknown-role-as-assistant behavior.

Delta accumulation keeps the previous 12,000-character tail, with at most 128 active item accumulators. Native replay is turn-filtered, paged by durable receipt sequence and capped at 100,000 events. If replay cannot reach the end within the bound, the run remains recoverable instead of committing a partial reply. Frozen production projection/extraction functions are replayed with identical event sequences in `test/core-answer.test.mjs`; explicit old/new divergences have separate assertions.

## Controlled unknown-admission recovery

Admin clients with the target conversation scope can GET `/v1/runs/:id/attempt` and POST `/v1/recoveries` with `{runId,idempotencyKey,generation,action,evidence,nativeThreadId?,nativeTurnId?}`. Evidence is required, at most 4096 characters, and kept only in Store audit. POST returns 202 after registration; GET `/v1/recoveries/:id` exposes action/status/error facts without evidence. Non-admin and foreign-conversation clients are rejected. Conflicts return 409.

Only unknown original runs qualify. `adopt_turn` requires explicit native thread/turn IDs: the worker reads the thread, verifies its configured workspace and turn existence/status, then the Store atomically enforces generation/active run and permanent thread ownership. The original run becomes pending for read recovery, never turn/start. `abandon_verified` requires the administrator's explicit reconciliation statement; a known thread is read and any active/indeterminate turn rejects abandonment. Missing native IDs may be abandoned from that explicit statement, cancelling the original run and releasing its generation without creating a replacement job. There is no force-retry endpoint and no native interrupt side effect.

Provider read rejection leaves the administrative action leased for later read-only retry; it does not imply execution rejection. A lost application COMMIT response is reconciled through the persisted action state. Unconfirmed application is reported without converting it into a contradictory rejection. Fixed error codes/logs never include native error payloads or audit evidence.

`node scripts/test-storage.mjs test/core-recovery.integration.test.mjs` verifies real Store registration, authorization, successful adoption/abandonment, active-turn refusal, workspace checks, ownership conflicts, idempotence and zero new native admissions. Synthetic protocol tests cover rejected reads and lost COMMIT responses. No real provider or administrative action against production was executed.

## Private Agent output delivery

Service creates disjoint workspace directories `.agent-chat-bridge/outbox` and `.agent-chat-bridge/outbound-spool`; the former supplies each new private thread's output prompt. After completion, core scans using the persisted original native attempt time, snapshots up to nine selected files, and commits text plus separate upload/send effects atomically. Group output stays text-only. Preparation failures and omitted counts remain in the run result and an explicit text notice; successful text does not imply every file succeeded.

An artifact send can only read a confirmed upload predecessor result. The 55-minute same-UUID send retry policy applies to artifact_send; unknown artifact_upload never retries automatically. File uploads preserve the old 28 MiB cap, with an internal 32 MiB HTTP bound for multipart overhead and the separate image 10 MiB limit. `feishu.outputBudgetBytes` defaults to 512 MiB and accepts 28 MiB through 1 GiB. The public upload endpoint remains separately bounded at 2 MiB and never accepts internal artifact references or paths.

A confirmed artifact send atomically sets cleanup_pending. A bounded sweep retries filesystem cleanup and clears the flag only on success; restart cleanup cannot resend or rerun the Agent. Source modifications are retained by the module's identity/hash checks. Unknown uploads/sends keep their snapshots and source files, and remain observable through blocked delivery facts. There is no age-based deletion.

`node scripts/test-storage.mjs test/core-outbound.integration.test.mjs` uses real MySQL, local 3 MiB PDF bytes and synthetic model/chat callbacks to prove upload predecessor gating, actual key-based send, cleanup failure/restart without duplicate execution, and held unknown upload. It does not contact a provider.

Platform execution and outbox settlement have separate error boundaries. A lost sent COMMIT response is read back through getOutbox; a confirmed sent fact is retained and cleanup can proceed. A stale/conflicting settlement is never relabeled as a platform unknown, and unrelated workers continue. `test/core-delivery.integration.test.mjs` injects real committed-response loss for text, upload and artifact upload/send, plus a settled failed effect, and verifies no reverse settlement, duplicate call or worker shutdown.

## Idle and rules retirement

`codex.rolloverIdleMs` defaults to two days (0 disables idle retirement). `rolloverOnRulesUpdate` defaults true and `rulesFiles` defaults to `["AGENTS.md"]`; at most 20 relative workspace files may be configured. Kosbling-specific rule locations are not embedded. Missing files are ignored. The original native second/millisecond normalization and one-second rule-update margin are retained.

Before a new attempt, core reads the existing inactive binding and checks native turns before retirement. Existing durable attempts and active sessions never rotate. Idle retirement compares the previous confirmed input timestamp with an atomic expectedLastMessageAt check; successful bind/adopt records the original attempt time, while polling/recovery does not refresh it. Rules retirement takes precedence, as before. Provider/metadata inspection failures leave the unadmitted job pending with a sanitized warning rather than discarding a possibly active thread.

Retirement increments generation and records the former native thread, preserving permanent conversation ownership. It never archives/deletes the native thread. A retired input-resource directory is still retained until no pending/unknown native reference can use it; this stage does not guess a release from file age. A full input budget therefore rejects new preparation explicitly. A proven, identity-matched archived refusal from thread/resume before turn admission uses an atomic active-attempt reset. Only its fresh acknowledgement permits one replacement thread/start; a lost reset response or unknown replacement result retains unknown state for reconciliation. Replaying the reset never grants a second start. Read-side explicit archived refusal can also retire an inactive binding.

## Durable active-turn guidance

`codex.steering` defaults true; false keeps new work in the deferred queue while still reconciling any earlier unresolved steering intent. Before turn/steer, Store records the guidance job, target run/generation/thread/turn and stable client message ID. Only a new intent causes an RPC. At most one unresolved guidance request targets a parent run at a time. A pending/unknown native parent without a known actionable turn is never guessed into an RPC target.

Accepted guidance finishes its own bookkeeping with `{deferred:true,targetRunId,nativeTurnId}` and produces no second reply; the parent final answer remains authoritative. A parent may complete before the steer response without losing the accepted fact. Explicit rejection defers the guidance and never sends it to the same target twice. Unknown responses or a recovered unresolved intent become unknown guidance, never a repeated steer or automatic new turn. Parent state is preserved. Active-turn mismatch does not trigger the old speculative native interruption.

Admin GET `/v1/runs/:id/attempt` returns native and steering attempt facts. Unknown guidance is distinct from unknown native admission; native adopt/abandon does not apply to it. Admin POST `/v1/recoveries` with `action: "abandon_guidance_verified"`, runId, generation, idempotencyKey and bounded evidence cancels only an unknown guidance job after explicit operator reconciliation. It makes no provider call, does not alter the parent or session, and retains the original unknown steering fact. No native IDs are accepted for this action. The retained uncertainty still prevents another steer to that same active parent; after the parent ends, new work proceeds normally. This is not force retry or a claim that the provider never received the guidance.

`test/core-steering.integration.test.mjs` verifies real Store serialization, parent completion before steer acknowledgement, one shared reply, rejected guidance deferred to the next turn, and unknown guidance not replayed after restart. Offline tests cover lost settlement responses and disabling new steering while retaining old uncertainty.

Recovered steering intent is checked before any input preparation, output-directory access, rotation or new native attempt, even when new steering is disabled. Missing local media therefore cannot relabel an already submitted guidance request as input failure. Only the required `TurnSteerResponse.turnId` matching the recorded target is accepted; missing/mismatched IDs remain unknown. The expired-intent real Store regression asserts zero media, output-directory and native-attempt preparation calls.

## Artifact publication and cleanup ownership

A single-writer conversation guard allows native execution, steering and administrative reconciliation to share activity, while artifact cleanup is exclusive. Cleanup first takes local ownership, then checks durable active native runs and unresolved guidance; both survive process restart. New native/adopt work waits until filesystem cleanup and its durable acknowledgement leave the guard. No database lock is held over filesystem or provider work.

Published output files must be complete and closed before the turn finishes. Background processes or retained file descriptors must not continue writing published artifacts after completion; this requirement is also included in private output prompts. Quarantine/version checks protect path replacement, but cannot protect arbitrary same-user background writers holding an inode open. The lifecycle guard prevents bridge-controlled later turns from creating that overlap.
