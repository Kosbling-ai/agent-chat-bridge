# Forward runtime and hooks

The unreleased development version uses one leased Codex forward worker for human Feishu conversations. It keeps the communication worker for hook delivery and internal durable chat effects. One Feishu bot and WebSocket client feed both routes; one Codex app-server and forward worker start or observe Codex work. Thread start, resume and turn start use the protocol-defined `auto_review` approval reviewer.

The implementation is validated with synthetic providers and disposable MySQL. It has not been connected to a real bot or model, deployed, or wired into the Kosbling business producer. The producer migration is separate work.

## Routing

Private Agent messages require `routing.privateUserIds` by default. Set `routing.allowAllPrivateUsers: true` to accept any identifiable human sender in a private chat, relying on the Feishu application’s access restrictions. This option defaults to `false`; omitting it preserves the existing allowlist behavior. It does not admit bot/self messages, open unlisted groups, or change hook authentication or Codex execution approvals. Private execution-card actions remain restricted to the original sender. Every authorized group is listed in `routing.groups`; unlisted groups stay closed. `routing.groups[].capabilities` accepts only `bridge` and `hook`, removes duplicates, and defaults to both when omitted. An empty list disables both routes for that group.

The `bridge` capability permits Agent routing. The existing `trigger` (`mention` or `all`) and optional `userIds` then decide whether a human message starts Codex. The `hook` capability permits hook subscriptions for that group and does not depend on Agent mentions, member filtering, execution, or replies. A message that qualifies for both routes may register both under the same canonical receipt; neither route consumes the other. Replay keeps each target idempotent.

Groups previously present only in `hooks[].conversationIds` must now also appear in `routing.groups`; use `capabilities:["hook"]` for a hook-only group. P2P rules are unchanged.

Hook delivery remains `{deliveryId,event}` with stable event, chat, and message identifiers from the normalized Feishu event. It is a lightweight notification. Business consumers use their own authoritative reader, such as lark-cli, and own polling fallback and message-ID deduplication. They do not create another Feishu WebSocket through this bridge.

## Input and execution

Live messages preserve the sender name. A bot mention is removed only when it identifies the configured bot. Group passive context reads messages strictly before the current message according to `codex.groupContextMessageLimit` (default `50`) and `codex.groupContextHours` (default `24`). Passive messages persist attachment metadata without downloading it; a later trigger downloads the selected context attachments before the current message attachments and labels their source in the attachment block. `codex.groupContextAttachmentLimit` (default `10`) caps downloadable context attachments per trigger; later items remain metadata with `context_attachment_limit`. Old context rows without attachment metadata are treated as having no attachments, with no compatibility reconstruction. Context and the current speaker are formatted into the prompt; business parsers, role SQL, lark-cli queries, and cron scheduling stay outside the bridge.

Every forward job and any prepared inbound media prompt are committed before its first claim and native work. A qualifying live human message enters the direct forward path. Recovery processes reply-pending delivery first, then at most five executable jobs serially, with a reentry guard. The executor owns native lifecycle and response waiters; the Feishu SDK acknowledgement does not interrupt a native turn. Legacy rows that already contain start intent, bound/native identity, an unknown native outcome, or an unconfirmed delivery effect remain isolated without replay. Historical API/system rows are not created by this version, automatically migrated, or deleted; existing conservative recovery and isolation rules still apply to them.

`codex.idleCloseMs` controls only automatic app-server child cleanup after bridge activity reaches zero. The production-derived default is `60000` milliseconds. Set it explicitly to `0` to disable the timer, or to another nonnegative value up to 86400000. Explicit bridge shutdown still closes the child, and an unexpected exit still follows the existing fault/restart path. This setting does not change the separate conversation rollover, whose idle default is five days (`432000000` milliseconds), or the rules/archived rollover policy.

`codex.requestUserInput` defaults to `false`. At startup the bridge checks whether the installed Codex executable exposes the Default-mode user-input feature; when present, it explicitly passes `features.default_mode_request_user_input=false`, overriding an inherited setting from the shared Codex home. The bridge also defensively rejects an unexpected request. Set the option to `true` to opt in; the same probe then enables the feature only when supported. If the feature is unavailable, other execution remains available but Codex cannot open a Feishu question card. This setting controls the Default-mode feature used by this bridge; the bridge does not start a Plan-mode workflow.

A supported Codex request creates a separate Feishu form for the current active turn. It can contain several questions; each question accepts one listed option, an allowed Other value, or free text. Only the original sender in the original chat can submit it, and the bridge rechecks the current job, card, authorization, thread and turn. Requests containing a secret question are rejected without displaying or collecting their contents; the ordinary Feishu form is not a secret-input channel.

