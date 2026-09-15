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

Every forward job and any prepared private media prompt are committed before its first claim and native work. Live and API registrations enter the same direct forward path. Recovery processes reply-pending delivery first, then at most five executable jobs serially, with a reentry guard. The executor owns native lifecycle and response waiters; closing an HTTP response or the Feishu SDK acknowledgement does not interrupt a native turn. Legacy rows that already contain start intent, bound/native identity, an unknown native outcome, or an unconfirmed delivery effect remain isolated without replay.

`codex.idleCloseMs` controls only automatic app-server child cleanup after bridge activity reaches zero. The production-derived default is `60000` milliseconds. Set it explicitly to `0` to disable the timer, or to another nonnegative value up to 86400000. Explicit bridge shutdown still closes the child, and an unexpected exit still follows the existing fault/restart path. This setting does not change the separate conversation rollover, whose idle default is five days (`432000000` milliseconds), or the rules/archived rollover policy.

`codex.requestUserInput` defaults to `false`. At startup the bridge checks whether the installed Codex executable exposes the Default-mode user-input feature; when present, it explicitly passes `features.default_mode_request_user_input=false`, overriding an inherited setting from the shared Codex home. The bridge also defensively rejects an unexpected request. Set the option to `true` to opt in; the same probe then enables the feature only when supported. If the feature is unavailable, other execution remains available but Codex cannot open a Feishu question card. This setting controls the Default-mode feature used by this bridge; the bridge does not start a Plan-mode workflow.

A supported Codex request creates a separate Feishu form for the current active turn. It can contain several questions; each question accepts one listed option, an allowed Other value, or free text. Only the original sender in the original chat can submit it, and the bridge rechecks the current job, card, authorization, thread and turn. Requests containing a secret question are rejected without displaying or collecting their contents; the ordinary Feishu form is not a secret-input channel.

The first bridge version accepts at most 3 questions and 20 options per question, with up to 1,000 characters in a free-text answer and a 28 KB rendered-card budget. These are bridge and Feishu delivery limits rather than Codex protocol limits; oversized requests are rejected instead of truncated.

Submission is single-use. A submitted card confirms that the bridge accepted the form for delivery to the live native request; it does not claim that Codex has consumed the answer. Native resolution, stop, turn completion or failure, app-server disconnect, and service shutdown expire the card. The bridge does not invent timeout answers, restore an old RPC after restart, or replay a prompt or answer.

Ordinary `CODEX_THREAD_BUSY` results fail on the first attempt, including a turn-start result whose native admission outcome is unknown. Once the RPC returns busy, the existing card/reply path reports “会话被其他客户端占用，请释放后重试。原会话绑定保持不变。” without waiting for another claim. Other retryable admission failures use at most `codex.jobMaxAttempts` claims (default 3), spaced by `codex.jobRetryMs` (default 60 seconds; valid range 10 seconds to 30 minutes). The bridge keeps the binding and does not create a replacement thread.

For a busy failure tied to an existing human Feishu binding, the failed card offers “保留历史并新建会话”. Only the original sender can invoke it, and the callback rechecks the bot-scoped job, card, chat, current authorization and frozen source thread. It performs one explicit `thread/fork` with the current bridge cwd and permission defaults, persists the fork, and conditionally switches the binding before releasing that binding's admission lock. It does not resume or interrupt the source, start a turn, or replay the failed message. A native rejection or changed binding leaves the current binding unchanged. An unknown native or database commit result is recorded as unconfirmed and is not retried automatically; an administrator must inspect durable state before deciding what happened. Cross-process active-writer fork support depends on the native Codex implementation and is therefore handled as a normal visible failure rather than assumed.

A busy queue exception is allowed only when an authenticated client explicitly enables `queueIfBusy` and its nonempty validated `executionNamespace` plus `callerId` derive the same persisted system binding stored with the run. An authorized caller may set the run request's optional `queueIfBusy` to `false` to disable its configured default, or to `true` only when the caller is already allowed to queue; omission keeps the caller default. The effective policy is persisted with the run, and an explicit conflicting idempotent replay is rejected. It retains its attempt count and waits `codex.jobRetryMs`; request payloads, sender strings, message prefixes, prompt text, or disabled steering do not grant this policy. The saved card stays in retrying state and Typing remains off between probes. Recovery does not add a new Typing reaction.

`deliveryMode:"bridge"` owns Typing, an execution card, the stop callback, final answer, and attachments. The execution card uses the frozen production create/patch controller: the first running card is immediate, later updates are throttled, and final card failure selects the ordinary-message fallback. Stop is fenced to the original card, message, turn, authorized conversation, and live sender; replay cannot interrupt a newer turn.

The card sidecar stores the original message ID, status, bounded progress entries and stop identity. Card create or patch failure follows the original fallback path; a saved message ID is patched on reply recovery. Legacy unconfirmed card effects written by the previous controller remain held without another platform write.

Ordinary fallback replies use chat create rather than source-message reply. Post mode is the default and uses the production Markdown-to-Feishu conversion with 3000-character chunks; optional text mode uses 1900-character chunks. Both apply `feishu.maxOutputChars` (default 3500) and deterministic UUIDs. Legacy unconfirmed text effects remain held. Live Agent work awaits the production Typing add; a failed add sends `feishu.processingFallbackText`, and final cleanup is best effort. Recovery removes reaction IDs recorded in `assistant_message_events` and app-owned reactions from the first returned page for the configured emoji without replaying an unconfirmed add.

