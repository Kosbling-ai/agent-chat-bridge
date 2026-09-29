# Forward runtime and hooks

The unreleased development version uses one leased Codex forward worker for human Feishu conversations. It keeps the communication worker for hook delivery and internal durable chat effects. One Feishu bot and WebSocket client feed both routes; one Codex app-server and forward worker start or observe Codex work. Thread start, resume and turn start use the protocol-defined `auto_review` approval reviewer.

The implementation is validated with synthetic providers and disposable MySQL. It has not been connected to a real bot or model, deployed, or wired into the Kosbling business producer. The producer migration is separate work.

## Routing

Private Agent messages require `routing.privateUserIds` by default. Set `routing.allowAllPrivateUsers: true` to accept any identifiable human sender in a private chat, relying on the Feishu application’s access restrictions. This option defaults to `false`; omitting it preserves the existing allowlist behavior. It does not admit bot/self messages, open unlisted groups, or change hook authentication or Codex execution approvals. Private execution-card actions remain restricted to the original sender. Every authorized group is listed in `routing.groups`; unlisted groups stay closed. `routing.groups[].capabilities` accepts only `bridge` and `hook`, removes duplicates, and defaults to both when omitted. An empty list disables both routes for that group.

The `bridge` capability permits Agent routing. The existing `trigger` (`mention` or `all`) and optional `userIds` then decide whether a human message starts Codex. The `hook` capability permits hook subscriptions for that group and does not depend on Agent mentions, member filtering, execution, or replies. A message that qualifies for both routes may register both under the same canonical receipt; neither route consumes the other. Replay keeps each target idempotent. A live human mention of the bot in a group that is absent from `routing.groups` receives a fixed reply naming the group `chat_id`, rate-limited per group and speaker; adjust or disable it with `routing.unlistedGroupReply` (`enabled`, `text`, `cooldownMs`).

Set `routing.groups[].replyTriggers: true` (default `false`) to let an authorized human reply to a message from this bot without mentioning it. Replies to bot text or cards qualify, including history catch-up; replies to other people do not. `trigger: "all"` already accepts every authorized human message. The bridge checks its stored outbound message IDs first, then reads the replied-to parent or thread root from Feishu when needed. Failed reads do not trigger a turn. The existing `【被回复消息】` section still describes the immediate parent.

Groups previously present only in `hooks[].conversationIds` must now also appear in `routing.groups`; use `capabilities:["hook"]` for a hook-only group. P2P rules are unchanged.

### Group instructions

A `bridge` group may add optional instructions for its human group thread:

```json
{
  "conversationId": "oc_example",
  "trigger": "mention",
  "replyTriggers": false,
  "passiveContext": true,
  "capabilities": ["bridge", "hook"],
  "instructionFiles": ["instructions/group.md", "/absolute/path/shared.md"],
  "instructionText": "Short group-specific note.",
  "instructionMode": "append",
  "replyContext": { "cardJson": false, "maxChars": 4000 }
}
```

`instructionFiles` holds 1–20 distinct paths; a relative path is resolved from the directory containing the bridge configuration file. `instructionText` is an optional trimmed string of at most 8,000 characters for short wording without a file. The bridge combines them in order (text first, then files) under a generic `【飞书群指令】` header with the group `chat_id`, and injects the result into the group's Codex thread as one `developer` item through `thread/inject_items` before the next turn starts. Each file must be a readable UTF-8 regular file, and the configured text plus all files of one group may not exceed 204,800 bytes (200 KiB).

The injected content is fingerprinted with SHA-256. The thread receives it on its first turn, again when the combined content changes (files are re-read when their size, mtime, ctime or inode changes), again after a rollover creates a new thread, and again after Codex reports context compaction, because compaction rebuilds model history. The fingerprint is stored as one `context_injection` row per thread in `assistant_codex_events` (event key `injection:group-instructions`, detail contains only the state, hash, byte count and section count), so a bridge restart does not inject the same content twice. Instructions are never copied into the user turn, logs or the event store.

`instructionMode` is `append` (default) or `replace` and is only accepted together with instructions. In `append` mode the bridge's default group wording stays and the instructions supplement it. In `replace` mode the instructions supersede only the default group wording that describes the group and how to answer: the `群名称`, `群介绍` and `说明：这是本 Codex 会话绑定的飞书群…` lines of the first-turn `【飞书群聊上下文】` block. The replacement applies only when the thread actually holds the current instructions; if they could not be loaded or injected, the default wording is kept for that turn. The mode is part of the injected header and fingerprint, so changing it re-injects once.