The first bridge version accepts at most 3 questions and 20 options per question, with up to 1,000 characters in a free-text answer and a 28 KB rendered-card budget. These are bridge and Feishu delivery limits rather than Codex protocol limits; oversized requests are rejected instead of truncated.

Submission is single-use. A submitted card confirms that the bridge accepted the form for delivery to the live native request; it does not claim that Codex has consumed the answer. Native resolution, stop, turn completion or failure, app-server disconnect, and service shutdown expire the card. The bridge does not invent timeout answers, restore an old RPC after restart, or replay a prompt or answer.

Ordinary `CODEX_THREAD_BUSY` results fail on the first attempt, including a turn-start result whose native admission outcome is unknown. Once the RPC returns busy, the existing card/reply path reports “会话被其他客户端占用，请释放后重试。原会话绑定保持不变。” without waiting for another claim. Other retryable admission failures use at most `codex.jobMaxAttempts` claims (default 3), spaced by `codex.jobRetryMs` (default 60 seconds; valid range 10 seconds to 30 minutes). The bridge keeps the binding and does not create a replacement thread.

For a busy failure tied to an existing human Feishu binding, the failed card offers “保留历史并新建会话”. Only the original sender can invoke it, and the callback rechecks the bot-scoped job, card, chat, current authorization and frozen source thread. It performs one explicit `thread/fork` with the current bridge cwd and permission defaults, persists the fork, and conditionally switches the binding before releasing that binding's admission lock. It does not resume or interrupt the source, start a turn, or replay the failed message. A native rejection or changed binding leaves the current binding unchanged. An unknown native or database commit result is recorded as unconfirmed and is not retried automatically; an administrator must inspect durable state before deciding what happened. Cross-process active-writer fork support depends on the native Codex implementation and is therefore handled as a normal visible failure rather than assumed.

The bridge owns Typing, an execution card, the stop callback, final answer, and attachments for accepted human conversations. The execution card uses the frozen production create/patch controller: the first running card is immediate, later updates are throttled, and final card failure selects the ordinary-message fallback. Stop is fenced to the original card, message, turn, authorized conversation, and live sender; replay cannot interrupt a newer turn.

The card sidecar stores the original message ID, status, bounded progress entries and stop identity. A transient progress-read failure is retried with bounded exponential backoff without replaying the Codex turn or discarding the cursor. After three consecutive failures the running card indicates that progress is temporarily unavailable; a successful read removes that notice. Lease loss, runtime shutdown and cancellation stop observation, while final-answer delivery remains independent. Card create or patch failure follows the original fallback path; a saved message ID is patched on reply recovery. Legacy unconfirmed card effects written by the previous controller remain held without another platform write.

Ordinary fallback replies use chat create rather than source-message reply. Post mode is the default and uses the production Markdown-to-Feishu conversion with 3000-character chunks; optional text mode uses 1900-character chunks. Both apply `feishu.maxOutputChars` (default 3500) and deterministic UUIDs. Legacy unconfirmed text effects remain held. Live Agent work awaits the production Typing add; a failed add sends `feishu.processingFallbackText`, and final cleanup is best effort. Recovery removes reaction IDs recorded in `assistant_message_events` and app-owned reactions from the first returned page for the configured emoji without replaying an unconfirmed add.

Bridge delivery consumes the executor's attachment paths directly. P2P is allowed; group delivery uses the configured `bridge` capability. Every file is capped at 28 MiB. A successful upload and send removes that file; an individual failure keeps it for manual follow-up and does not block the text reply or other attachments. Legacy unconfirmed attachment intents are not replayed. The final result retains the display answer and `rawAnswer` as internal recovery state; neither results nor attachment files are exposed through HTTP.

`feishu.displayName` sets the execution-card title and defaults to `agent-chat-bridge`.

## HTTP contract

The HTTP listener exposes `GET /health/live`, `GET /health/ready`, and the authenticated Events API below. Other GET paths, including former `/v1` run, resource, recovery and delivery paths, return 404; unsupported non-GET requests return 405. The former top-level `auth` block, including an empty block, remains invalid configuration.

## Events API

A hook may opt into inbound events without changing its existing outbound behavior:

```json
{
  "id": "business-producer",
  "url": "https://producer.invalid/bridge-hook",
  "tokenEnv": "BRIDGE_OUTBOUND_TOKEN",
  "conversationIds": [],
  "inbound": {
    "tokenEnv": "BRIDGE_INBOUND_TOKEN",
    "scopePrefixes": ["custom-order:customer:"],
    "defaultChatId": "configured-group-id"
  }
}
```