Bridge delivery consumes the executor's attachment paths directly. P2P is allowed; group delivery uses the existing bridge/API conversation allowlist. Every file is capped at 28 MiB. A successful upload and send removes that file; an individual failure keeps it for manual follow-up and does not block the text reply or other attachments. Legacy unconfirmed attachment intents are not replayed.

`deliveryMode:"caller"` creates no progress card, Typing reaction, final message, or attachment send. It retains the same execution and recovery rules and stores the result for an authorized caller.

The final result keeps both the display answer and `rawAnswer`. Public attachment facts never expose a local path. Caller delivery snapshots its controlled outbox and keeps decimal resource IDs usable with the resource endpoint. Bridge delivery sends and then removes successful path results, so those bridge-delivered files are not promised as later downloadable resources; a resource lookup may return not found. The frozen production upload limit is 28 MiB per file.

`feishu.displayName` sets the execution-card title and defaults to `agent-chat-bridge`.

## HTTP contract

All `/v1` endpoints require a bearer token. The configured client must include the target conversation. Request registration is idempotent by caller plus `idempotencyKey`; reuse with different execution input is a conflict.

| Endpoint | Contract |
| --- | --- |
| `POST /v1/runs` | `{conversationId,idempotencyKey,text,executionNamespace?,deliveryMode?,queueIfBusy?}` → `202 {id,duplicate}`. `deliveryMode` is `bridge` by default or `caller`; `queueIfBusy` is an authorized per-run override of the caller default. |
| `GET /v1/runs/:id` | Execution status, delivery status/mode, namespace, answer, raw answer, public attachment facts, native thread/turn/status, held reason, error code, and timestamps. |
| `GET /v1/runs/:id/events?after=0&limit=50` | `{events,nextCursor}`. Cursor values are decimal strings. Events are scoped to the run's persisted binding, thread, chat, and message and pass the shared safe public projector. |
| `GET /v1/runs/:id/resources/:index` | Authorized JSON resource `{fileName,kind,size,base64}` within the controlled result outbox. |

The 0.1.1 generation-ledger actions are not implemented by this execution model. `GET /v1/runs/:id/attempt`, `POST /v1/recoveries`, and `POST /v1/sessions/reset` return `409 unsupported_execution_model` after applicable authentication, administration, and conversation-scope checks. They do not fabricate a generation or return a registration `202`. `GET /v1/recoveries/:id` remains a read-only view of a real recovery record already stored by the communication schema, with its existing administration and conversation checks; a missing record is `404`.

Existing `/v1/deliveries` APIs remain available to registered communication callers. `POST /v1/deliveries` accepts the common `{conversationId,idempotencyKey,kind}` fields, with `kind:"create"|"reply"` using `messageKind` and `content` (`reply` also requires `messageId`), `kind:"reaction"` using `messageId` plus exactly one of `emojiType` or `reactionId`, and `kind:"upload"` using `mediaType`, `base64`, and `fileName` for files. Serialized interactive content may be at most 28,000 bytes, matching the bridge execution-card budget; other message content remains limited to 20,000 bytes, below the Feishu client's 30,000-byte transport guard. It returns `202 {id,duplicate}`; `GET /v1/deliveries/:id` returns the durable delivery state. A returned non-zero Feishu API response is `failed` with `errorCode:"feishu_api_rejected"`, and local content rejection is `failed` with `errorCode:"invalid_content"`. A thrown transport error or timeout remains `unknown` with `errorCode:"chat_delivery_unconfirmed"`; callers must not turn that ambiguity into a different delivery. Scheduled or delayed business work is submitted when due by the business producer; the bridge has no cron scheduler.

Bridge delivery status is `waiting`, `pending`, `sent`, `failed`, or `unknown`; caller delivery becomes `not_requested` at a terminal run. A known delivery failure or ambiguity does not rerun the completed model turn. `unknown` remains in reply recovery for external reconciliation, while an explicit `failed` result terminates with `reply_delivery_failed` and its item receipts intact.

## Configuration and validation

Use `examples/bridge.json` for the current shape. Secrets are read only from explicit environment-variable names. `codex.bin` and `codex.cwd` are explicit; only `codex.envNames` plus configured proxy mappings enter the child. Codex lifecycle, RPC/turn timeout, approval/reviewer, sandbox, network, user-input, rollover and memory-guard settings expose the production defaults shown in the example. `codex.jobRetryMs` and `codex.jobMaxAttempts` retain the forward retry limits. Optional `feishu.replyAsPost` and `feishu.maxOutputChars` select the original ordinary reply mode and cap. `feishu.processingReaction`, `processingReactionEmoji`, and `processingFallbackText` control the original live Typing behavior. `feishu.mediaEnabled`, `mediaInboxDir`, `mediaMaxBytes`, and `mediaUnsupportedReply` control private image preparation; the byte setting is the original post-download advisory warning rather than a rejection limit. The process uses one Feishu HTTP client and one WebSocket client.

Paths are resolved from the config file. The executable and workspace must satisfy the ownership checks. Codex state defaults to the launching user's shared `~/.codex`. Optional `codex.sharedHome` may select an absolute path or a path beginning with `~/`; if the launch environment also sets `CODEX_HOME`, both must resolve to the same directory or startup fails. The child still receives only explicitly selected environment names and proxy mappings; the production-derived app-server shell policy inherits from that controlled child environment. Approval policy defaults to `on-request`, the reviewer defaults to the installed protocol value `auto_review`, sandbox defaults to `workspace-write`, and HTTP callers cannot override these settings, cwd or execution identity.

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