These functional blocks can never be replaced or removed by group instructions: the `【飞书群聊上下文】` header with its `chat_id` line; the result-file directory (`回发文件目录`) and its upload note, including the later-turn `【飞书群聊文件回传】` block; sender lines and the per-message `[msg …]` identity blocks; the replied-to message section; attachment blocks; the `【独立系统任务】` preamble and its first-turn logic for business-event threads; and private-chat prompts.

Instructions apply only to human group threads of configured groups; private chats, business-event threads and unconfigured groups are unchanged. Runtime failures never block a turn: an unreadable, missing, empty, non-UTF-8 or over-limit file is skipped with one `group_instructions` `skipped` warning per failure state (fields: `code`, `reason`, `stage` = `file_<index>`, `chat_id`; no path or content) and an `info` `recovered` event once it is usable again. A failed `thread/inject_items` request or fingerprint lookup is logged as a `context_injection` warning and retried on a later turn. `check-config` is the strict preflight: it reads every configured file, reports each problem with the same fields, and exits non-zero. The bridge does not choose, parse or interpret instruction content; the business side owns what the files say.

Hook delivery remains `{deliveryId,event}` with stable event, chat, and message identifiers from the normalized Feishu event. It is a lightweight notification. Business consumers use their own authoritative reader, such as lark-cli, and own polling fallback and message-ID deduplication. They do not create another Feishu WebSocket through this bridge.

## Input and execution

Live messages preserve the sender name. A bot mention is removed only when it identifies the configured bot. Group passive context reads messages strictly before the current message according to `codex.groupContextMessageLimit` (default `50`) and `codex.groupContextHours` (default `24`). Passive messages persist attachment metadata without downloading it; a later trigger downloads the selected context attachments before the current message attachments and labels their source in the attachment block. `codex.groupContextAttachmentLimit` (default `10`) caps downloadable context attachments per trigger; later items remain metadata with `context_attachment_limit`. Old context rows without attachment metadata are treated as having no attachments, with no compatibility reconstruction. Context and the current speaker are formatted into the prompt; business parsers, role SQL, lark-cli queries, and cron scheduling stay outside the bridge.

Every group prompt entry carries a one-line Feishu message identity block directly below its sender line, so the Agent can refer to the real message when it calls a business tool:

```text
【群消息 来自 Alice（open_id=ou_a）】
[msg message_id=om_1 parent_id=om_card root_id=om_card sender_open_id=ou_a create_time=2026-09-26T01:02:02.000Z]
Looks good.

【提到你的消息 来自 Bob（open_id=ou_b）】
[msg message_id=om_2 chat_id=oc_group parent_id=om_1 root_id=om_card sender_open_id=ou_b create_time=2026-09-26T01:02:03.000Z]
Please continue.
```

`message_id` is the Feishu message ID of that entry, `parent_id` the message it replies to or quotes, `root_id` the root of its reply thread, `sender_open_id` the sender's app-scoped open ID, and `create_time` the Feishu creation time as ISO 8601 UTC. The triggering (`提到你的消息`) entry also carries `chat_id`, and it is always present even when the triggering message has no text body. A field without a value is omitted, and only values matching `^[A-Za-z0-9_.:-]{1,191}$` are printed. When a replied-to message is itself in the passive context, its own entry carries the same ID as the trigger's `parent_id`. Passive messages persist `parentId` and `rootId` in their existing stored content JSON; older rows simply omit the two fields. No other sender profile or platform field is added, and private-chat prompts are unchanged.

When a group trigger replies to another message (it has `parent_id`, or only `root_id`), the bridge adds a `【被回复消息】` section below the trigger's identity block and before its text, with no configuration required. The first line is the parent's identity block (`message_id`, `msg_type`, `parent_id`, `root_id`, `sender_type`, `sender_open_id` for a user or `sender_app_id` for an app, `create_time`); the content follows as `> ` quoted lines. Text and post messages contribute their text, with mention keys replaced by `@name`. Interactive cards contribute their visible text in document order — header/title, text, Markdown and field elements, `@name` mentions, `[图片]`, `[按钮] <label>` for buttons and `[控件] <placeholder>` for other inputs; button values, callback behaviours, links, image keys and identifiers are never included. Images and files contribute `[图片]` or `[文件] <name>`, other types `[<msg_type> 消息]`. A parent that is already in the passive context is referenced (`内容见上方同 message_id 的群消息`) instead of being fetched again.

