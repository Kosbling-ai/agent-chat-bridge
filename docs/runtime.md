# Forward runtime and API

The unreleased 0.2.4 development version replaces the 0.1.1 generation worker with one leased Codex forward worker. It keeps the communication worker for hook delivery and registered chat outbox effects. One Feishu bot and WebSocket client feed both routes; one Codex app-server and forward worker start or observe Codex work. Thread start, resume and turn start use the protocol-defined `auto_review` approval reviewer.

The implementation is validated with synthetic providers and disposable MySQL. It has not been connected to a real bot or model, deployed, or wired into the Kosbling business producer. The producer migration is separate work.

## Routing

Private Agent messages still require `routing.privateUserIds`. Every authorized group is listed in `routing.groups`; unlisted groups stay closed. `routing.groups[].capabilities` accepts only `bridge` and `hook`, removes duplicates, and defaults to both when omitted. An empty list disables both routes for that group.

The `bridge` capability permits Agent routing. The existing `trigger` (`mention` or `all`) and optional `userIds` then decide whether a human message starts Codex. The `hook` capability permits hook subscriptions for that group and does not depend on Agent mentions, member filtering, execution, or replies. A message that qualifies for both routes may register both under the same canonical receipt; neither route consumes the other. Replay keeps each target idempotent.

Groups previously present only in `hooks[].conversationIds` must now also appear in `routing.groups`; use `capabilities:["hook"]` for a hook-only group. P2P rules are unchanged.

Hook delivery remains `{deliveryId,event}` with stable event, chat, and message identifiers from the normalized Feishu event. It is a lightweight notification. Business consumers use their own authoritative reader, such as lark-cli, and own polling fallback and message-ID deduplication. They do not create another Feishu WebSocket through this bridge.

## Input and execution

Live messages preserve the sender name. A bot mention is removed only when it identifies the configured bot. Group passive context reads at most the ten messages strictly before the current message and no more than two hours old. Context and the current speaker are formatted into the prompt; business parsers, role SQL, lark-cli queries, and cron scheduling stay outside the bridge.

Every forward job is committed before native work. A bounded forward worker may hold several claimed jobs so authorized messages can reach the executor's existing steering path; every claim has its own fenced lease identity. The single Codex app-server/executor owns native lifecycle decisions and records thread start intent and the confirmed turn before waiting for completion. Recovery with a known thread and turn only reads that turn. Unknown admission or observation becomes `held` and is never submitted again automatically.

`codex.idleCloseMs` controls only automatic app-server child cleanup after bridge activity reaches zero. The production-derived default is `60000` milliseconds. Set it explicitly to `0` to disable the timer, or to another nonnegative value up to 86400000. Explicit bridge shutdown still closes the child, and an unexpected exit still follows the existing fault/restart path. This setting does not change the separate two-day conversation rollover or rules/archived rollover policy.

If another client holds the native writer before a manual Feishu request is admitted, the request ends on its first confirmed `CODEX_THREAD_BUSY` rejection. Its existing card/reply path reports “会话被其他客户端占用，请释放后重试或新建会话。” once; the bridge keeps the binding and does not create a replacement thread or replay the request. Other explicitly retryable pre-admission failures use at most `codex.jobMaxAttempts` claims (default 3), spaced by `codex.jobRetryMs` (default 60 seconds; valid range 10 seconds to 30 minutes).

A system busy wait is allowed only when a nonempty validated `executionNamespace` and authenticated `callerId` derive the same persisted system binding stored with the run. It retains its attempt count and waits `codex.jobRetryMs`; sender strings, message prefixes, prompt text, or disabled steering do not grant this policy. The saved card stays in retrying state and Typing remains off between probes. A confirmed later admission activates them once. Known-turn observation failures, unconfirmed turn starts, and unresolved steer confirmation remain `held` with their native or intent identity, regardless of retry budget.

`deliveryMode:"bridge"` owns Typing, an execution card, the stop callback, final answer, and attachments. The execution card uses the frozen production create/patch controller: the first running card is immediate, later updates are throttled, and final card failure selects the ordinary-message fallback. Stop is fenced to the original card, message, turn, authorized conversation, and live sender; replay cannot interrupt a newer turn.

The card sidecar stores the original message ID, status, bounded progress entries and stop identity. Card create or patch failure follows the original fallback path; a saved message ID is patched on reply recovery. Legacy unconfirmed card effects written by the previous controller remain held without another platform write.

Ordinary fallback replies use chat create rather than source-message reply. Post mode is the default and uses the production Markdown-to-Feishu conversion with 3000-character chunks; optional text mode uses 1900-character chunks. Both apply `feishu.maxOutputChars` (default 3500) and deterministic UUIDs. Legacy unconfirmed text effects remain held. Attachment and Typing effects retain their current persisted intent/receipt handling: files are deleted only after the send receipt is durable, and ambiguous Typing cleanup examines the first 50 reactions returned for the source message by `operator_type=app` plus the configured emoji.

