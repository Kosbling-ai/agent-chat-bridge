# Forward runtime and hooks

The unreleased development version uses one leased Codex forward worker for human Feishu conversations. It keeps the communication worker for hook delivery and internal durable chat effects. One Feishu bot and WebSocket client feed both routes; one Codex app-server and forward worker start or observe Codex work. Thread start, resume and turn start use the protocol-defined `auto_review` approval reviewer.

The implementation is validated with synthetic providers and disposable MySQL. It has not been connected to a real bot or model, deployed, or wired into the Kosbling business producer. The producer migration is separate work.

## Routing

Private Agent messages still require `routing.privateUserIds`. Every authorized group is listed in `routing.groups`; unlisted groups stay closed. `routing.groups[].capabilities` accepts only `bridge` and `hook`, removes duplicates, and defaults to both when omitted. An empty list disables both routes for that group.

The `bridge` capability permits Agent routing. The existing `trigger` (`mention` or `all`) and optional `userIds` then decide whether a human message starts Codex. The `hook` capability permits hook subscriptions for that group and does not depend on Agent mentions, member filtering, execution, or replies. A message that qualifies for both routes may register both under the same canonical receipt; neither route consumes the other. Replay keeps each target idempotent.

Groups previously present only in `hooks[].conversationIds` must now also appear in `routing.groups`; use `capabilities:["hook"]` for a hook-only group. P2P rules are unchanged.

Hook delivery remains `{deliveryId,event}` with stable event, chat, and message identifiers from the normalized Feishu event. It is a lightweight notification. Business consumers use their own authoritative reader, such as lark-cli, and own polling fallback and message-ID deduplication. They do not create another Feishu WebSocket through this bridge.

## Input and execution

Live messages preserve the sender name. A bot mention is removed only when it identifies the configured bot. Group passive context reads at most the ten messages strictly before the current message and no more than two hours old. Context and the current speaker are formatted into the prompt; business parsers, role SQL, lark-cli queries, and cron scheduling stay outside the bridge.

Every forward job and any prepared private media prompt are committed before its first claim and native work. A qualifying live human message enters the direct forward path. Recovery processes reply-pending delivery first, then at most five executable jobs serially, with a reentry guard. The executor owns native lifecycle and response waiters; the Feishu SDK acknowledgement does not interrupt a native turn. Legacy rows that already contain start intent, bound/native identity, an unknown native outcome, or an unconfirmed delivery effect remain isolated without replay. Historical API/system rows are not created by this version, automatically migrated, or deleted; existing conservative recovery and isolation rules still apply to them.

`codex.idleCloseMs` controls only automatic app-server child cleanup after bridge activity reaches zero. The production-derived default is `60000` milliseconds. Set it explicitly to `0` to disable the timer, or to another nonnegative value up to 86400000. Explicit bridge shutdown still closes the child, and an unexpected exit still follows the existing fault/restart path. This setting does not change the separate conversation rollover, whose idle default is five days (`432000000` milliseconds), or the rules/archived rollover policy.

`codex.requestUserInput` defaults to `false`. At startup the bridge checks whether the installed Codex executable exposes the Default-mode user-input feature; when present, it explicitly passes `features.default_mode_request_user_input=false`, overriding an inherited setting from the shared Codex home. The bridge also defensively rejects an unexpected request. Set the option to `true` to opt in; the same probe then enables the feature only when supported. If the feature is unavailable, other execution remains available but Codex cannot open a Feishu question card. This setting controls the Default-mode feature used by this bridge; the bridge does not start a Plan-mode workflow.

A supported Codex request creates a separate Feishu form for the current active turn. It can contain several questions; each question accepts one listed option, an allowed Other value, or free text. Only the original sender in the original chat can submit it, and the bridge rechecks the current job, card, authorization, thread and turn. Requests containing a secret question are rejected without displaying or collecting their contents; the ordinary Feishu form is not a secret-input channel.

The first bridge version accepts at most 3 questions and 20 options per question, with up to 1,000 characters in a free-text answer and a 28 KB rendered-card budget. These are bridge and Feishu delivery limits rather than Codex protocol limits; oversized requests are rejected instead of truncated.

Submission is single-use. A submitted card confirms that the bridge accepted the form for delivery to the live native request; it does not claim that Codex has consumed the answer. Native resolution, stop, turn completion or failure, app-server disconnect, and service shutdown expire the card. The bridge does not invent timeout answers, restore an old RPC after restart, or replay a prompt or answer.

Ordinary `CODEX_THREAD_BUSY` results fail on the first attempt, including a turn-start result whose native admission outcome is unknown. Once the RPC returns busy, the existing card/reply path reports “会话被其他客户端占用，请释放后重试。原会话绑定保持不变。” without waiting for another claim. Other retryable admission failures use at most `codex.jobMaxAttempts` claims (default 3), spaced by `codex.jobRetryMs` (default 60 seconds; valid range 10 seconds to 30 minutes). The bridge keeps the binding and does not create a replacement thread.