Both token fields are environment-variable references; they are separate credentials. The inbound reference is resolved and required at startup, and inbound token values must be unique because the bearer identifies the producer. `scopePrefixes` contains one to 100 distinct namespace prefixes, each at most 64 characters and matching `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`. Hooks without `inbound` retain their prior behavior and cannot authenticate to this API. Existing `url` and outbound `tokenEnv` fields remain required.

`POST /v1/events` requires `Authorization: Bearer <token>` and a JSON body containing only `event_id`, `producer_id`, `scope`, `type`, `correlation_id`, `occurred_at`, `ref_ids`, and `prompt`; unknown fields return `400 unknown_field`. `event_id` is at most 128 characters and matches `^[A-Za-z0-9][A-Za-z0-9._:-]*$`; `scope` is at most 128 characters and matches `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`. The authenticated hook ID must equal `producer_id`, and `scope` must start with one configured prefix. `type` is at most 64 characters and matches `^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$` (for example, `mail.inbound`, `wait.due`, or `form.inbound`); the bridge treats it as opaque business metadata. `correlation_id` matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; `occurred_at` is ISO 8601. `ref_ids` has at most 16 entries whose keys match `^[A-Za-z0-9_.-]{1,64}$`; values are opaque strings of at most 2,048 characters with no control characters. `prompt` is at most 8,000 characters and must describe the event without including customer mail text. The job chat is always the hook's configured `inbound.defaultChatId`; callers cannot override it.

The entire encoded request body is capped at 65,536 bytes, which leaves bounded room for metadata around the 8,000-character prompt. The listener retains its five-second request and header timeouts. Invalid fields return 400, missing or incorrect bearer credentials return 401, a producer mismatch or disallowed scope returns 403, an existing event ID with different normalized content returns 409, and an oversized prompt or request returns 413.

Accepted requests return `202 {"job_id":"...","binding_open_id":"system:...","deduplicated":false}`. Identity is `(producer_id,event_id)` inside the current bot connection. Its forward request key is the collision-free domain-separated string `event\0<producer_id>\0<event_id>`, while its database message ID is `event:` followed by the SHA-256 hex digest of `<producer_id>\0<event_id>` (70 ASCII characters). Repeating the same normalized request returns the same job with `deduplicated:true`. Object keys are canonicalized with JavaScript's default UTF-16 code-unit ordering and are not Unicode-normalized, so input key order does not affect the hash while distinct Unicode spellings remain distinct. The job binds by `(producer_id,scope)`, uses the hook's fixed default chat and `delivery_mode='caller'`, and never creates an execution card, sends a final chat reply, or otherwise performs automatic event output. When the binding already has an active turn, the event follows `codex.steering`; an unconfirmed steer stays in durable forward recovery rather than turning the accepted HTTP request into a later delivery error.

The Codex input retains the existing `【独立系统任务】` preamble, followed by a `【业务事件】` block containing type, event ID, correlation ID, occurrence time and reference IDs, then the producer prompt. The bridge does not load business documents or inject customer content.

`GET /v1/events/:event_id` uses the same bearer token and the same domain-separated request-key derivation; the producer identity comes from that token. It returns `{"job_id":"...","status":"pending","updated_at":...}` using the forward job's existing status literals, or 404 when that hook does not own the event. Each Events API request emits exactly one terminal structured log with `hook_id`, `event_id`, `type`, `scope_prefix`, `status_code`, `job_id`, and `error_class`. Logs never contain the prompt or full payload.

Internal bridge delivery status is `waiting`, `pending`, `sent`, `failed`, or `unknown`. A known delivery failure or ambiguity does not rerun the completed model turn. A confirmed non-zero Feishu response is recorded as a rejection, while malformed responses, thrown transport errors and timeouts remain unknown and are not resent automatically.

## Configuration and validation

Use `examples/bridge.json` for the current shape. Secrets are read only from explicit environment-variable names. `codex.bin` and `codex.cwd` are explicit; only `codex.envNames` plus configured proxy mappings enter the child. Codex lifecycle, RPC/turn timeout, approval/reviewer, sandbox, network, user-input, rollover and memory-guard settings expose the production defaults shown in the example. `codex.jobRetryMs` and `codex.jobMaxAttempts` retain the forward retry limits; the three `codex.groupContext*` settings control passive-message count, age, and per-trigger attachment downloads. Optional `feishu.replyAsPost` and `feishu.maxOutputChars` select the original ordinary reply mode and cap. `feishu.processingReaction`, `processingReactionEmoji`, and `processingFallbackText` control the original live Typing behavior. `feishu.mediaEnabled` controls inbound downloads while preserving metadata, `mediaInboxDir` selects the inbox, `mediaMaxBytes` is a 1-byte to 32-MiB hard per-resource limit defaulting to 32 MiB, and `mediaDownloadTimeoutMs` is a positive-integer download deadline defaulting to 120000 ms. The process uses one Feishu HTTP client and one WebSocket client.