`deliveryMode:"caller"` creates no progress card, Typing reaction, final message, or attachment send. It retains the same execution and recovery rules and stores the result for an authorized caller.

The final result keeps both the display answer and `rawAnswer`. Public attachment facts contain only a decimal index in `id`, name, kind, and size; that `id` is the `:index` accepted by the resource endpoint. Resource reads are authorized and return bytes without exposing a local path. The bridge accepts at most nine result attachments and applies a 28 MiB **total** read/send budget. The frozen production source scanned at most nine and capped each upload at 28 MiB; the total budget is a deliberate tighter public boundary.

`feishu.displayName` sets the execution-card title and defaults to `agent-chat-bridge`.

## HTTP contract

All `/v1` endpoints require a bearer token. The configured client must include the target conversation. Request registration is idempotent by caller plus `idempotencyKey`; reuse with different execution input is a conflict.

| Endpoint | Contract |
| --- | --- |
| `POST /v1/runs` | `{conversationId,idempotencyKey,text,executionNamespace?,deliveryMode?}` → `202 {id,duplicate}`. `deliveryMode` is `bridge` by default or `caller`. |
| `GET /v1/runs/:id` | Execution status, delivery status/mode, namespace, answer, raw answer, public attachment facts, native thread/turn/status, held reason, error code, and timestamps. |
| `GET /v1/runs/:id/events?after=0&limit=50` | `{events,nextCursor}`. Cursor values are decimal strings. Events are scoped to the run's persisted binding, thread, chat, and message and pass the shared safe public projector. |
| `GET /v1/runs/:id/resources/:index` | Authorized JSON resource `{fileName,kind,size,base64}` within the controlled result outbox. |

The 0.1.1 generation-ledger actions are not implemented by this execution model. `GET /v1/runs/:id/attempt`, `POST /v1/recoveries`, and `POST /v1/sessions/reset` return `409 unsupported_execution_model` after applicable authentication, administration, and conversation-scope checks. They do not fabricate a generation or return a registration `202`. `GET /v1/recoveries/:id` remains a read-only view of a real recovery record already stored by the communication schema, with its existing administration and conversation checks; a missing record is `404`.

Existing `/v1/deliveries` APIs remain available to registered communication callers. `POST /v1/deliveries` accepts the common `{conversationId,idempotencyKey,kind}` fields, with `kind:"create"|"reply"` using `messageKind` and `content` (`reply` also requires `messageId`), `kind:"reaction"` using `messageId` plus exactly one of `emojiType` or `reactionId`, and `kind:"upload"` using `mediaType`, `base64`, and `fileName` for files. It returns `202 {id,duplicate}`; `GET /v1/deliveries/:id` returns the durable delivery state. Scheduled or delayed business work is submitted when due by the business producer; the bridge has no cron scheduler.

Bridge delivery status is `waiting`, `pending`, `sent`, `failed`, or `unknown`; caller delivery becomes `not_requested` at a terminal run. A known delivery failure or ambiguity does not rerun the completed model turn. `unknown` remains in reply recovery for external reconciliation, while an explicit `failed` result terminates with `reply_delivery_failed` and its item receipts intact.

## Configuration and validation

Use `examples/bridge.json` for the current shape. Secrets are read only from explicit environment-variable names. `codex.bin` and `codex.cwd` are explicit; only `codex.envNames` plus configured proxy mappings enter the child. Optional `codex.idleCloseMs` uses the lifecycle semantics above; `codex.jobRetryMs` and `codex.jobMaxAttempts` use the retry limits above. Optional `feishu.replyAsPost` and `feishu.maxOutputChars` select the original ordinary reply mode and cap. The process uses one Feishu HTTP client and one WebSocket client.

Paths are resolved from the config file. The executable and workspace must satisfy the ownership checks. Codex state defaults to the launching user's shared `~/.codex`. Optional `codex.sharedHome` may select an absolute path or a path beginning with `~/`; if the launch environment also sets `CODEX_HOME`, both must resolve to the same directory or startup fails. The child still receives only explicitly selected environment names and proxy mappings; the production-derived app-server shell policy inherits from that controlled child environment. `approvalPolicy=never`, `sandbox=workspace-write`, cwd and execution identity cannot be overridden by HTTP callers.

Run:

```sh
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs migrate --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs start --config ./examples/bridge.json
npm test
npm run check
node scripts/test-storage.mjs test/storage-forward.integration.test.mjs
```

Migration is explicit; start only checks the migration ledger and acquires the single-writer lock. `/health/live` reports the HTTP process, while readiness requires the configured Store, worker, Feishu and Codex components. The storage command creates and removes a temporary MySQL container. These checks do not contact Feishu or Codex.

Reply/reaction membership, client conversation scope, body/byte limits and unknown-write recovery remain enforced for the communication APIs. Hook delivery still requires a durable consumer acknowledgement before it returns 204. The connected media and outbox components retain their current constraints in [input media](media.md) and [outbound media](outbound-media.md). [Catchup](catchup.md) describes the earlier generation implementation and is historical for the current forward execution path.