The parent is read with one bounded (5-second) Feishu `GET /im/v1/messages/:message_id` call per trigger. A failed, deleted or unavailable read is shown as `> 被回复内容不可得` and logged as a `reply_context` `unavailable` warning with `code`, `stage`, `chat_id` and the parent `message_id`; the turn continues. Content is capped at `routing.groups[].replyContext.maxChars` characters (default 4000, range 200–30000) and marked `…（已截断）` when cut. Setting `replyContext.cardJson: true` additionally reads the card with `card_msg_content_type=user_card_content` and appends its original JSON, compacted and capped at the same limit, under `【被回复卡片 JSON】`; this opt-in section does contain the card's button values. Passive context entries keep only their own `parent_id`/`root_id`; their parents are not fetched. Private chats never fetch replied-to messages.

Every forward job and any prepared inbound media prompt are committed before its first claim and native work. A qualifying live human message enters the direct forward path. For a group reply, the replied-to content is fetched after Feishu acknowledgement and before the forward job is committed; a process crash in this window (up to about 10 seconds for the two bounded card reads) leaves that message unavailable to catch-up replay. Recovery processes reply-pending delivery first, then at most five executable jobs serially, with a reentry guard. The executor owns native lifecycle and response waiters; the Feishu SDK acknowledgement does not interrupt a native turn. Legacy rows that already contain start intent, bound/native identity, an unknown native outcome, or an unconfirmed delivery effect remain isolated without replay. Historical API/system rows are not created by this version, automatically migrated, or deleted; existing conservative recovery and isolation rules still apply to them.

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

Each event turn carries a `【业务事件】` block containing type, event ID, correlation ID, occurrence time and reference IDs, then the producer prompt. The fixed `【独立系统任务】` preamble (task identity, result chat, the thread's scope statement and result-file directory) is prepended only to the first turn of that thread, when any preamble value differs from the one the thread last received, after a rollover creates a new thread, and after Codex reports context compaction. Its SHA-256 fingerprint is stored like group instructions, under the event key `injection:system-preamble`, and survives restarts; a failed lookup sends the preamble again rather than omit it. Because the result chat is part of the thread binding, a new default chat produces a new thread and therefore a fresh preamble. Business-event threads do not receive group instructions. The bridge itself does not choose business documents or inject customer content; beyond the configured group name and description, it adds only the operator-configured group instructions described under Routing.

`GET /v1/events/:event_id` uses the same bearer token and the same domain-separated request-key derivation; the producer identity comes from that token. It returns `{"job_id":"...","status":"pending","updated_at":...}` using the forward job's existing status literals, or 404 when that hook does not own the event. Each Events API request emits exactly one terminal structured log with `hook_id`, `event_id`, `type`, `scope_prefix`, `status_code`, `job_id`, and `error_class`. Logs never contain the prompt or full payload.

Internal bridge delivery status is `waiting`, `pending`, `sent`, `failed`, or `unknown`. A known delivery failure or ambiguity does not rerun the completed model turn. A confirmed non-zero Feishu response is recorded as a rejection, while malformed responses, thrown transport errors and timeouts remain unknown and are not resent automatically.

## Configuration and validation

Use `examples/bridge.json` for the current shape. Secrets are read only from explicit environment-variable names. `codex.bin` and `codex.cwd` are explicit; only `codex.envNames` plus configured proxy mappings enter the child. Codex lifecycle, RPC/turn timeout, approval/reviewer, sandbox, network, user-input, rollover and memory-guard settings expose the production defaults shown in the example. `codex.jobRetryMs` and `codex.jobMaxAttempts` retain the forward retry limits; the three `codex.groupContext*` settings control passive-message count, age, and per-trigger attachment downloads. Optional `feishu.replyAsPost` and `feishu.maxOutputChars` select the original ordinary reply mode and cap. `feishu.processingReaction`, `processingReactionEmoji`, and `processingFallbackText` control the original live Typing behavior. `feishu.mediaEnabled` controls inbound downloads while preserving metadata, `mediaInboxDir` selects the inbox, `mediaMaxBytes` is a 1-byte to 32-MiB hard per-resource limit defaulting to 32 MiB, and `mediaDownloadTimeoutMs` is a positive-integer download deadline defaulting to 120000 ms. The process uses one Feishu HTTP client and one WebSocket client.

Paths are resolved from the config file. The executable and workspace must satisfy the ownership checks. Codex state defaults to the launching user's shared `~/.codex`. Optional `codex.sharedHome` may select an absolute path or a path beginning with `~/`; if the launch environment also sets `CODEX_HOME`, both must resolve to the same directory or startup fails. The child still receives only explicitly selected environment names and proxy mappings; the production-derived app-server shell policy inherits from that controlled child environment. Approval policy defaults to `on-request`, the reviewer defaults to the installed protocol value `auto_review`, and sandbox defaults to `workspace-write`.

`check-config` validates the JSON contract and reads configured group instruction files; it never resolves environment secrets.

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
