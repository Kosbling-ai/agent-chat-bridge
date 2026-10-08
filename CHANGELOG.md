# Changelog

## [0.2.25] - 2026-10-08

- Add the optional per-group working directory `routing.groups[].codex.cwd`. It must be an absolute path; relative paths, empty strings, non-strings, surrounding whitespace and control characters fail with `invalid_group_codex_cwd`. The value is stored normalized. It may be set alone or together with `approvalPolicy`, `approvalsReviewer` and `sandbox`, and applies to the same threads: the group's human thread and business-event threads whose hook `inbound.defaultChatId` is the group. The executor sends it on `thread/start`, `thread/resume`, `thread/fork` and every `turn/start` of those threads; other groups and private chats keep the global `codex.cwd`. The app-server child, `feishu.cardTextFile`, `.agent-chat-bridge/` outbox and spool, `data/feishu-outbox`, the media inbox and `codex.rulesFiles` stay relative to the global `codex.cwd`.
- Startup and `check-config` apply the global workspace rules to every group `cwd` (existing directory, owned by the bridge user, not world-writable) and fail with `invalid_group_codex_workspace`; the log carries `chat_id` and `reason` (`missing`, `not_directory`, `world_writable`, `not_owned`, `unreadable`), never the path.
- Move a thread whose recorded cwd differs from its group's `cwd` to a new thread. Codex 0.153.4 keeps the cwd a thread recorded at `thread/start`; `thread/resume` with another cwd does not change `thread.cwd`. The executor records the cwd Codex reports on `thread/resume` (both resume paths) and `thread/start`; before the next turn it replaces a mismatched thread through the existing rollover path, so the new thread starts in the group `cwd` and receives the full first-turn context (group instructions, system-task preamble). It logs `thread_rollover` with `reason` `cwd_changed` and `chat_id`, never a path. A known-turn resume only records the cwd; the move happens at the next turn admission. Groups without their own `cwd` and private chats never move for this reason. If a new thread reports a cwd other than the one requested, cwd rollover stops for that group (`thread_rollover` `skipped`, `reason` `cwd_unconfirmed`) instead of looping. The old thread is not archived, as with other rollovers.
- The result-file directory (`回发文件目录`) in prompts is now an absolute path, `<global codex.cwd>/data/feishu-outbox/...`, for every conversation, so it stays correct in any thread cwd. Collection is unchanged. Because the `【独立系统任务】` preamble contains this path, each business-event thread receives the preamble once more on its next turn.
- The busy-card fork verifies the native `thread.cwd` against the thread's own cwd (the group `cwd` when configured).
- The executor log adapter now forwards `reason` and `chat_id`, so `session_rollover` logs also show their reason.

No database migration and no config `schemaVersion` change. Without `codex.cwd` the Codex request parameters are unchanged except for the absolute result-file directory. Codex reads `AGENTS.md` from the cwd when a thread is created, so edits to the workspace `AGENTS.md` take effect for new threads.

Operator checklist (use the real values only in the private bridge.json):