For a busy failure tied to an existing human Feishu binding, the failed card offers “保留历史并新建会话”. Only the original sender can invoke it, and the callback rechecks the bot-scoped job, card, chat, current authorization and frozen source thread. It performs one explicit `thread/fork` with the current bridge cwd and permission defaults, persists the fork, and conditionally switches the binding before releasing that binding's admission lock. It does not resume or interrupt the source, start a turn, or replay the failed message. A native rejection or changed binding leaves the current binding unchanged. An unknown native or database commit result is recorded as unconfirmed and is not retried automatically; an administrator must inspect durable state before deciding what happened. Cross-process active-writer fork support depends on the native Codex implementation and is therefore handled as a normal visible failure rather than assumed.

The bridge owns Typing, an execution card, the stop callback, final answer, and attachments for accepted human conversations. The execution card uses the frozen production create/patch controller: the first running card is immediate, later updates are throttled, and final card failure selects the ordinary-message fallback. Stop is fenced to the original card, message, turn, authorized conversation, and live sender; replay cannot interrupt a newer turn.

The card sidecar stores the original message ID, status, bounded progress entries and stop identity. Card create or patch failure follows the original fallback path; a saved message ID is patched on reply recovery. Legacy unconfirmed card effects written by the previous controller remain held without another platform write.

Ordinary fallback replies use chat create rather than source-message reply. Post mode is the default and uses the production Markdown-to-Feishu conversion with 3000-character chunks; optional text mode uses 1900-character chunks. Both apply `feishu.maxOutputChars` (default 3500) and deterministic UUIDs. Legacy unconfirmed text effects remain held. Live Agent work awaits the production Typing add; a failed add sends `feishu.processingFallbackText`, and final cleanup is best effort. Recovery removes reaction IDs recorded in `assistant_message_events` and app-owned reactions from the first returned page for the configured emoji without replaying an unconfirmed add.

Bridge delivery consumes the executor's attachment paths directly. P2P is allowed; group delivery uses the configured `bridge` capability. Every file is capped at 28 MiB. A successful upload and send removes that file; an individual failure keeps it for manual follow-up and does not block the text reply or other attachments. Legacy unconfirmed attachment intents are not replayed. The final result retains the display answer and `rawAnswer` as internal recovery state; neither results nor attachment files are exposed through HTTP.

`feishu.displayName` sets the execution-card title and defaults to `agent-chat-bridge`.

## HTTP contract

The HTTP listener exposes only `GET /health/live` and `GET /health/ready`. Unknown GET paths, including every former `/v1` run, event, resource, recovery and delivery path, return 404; non-GET requests return 405. Business systems integrate through configured outbound hooks and keep their own SDK, Codex, scheduling and message-delivery paths. The former top-level `auth` block, including an empty block, is no longer valid configuration. Hook authentication remains configured per hook with `hooks[].tokenEnv`.

Internal bridge delivery status is `waiting`, `pending`, `sent`, `failed`, or `unknown`. A known delivery failure or ambiguity does not rerun the completed model turn. A confirmed non-zero Feishu response is recorded as a rejection, while malformed responses, thrown transport errors and timeouts remain unknown and are not resent automatically.

## Configuration and validation

Use `examples/bridge.json` for the current shape. Secrets are read only from explicit environment-variable names. `codex.bin` and `codex.cwd` are explicit; only `codex.envNames` plus configured proxy mappings enter the child. Codex lifecycle, RPC/turn timeout, approval/reviewer, sandbox, network, user-input, rollover and memory-guard settings expose the production defaults shown in the example. `codex.jobRetryMs` and `codex.jobMaxAttempts` retain the forward retry limits. Optional `feishu.replyAsPost` and `feishu.maxOutputChars` select the original ordinary reply mode and cap. `feishu.processingReaction`, `processingReactionEmoji`, and `processingFallbackText` control the original live Typing behavior. `feishu.mediaEnabled`, `mediaInboxDir`, `mediaMaxBytes`, and `mediaUnsupportedReply` control private image preparation; the byte setting is the original post-download advisory warning rather than a rejection limit. The process uses one Feishu HTTP client and one WebSocket client.

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

Migration is explicit; start only checks the migration ledger and acquires the single-writer lock. `/health/live` reports the HTTP process, while readiness requires the configured Store, worker, Feishu and Codex components. The storage command creates and removes a temporary MySQL container. These checks do not contact Feishu or Codex.

Hook delivery still requires a durable consumer acknowledgement before it returns 204. Internal reply/reaction authorization, byte limits and unknown-write recovery remain enforced. The connected media and outbox components retain their current constraints in [input media](media.md) and [outbound media](outbound-media.md). [Catchup](catchup.md) describes the earlier generation implementation and is historical for the current forward execution path.