Paths are resolved from the config file. The executable and workspace must satisfy the ownership checks. Codex state defaults to the launching user's shared `~/.codex`. Optional `codex.sharedHome` may select an absolute path or a path beginning with `~/`; if the launch environment also sets `CODEX_HOME`, both must resolve to the same directory or startup fails. The child still receives only explicitly selected environment names and proxy mappings; the production-derived app-server shell policy inherits from that controlled child environment. Approval policy defaults to `on-request`, the reviewer defaults to the installed protocol value `auto_review`, and sandbox defaults to `workspace-write`.

Run:

```sh
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs migrate --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs start --config ./examples/bridge.json
npm test
npm run check
node scripts/test-storage.mjs test/storage-forward.integration.test.mjs
```

Migration is explicit; startup only checks the migration ledger. `/health/live` reports the HTTP process, while readiness requires the configured Store, worker, Feishu and Codex components. The storage command creates and removes a temporary MySQL container. These checks do not contact Feishu or Codex.

## MySQL storage concurrency

The bridge uses the MySQL connection pool for storage operations. Reads use a normal pooled connection. Writes use a short transaction only when several changes must commit together; single-row updates rely on atomic SQL predicates. Unique keys provide idempotency for message, job and outbox keys, while row leases protect claimable work. Every runtime table is scoped by `connection_id`, so independent bot processes do not need a process-wide advisory lock or a dedicated long-lived database connection.

`storage.writer` settings are accepted as deprecated compatibility fields and have no runtime effect. Existing configurations can retain them while migrating; new configurations should omit them. Communication polling treats normalized `store_unavailable`, `store_contention`, and `store_timeout` failures as transient: it remains running in a visible degraded state and retries with bounded exponential backoff from 1 second through 10 seconds. The final backoff is truncated at a hard deadline 30 seconds after the first failure, and no new claim starts at or after that deadline. Six consecutive failures or the deadline, whichever comes first, makes the worker unhealthy; non-transient errors do so immediately. `runtime.unhealthyExitMs` (default 30000 ms) then applies to the Store and unhealthy communication workers through the existing fail-closed non-zero exit path. Codex and Feishu still affect readiness, but their existing restart and reconnect lifecycles are not overridden by this watchdog.

Restart does not clear queues, replay ambiguous deliveries, change leases, or bypass existing idempotency. The normal durable claim, lease, and deduplication rules decide what work is eligible after the supervisor starts a replacement process.

Hook delivery still requires a durable consumer acknowledgement before it returns 204. Internal reply/reaction authorization, byte limits and unknown-write recovery remain enforced. The connected media and outbox components retain their current constraints in [input media](media.md) and [outbound media](outbound-media.md). [Catchup](catchup.md) describes the earlier generation implementation and is historical for the current forward execution path.

## Business card actions

An interactive-card callback whose `value.action` is `business` is routed directly to the hook named by `value.hook_id` when the callback chat is listed in that hook's `conversationIds`. It does not create a Codex job or enter a Codex thread. Unknown hooks and callbacks from chats outside the configured hook scope are acknowledged with `此群未接入该业务` and are not delivered.

The matching hook receives the existing authenticated delivery wrapper `{deliveryId,event}`. Its `event` is the standard Feishu envelope `{schemaVersion:1,channel:'feishu',type:'card.action',connectionId,eventId,chatId,messageId,operatorOpenId,operatorName?,value,occurredAt}`. These fields have the same envelope-level placement as existing `message.received` events; there is no second nested `event` object. The bridge treats business fields inside `value` as opaque. The Feishu event ID is used when present; otherwise the bridge derives a stable SHA-256 ID from the card message, operator, value and action time. Invalid or absent event time is represented as `occurredAt:null`, so replay hashing remains stable. Business-side hook workers must add handling for the `card.action` type; the existing message worker does not reinterpret card actions as received messages.

The callback waits up to two seconds for durable registration before returning `已收到，处理结果稍后更新在卡片上`. A slower registration continues after the toast; a registration failure observed before the response returns `已收到，系统记录延迟，请稍后确认卡片状态` and is error-reported. Delivery is persisted under `card_action:<event_id>` in the existing inbox and hook queue, so callback replays do not create another delivery and transient hook failures use the existing durable retry policy.