1. Create the group workspace: `mkdir -p <parent-dir>`, then `mkdir -m 700 <workspace-dir>`, and add its `AGENTS.md` (for example `ln -s <source>/AGENTS.md <workspace-dir>/AGENTS.md`). Verify that `stat -f '%Su %Lp' <workspace-dir>` prints the bridge user and `700`. A directory outside any git repository gives project-less Codex threads, which read only the Codex home `AGENTS.md` and the directory's own `AGENTS.md`.
2. Deploy 0.2.25 by fast-forward: `git -C <bridge-checkout> fetch origin`, then `git -C <bridge-checkout> merge --ff-only origin/main`. The running bridge keeps the old code until its restart.
3. Back up the private configuration (`cp -p <bridge.json> <bridge.json>.bak-0.2.25-<timestamp>`), then add `"cwd": "<workspace-dir>"` to each target group's `codex` object. Keep the group's `instructionFiles` unchanged, including an entry that points at the same `AGENTS.md`: the human thread then also receives it as group instructions, which are re-injected when the file changes, while business-event threads read it only from the cwd when the thread is created.
4. Run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>` from the updated checkout; it must log `check_config` `succeeded`.
5. Confirm that no turn is running: the bridge log must show `"operation":"app_server_close","status":"succeeded"` after the last activity (the Codex child closes only when idle), with no newer activity.
6. In that idle window restart only the bridge: `kill -TERM <bridge-pid>`, and let its supervisor start it again. Find the pid with `ps -axo pid,command | grep '[a]gent-chat-bridge.mjs start'` or in the supervisor's `logs/status.json` (`services["agent-chat-bridge"].pid`). Do not restart other services.
7. Verify: `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` returns `{"live":true}` and `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/ready` returns HTTP 200 with `"ready":true`. The bridge log must not contain `invalid_group_codex_workspace`. On their next turn, the group's existing threads log `thread_rollover` with `reason` `cwd_changed` once each.
8. Rollback: restore the backup (or remove `cwd`), run `check-config`, then repeat steps 5–6. To return to 0.2.24, remove every `codex.cwd` first: 0.2.24 rejects the key with `invalid_group_codex_fields` at startup. Threads already moved keep the workspace as their recorded cwd (their turns run in the global cwd) until their next rollover.

Warning: the group workspace is checked at every start. If the directory is deleted, becomes world-writable or changes owner, the next bridge start fails as a whole (`invalid_group_codex_workspace`), which stops every group and private chat until the directory is restored or `cwd` is removed.

## [0.2.24] - 2026-10-08

- Treat an uncertain queue-claim COMMIT as a bounded poll failure. Discard its result and respect durable leases instead of stopping the whole bridge immediately and disconnecting active Codex turns.
- Preserve fail-closed behavior for persistent failures and invalid input. No schema/config migration or automatic replay of failed business runs.

## [0.2.23] — Unreleased

- Add the optional card text key `commandTitleTemplate` (default `{name}`, placeholders `{name}` and `{label}`) for execution-card command lines that have no recognised action (read, search, list files, skill). `{name}` is the program name (for example `node` or `git status`) and `{label}` is `toolCommandExecutionLabel` (default `执行命令`), so `{label}` shows 「执行命令」 instead of the bare program name. Lines with a recognised action keep showing the action. The default keeps the 0.2.22 output.

No database migration and no configuration format change. Rollback to 0.2.22: first remove `commandTitleTemplate` from every card text file, because 0.2.22 rejects unknown fields and would ignore the whole file.

## [0.2.22] — Unreleased

- Compact the execution card to the shared Feishu card layout. The visible area holds only key content and the process folds into at most one collapsed panel, never nested panels. A running card shows the latest public commentary (or `received`), the progress-unavailable notice when it applies, the status line, one panel titled by `toolGroup` whose single Markdown block lists one line per tool (`- {toolItem}`, without durations, exit codes or tool names), and the stop button. Completed, failed, interrupted and deferred cards show the final answer and status line first, then one `N 个工具调用 · 已结束` panel (titled by the new card text key `processGroup`, default `执行过程`, when there was commentary but no tool call) with all retained commentary (`· ` prefix) and tool lines in time order, then the fork button on a failed busy card; a card without commentary or tools has no panel. Silent completion shows only `silentReply` and the status line. Per-tool panels and separate duration/tool-name rows are gone.
- The 28 KB card budget now drops the oldest panel lines first (the panel then starts with `omitted`), then the panel; the final answer is never truncated and still selects the ordinary-message fallback when it alone exceeds the budget.

No database migration and no configuration change are needed. No card text key was removed or renamed, so existing `feishu.cardTextFile` files keep working; the only new key is the optional `processGroup`, which 0.2.21 rejects, so remove it before rolling back. Stored card state is unchanged; a card created by 0.2.21 switches to the new layout on its next patch.

## [0.2.21] — Unreleased

- Add the optional per-group `routing.groups[].codex` permission override with `approvalPolicy` (`untrusted`, `on-request`, `never`), `approvalsReviewer` (`user`, `auto_review`, `guardian_subagent`) and `sandbox` (`read-only`, `workspace-write`, `danger-full-access`). Each configured field replaces the global `codex.approvalPolicy`, `codex.approvalsReviewer` or `codex.sandbox` for group bindings of that chat id: the human group thread and business-event threads whose hook `inbound.defaultChatId` is the group. Private chats never match, even with the same chat id. The executor sends the approval policy, reviewer and sandbox on `thread/start`, `thread/resume` and `thread/fork`, and the approval policy and reviewer on `turn/start`, which has no `sandbox` parameter. Codex full access needs `"approvalPolicy": "never"` together with `"sandbox": "danger-full-access"`; `never` with `workspace-write` makes Codex reject MCP tool calls that need approval. The field requires the `bridge` capability (`group_context_requires_bridge`) and rejects an empty object or unknown keys (`invalid_group_codex_fields`) and values outside the enums, compared without trimming (`invalid_group_codex_approval_policy`, `invalid_group_codex_approvals_reviewer`, `invalid_group_codex_sandbox`). Enabling or removing it takes a `check-config` and one restart; 0.2.20 rejects the key, so remove it before rolling back.

No database migration is needed. Without the field, approval and sandbox behavior and the Codex request parameters are unchanged.

## [0.2.20] — Unreleased

- Add an optional silent-reply sentinel for human group turns. `routing.silentReply` sets the defaults for every `bridge` group (`tokens`, default `[]`; `card`, `"delete"` or `"complete"`, default `"delete"`) and `routing.groups[].silentReply` overrides either field for one group. When a completed Agent answer, trimmed of surrounding whitespace, exactly equals a configured token (case-sensitive, no prefix or substring match), the bridge sends no text reply, recalls the execution card (`delete`) or closes it as completed with the neutral card text `silentReply` (`complete`, default `已处理，无需回复。`), and records the job as `completed` with `result.silentReply = { status: "silent", card }` plus a `forward_reply` `silent` log. A failed recall falls back to `complete`; the sentinel is never shown and never sent as ordinary text. Private chats, failed or deferred turns, business-event jobs and all other answers keep their existing delivery. Outbox attachments are still delivered.
- Retry a silent close whose existing card could be neither recalled nor patched (`card: "unchanged"`) through the ordinary reply-pending retry, bounded by `codex.jobRetryMs` and `codex.jobMaxAttempts`, before finishing with a warning.
- Stop delivering recalls of the bot's own recorded outbound messages (execution cards, replies) to hooks, for live `im.message.recalled_v1` events and history catch-up deletions alike; such recalls are still accepted and tombstoned and never become group context. A failed ownership lookup keeps the previous hook delivery.
- Add the generic `deleteMessage` Feishu chat-client helper (`im.v1.message.delete`).

No database migration is needed. With no tokens configured, reply behavior is unchanged.

## [0.2.19] — Unreleased

- Add optional `routing.groups[].replyTriggers` (default `false`) so replies to this bot's text or cards trigger an authorized group turn without an `@`, including history catch-up. Record confirmed outbound message IDs in the existing message store; check unknown parent and root IDs with bounded Feishu reads and cached ownership results. Reply-context injection follows the same path.

No database migration is needed.

## [0.2.18] — Unreleased

- Convert valid Agent reply mentions (`<at user_id="ou_…"></at>`, `<at open_id="ou_…"></at>`, and `@{ou_…}`) into Feishu post `at` elements, including replies configured for text mode. Invalid IDs remain literal. Per-group `routing.groups[].allowMentionAll` enables `<at user_id="all"></at>` only for that group; it defaults to false. Interactive cards are unchanged.

No database migration is needed.

## [0.2.17] — Unreleased

- Normalize business-card callback `action_time` from seconds, milliseconds, microseconds or nanoseconds before forwarding, and discard invalid or out-of-range values. The original time string still participates in fallback event ID hashing.

No database migration is needed.

## [0.2.16] — Unreleased

- Add a one-line Feishu message identity block to every group prompt entry: passive context entries carry `message_id`, `parent_id`, `root_id`, `sender_open_id` and `create_time`; the triggering message additionally carries `chat_id` and is always identified even without a text body. Passive messages persist their reply identifiers in the existing stored content JSON. Private-chat prompts are unchanged.
- Add optional `routing.groups[].instructionFiles` (absolute or relative to the config file) and `instructionText`. Configured content is injected into the group's human Codex thread as one developer item through `thread/inject_items` on the first turn, when its SHA-256 fingerprint changes, after rollover and after context compaction; a durable per-thread fingerprint prevents repeats after restart. Unusable files are skipped with a warning and never block a turn; `check-config` now reads configured files and fails on missing, unreadable, empty, non-UTF-8 or over-limit (200 KiB per group) input.
- Add optional `routing.groups[].instructionMode` (`append` by default, or `replace`). Replace mode supersedes only the default group name, description and session wording once the thread holds the instructions; `chat_id`, result-file, attachment, message-identity and system-preamble blocks always stay.
- Add a `【被回复消息】` section to group triggers that reply to another message: the parent's identity block plus its text, or a card's visible text with button labels only. The parent is read once with a 5-second limit; failures show `被回复内容不可得` and log a warning. Optional `routing.groups[].replyContext` sets `maxChars` (default 4000) and `cardJson` (default `false`) to append the card's original JSON.
- Send the `【独立系统任务】` preamble to a business-event thread only on its first turn, when any preamble value changes, after rollover or after context compaction, using the same durable fingerprint record; other turns carry only the business-event block and producer prompt.

No database migration is needed.

## [0.2.15] — Unreleased

- Add read-only `GET /health/tasks` for connection-scoped failed and interrupted forward-job counts within a bounded time window. Invalid windows return 400 and unreadable storage returns a fixed 503 error. No database migration or configuration change is needed.

## [0.2.14] — Unreleased

- Restore the fixed Feishu reply for bot mentions from groups that are not listed in `routing.groups`. A live human `@bot` message in such a group queues one text reply to that message containing the group's `chat_id`; hook-only groups, unauthorized speakers in configured groups, history catch-up, bot/app/self messages and duplicates stay silent. Replies are rate-limited in memory per group and speaker. The new optional `routing.unlistedGroupReply` setting controls `enabled` (default `true`), `text` (`{{chat_id}}` placeholder) and `cooldownMs` (default `600000`).

No database migration is needed.

## [0.2.13] — Unreleased

- Preserve Feishu `union_id` alongside the existing `open_id` and sender name through durable hook events, Codex forwarding, sender prompts, forward-job storage, and persisted group context. Existing authorization, bindings, and outbound delivery continue to use `open_id`.
- Add migration 005 with nullable `sender_union_id` columns for forward jobs and inbound group context. Existing rows remain valid without backfill.
- Remove the runtime MySQL advisory writer lock and its dedicated long-lived connection. Use the existing pool, short transactions, unique idempotency keys, connection-scoped rows and task leases for concurrency and recovery. Legacy `storage.writer` settings remain accepted but are ignored.

The writer-lock removal itself needs no database migration.

## [0.2.12] — Unreleased

- Coalesce streaming assistant-delta persistence per turn item, bound MySQL pool queuing, preserve safe storage error diagnostics through the existing logger fields, and retry transient communication-store polling failures only until the hard 30-second deadline before the existing fail-closed watchdog takes over.

No database migration is needed.

## [0.2.11] — Unreleased

### Fixed

- Extract top-level `files[]` entries from rich-post messages after embedded attachment nodes, deduplicate files already present as nodes, and retain folders as non-downloadable metadata.

## [0.2.10] — Unreleased

- Allow authenticated business events to use bounded dotted type names, so producers can add external event categories such as `form.inbound` without a bridge release.
- Add authenticated `POST /v1/events` and `GET /v1/events/:event_id` endpoints for hook-owned business events. Event jobs use domain-separated request keys and fixed-length hashed message IDs, are idempotent per hook and event ID, use caller delivery with no automatic Feishu card or reply, and steer an active customer-scoped Codex turn when steering is enabled.
- Extend hook configuration with optional inbound bearer, scope-prefix and default-chat references. Business-event prompts retain the independent-system preamble and add a structured event block without embedding request bodies in logs.
- Register authorized Feishu business-card callbacks before acknowledgement when possible, then forward the standard `card.action` Feishu envelope through the selected durable hook with event-ID deduplication, without creating a Codex job or changing the hook configuration schema.

No database migration is needed: the existing connection-scoped forward-job request key and request hash provide event identity and conflict detection.

- Forward every authorized private Feishu message type to Codex with ordered attachment metadata. Stream downloadable images, files, audio, and video into the inbox with a configurable deadline (120 seconds by default) and a hard 32-MiB cap; preserve individual failures in the prompt without blocking the turn.
- Supply downloaded images as Codex `localImage` items while keeping text first. Persist prepared attachment records for recovery so a claimed job does not download the same inbound resource twice. Audio remains a text-path attachment because the 2026-09-19 local probe accepted `localAudio` at the protocol layer but the model could not read the valid PCM WAV content.
- Remove bridge-owned unsupported/download-failure replies and the former `feishu.mediaUnsupportedReply` configuration.
- Align authorized group messages with private inbound media handling. Persist passive-context attachment metadata without downloading it, prepare selected context attachments before current-message attachments at trigger time, and cap context downloads with `codex.groupContextAttachmentLimit` (default 10). Group passive context now defaults to 50 messages within 24 hours.
- No database migration.

## [0.2.9]

- Recover from a lost MySQL writer lock by distinguishing definitive connection/query failures from consecutive probe timeouts, keeping writes independent from slow probes, and requesting a bounded non-zero supervisor restart without clearing or replaying queued work. Persistently unhealthy readiness components use the same fail-closed restart path.
- No database migration.

## [0.2.8] — Unreleased

- Preserve structured Codex usage-limit failures across live notifications and recovery. Show a safe quota-specific Feishu reply without replaying the failed turn; persist the stable error classification without raw provider messages.
- No database or configuration migration.

## [0.2.7] — Unreleased

- Integrate the hook-only business boundary with card-copy prompt isolation and recoverable execution-card progress polling. Card text remains a bridge presentation setting; transient progress-read failures no longer permanently stop card updates.
- Preserve confirmed Feishu rejection handling, internal human-chat delivery, and the removal of public business APIs and top-level client authentication. No database migration or configuration schema change is added.

## [0.2.6] — Unreleased

- Narrow business integration to durable outbound hooks. Remove the public `/v1` run, event, resource, recovery, message-delivery and upload endpoints together with bearer-client configuration and caller-only run policy.
- Preserve the human Feishu bridge path for Codex execution cards, Typing, replies, attachments, stop and fork callbacks, and durable internal recovery. An explicit non-zero Feishu response is a confirmed rejection, while malformed responses, thrown transport errors and timeouts remain unknown and are not automatically resent.
- Remove the obsolete top-level `auth` configuration. Existing configs must delete the entire block, including an empty object, before upgrade; per-hook `hooks[].tokenEnv` remains required. Historical API/system rows and the existing storage schema are not automatically migrated or deleted.

No database migration is added. Validation for this change uses offline fixtures; no real database, Feishu or Codex call was made.

## [0.2.5] — Unreleased

- Recover execution-card progress polling after transient read failures with bounded backoff, safe failure/recovery logs and a temporary degraded-state notice. Lease loss and shutdown still stop observation, while final-answer delivery remains independent.

- Extend per-bot card copy to tool-group/count templates, safe tool details and user-input forms. Validated placeholders are rendered without code evaluation; active tool labels hot-load from sanitized metadata. Existing saved tool entries and default output remain compatible.

- Add opt-in `feishu.cardTextFile`: per-instance execution-card text is hot-loaded from a workspace JSON file, with last-valid fallback for invalid edits. This presentation setting does not alter Codex prompts; card actions, delivery and colors are unchanged.

- Migration 004 scopes five assistant runtime tables by `connection_id`, including their uniqueness, recovery and context indexes. It also prefixes bridge claim indexes with the existing connection owner. Existing bridge rows keep their ownership.
- Existing assistant rows require an explicit `--legacy-connection-id` when migrating. The migration records that decision, backfills with a parameterized update, and resumes only with the same value after partial MySQL DDL. An empty new database needs no legacy value.
- Stop every old writer and back up the bridge schema and matching workspace/outbox before applying 004. The migration holds the old database-level writer lock while upgrading. Startup does not run DDL; real-instance upgrade and provider validation remain separate authorized operations.
- Ordinary Feishu and API runs now send one failed occupied-session notice on the first `CODEX_THREAD_BUSY` result, including turn-start unknown outcomes. Trusted system busy queue behavior remains unchanged.
- A busy Feishu failure card can explicitly fork the bound Codex thread with its stored history and switch that conversation to the verified fork. The operation never replays the failed prompt; native or commit uncertainty is recorded without retry and requires durable-state inspection.
- Optionally map supported Codex user-input requests to a separate Feishu form for the current turn. The integration is disabled by default and requires explicit `codex.requestUserInput: true`; the original sender can submit multiple single-choice or free-text answers once, while secret, expired, resolved or disconnected requests are rejected without fabricated answers or RPC replay.

## [0.2.4] — Unreleased

- Restore the frozen production runtime defaults: the launching user's shared Codex home, a 60-second idle child close, and `shell_environment_policy.inherit=all` within the explicitly constructed child environment.
- Add optional `codex.sharedHome`. A configured value and inherited `CODEX_HOME` must resolve to the same directory; explicit `codex.idleCloseMs: 0` remains supported.
- Restore the frozen production execution-card controller and ordinary reply path. Cards use the original create/patch throttle and fall back to chat-created post or text messages; ordinary replies use the original Markdown conversion, output cap and 3000/1900-character chunks.
- Add optional `feishu.replyAsPost` (default `true`) and `feishu.maxOutputChars` (default `3500`). Persisted legacy unconfirmed card/text effects remain held without replay during this transition.
- Restore the frozen production Typing lifecycle, private-chat image preparation, and direct executor attachment delivery. Typing add is awaited before live execution, add failure uses the configured text fallback, and final cleanup is best effort. Successful attachment sends remove their source file; individual failures retain it and do not block the text reply.
- Restore the original single forward/recovery loop and Codex response-waiter handoff. Ordinary transient failures retry at most three times with a 60-second delay, while authenticated system callers may explicitly retain the trusted busy-wait policy.

No database migration is added. Validation uses offline configuration, lifecycle and synthetic child-process fixtures; no real message or model acceptance was run.

## [0.2.3] — Unreleased

- Keep the owned Codex app-server open while the bridge service remains running by default. This removes the 60-second idle child close without adding keepalive traffic or changing native writer-lock behavior.
- Add optional `codex.idleCloseMs`: `0` disables automatic idle close; a positive value retains the bounded idle timer. Explicit service shutdown and unexpected child-exit handling remain unchanged.

No database migration is added. Validation uses synthetic child-process and lifecycle fixtures; no real message or model acceptance was run.

## [0.2.2] — Unreleased

- End a manual Feishu request on its first confirmed pre-admission `CODEX_THREAD_BUSY` result and deliver one explicit occupied-session notice without replacing the binding or replaying the request.
- Retain 60-second waiting only for a validated persisted caller/namespace system binding. Other retryable admission failures remain bounded to three claims by default; configuration enforces the original 10-second retry-delay floor.
- Keep known-turn observation, unconfirmed start and unresolved steer confirmation in `held` with their native/intent identity. Reuse the waiting card and keep Typing off between system probes.
- Preserve sanitized RPC method, stable code, phase and bounded retry facts through the service logger and optional reporter.

No database migration is added. Validation is offline with synthetic app-server, Feishu and clock fixtures; no real message or model acceptance was run.

## [0.2.1] — Unreleased

- Use the Codex app-server protocol value `auto_review` for `approvalsReviewer` on thread start, thread resume and turn start. The previous `auto` value is not part of the current protocol enum and caused an existing binding to fail before native turn admission.
- Classify rejected Codex RPCs with a stable bridge error code and RPC method while keeping provider error text out of logs and persisted public state. A rejected turn-start remains conservatively unconfirmed.

No schema or configuration migration is required. Validation uses a schema-strict synthetic app-server; no real message or model turn is part of this patch's acceptance.

## [0.2.0] — Development snapshot

- Replace the generation worker service path with one leased forward worker backed by the production-derived forward, inbound-message and message-event tables in new migrations 002–003. Persist native start/binding, reply-pending delivery, bounded group context and recovery; a known turn is observed without resubmission and an unknown native outcome is held.
- Run one Feishu bot/WebSocket and one Codex app-server/executor. Keep hook/outbox communication independent from Agent routing. Authorized groups use `capabilities` (`bridge`, `hook`, or both); hook filtering does not depend on Agent mention/member triggers.
- Add `executionNamespace` and `deliveryMode` to idempotent run registration. Caller delivery stores `rawAnswer`, safe progress and controlled attachment resources without automatic cards, Typing or replies. Bridge delivery persists cards, Typing, stop and per-item reply receipts, including explicit unknown outcomes that are not automatically resent.
- Preserve ordinary run/event pagination through a safe public projection. Generation-ledger attempt reads and recovery/reset writes return `409 unsupported_execution_model`; existing recovery records remain readable within their original authorization scope.
- Keep business polling, lark-cli reads, scheduling, message-ID deduplication and specialized cards in the business producer. Bridge hooks remain lightweight event notifications.

This is development metadata, not a tag, published release, deployment, production replacement or completed Kosbling producer migration. Validation uses synthetic providers and a disposable MySQL 8.4 container; no real Feishu or Codex acceptance was run.

Database migrations 002 and 003 target the bridge's own schema. They do not convert or transparently upgrade the Kosbling production/P schema. The configuration schema remains 1, but group authorization now validates optional `capabilities`; review existing hook-only groups before using this version.

## [0.1.1] — 2026-09-13

- Restore final Agent replies and existing input-rejection notices as Feishu JSON 2.0 cards, preserving Markdown, bounded multipart delivery and durable outbox ordering. This does not add dynamic progress cards, stop callbacks or new native-failure notification semantics.
- Add explicit `codex.proxyEnv` references to configure HTTP/SOCKS proxy variables only for the Codex child. Feishu SDK and bridge HTTP requests retain their existing environment.

No database migration or config-schema bump is needed; the proxy mapping is optional. Version 0.1.0 and its tag remain immutable. This batch does not complete the wider production-feature migration or imply production acceptance.

Validation uses targeted offline card/adapter/core/proxy tests and version/syntax checks. A pre-existing media test fails with `finish is not a function` on both the 0.1.0 baseline and the card branch; this batch does not claim a clean full-suite run. Real-platform validation of these changes remains pending.

## [0.1.0] — 2026-09-13

Initial independent Feishu + Codex bridge source release candidate. This entire extraction batch shares one version.

- Explicit configuration, scoped authenticated task/chat APIs and static hooks.
- Durable MySQL inbox/jobs/outbox, session fencing, first-receipt catchup, active-turn guidance and audited recovery.
- Private image input, Agent-produced media delivery, controlled cleanup and resource retirement.
- Idle/rules/archived thread replacement and structured lifecycle/error reporting.

Validation is bounded: earlier isolated MySQL tests used synthetic providers. Latest retirement paging and selected recovery paths still await local integrated validation. No real bot/model acceptance or production replacement is implied. See [local validation](docs/local-validation.md).

Schema migration: initial `001-initial.sql` for a new dedicated database. Configuration schema: 1. No automatic migration of Kosbling business data. License selection remains pending; npm publication is disabled.
