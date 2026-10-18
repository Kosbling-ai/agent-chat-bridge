# Changelog

## [0.2.31] - 2026-10-18

- Forward native `action.form_value` as optional normalized `event.formValue` to business hooks. Accept JSON objects up to 32 KiB, 256 nodes and depth 6; reject invalid data without ingestion. No form text is added to logs.
- Include canonical form content in fallback event identities while preserving old identities for events without forms. Provider event IDs remain authoritative.
- For `kind: feedback`, acknowledge only durable registration, explicitly pending validation and processing; registration failure or timeout never claims success. Adapter-level business errors/timeouts use submission wording instead of stop-request wording. Existing action toasts remain unchanged.

This release includes 0.2.30 storage recovery and query indexes; migration 006 is still required when upgrading from 0.2.29 or earlier. No additional migration beyond 0.2.30.

## [0.2.30] - 2026-10-18

Requires database migration 006 before restart (index-only, online). No config `schemaVersion` change, no new dependency or environment variable. One new optional key, `storage.claimTimeoutMs`.

### A. Storage outages degrade instead of restarting the bot (absorbed from the unreleased staging 0.2.26/0.2.27 work)

- Transient storage failures (`store_unavailable`, `store_contention`, `store_timeout`, and claim-stage `commit_unknown`) keep the communication worker running in a visible degraded state with capped exponential backoff (1 s doubling to 30 s) and automatic recovery. The 0.2.12–0.2.29 rule that turned six failures or 30 seconds of failures into an unhealthy worker and a process exit is removed. `worker_poll_failed` is logged on the first failure, on a stage change and then at most every 5 minutes; once the degradation has lasted 5 minutes those periodic lines are logged at `error` level (still at most one per 5 minutes), so error reporting sees a long outage. `worker_recovered` follows two successful claim stages. Deterministic driver errors (`ER_PARSE_ERROR`, `ER_BAD_FIELD_ERROR`, `ER_NO_SUCH_TABLE`, `ER_KEY_DOES_NOT_EXITS`, `ER_ACCESS_DENIED_ERROR`, `ER_DBACCESS_DENIED_ERROR`, `ER_TABLEACCESS_DENIED_ERROR`, `ER_WRONG_VALUE_COUNT_ON_ROW`, `ER_BAD_NULL_ERROR`, `ER_DATA_TOO_LONG`) now map to the new non-transient code `store_invalid` instead of `store_unavailable`: the worker stops and the watchdog restarts the process, as in 0.2.29. Every other driver or transport error still counts as `store_unavailable`.
- `/health/ready` reports transient storage problems as not ready (HTTP 503) with `degraded: { store, workers }`; the process stays alive. The `runtime.unhealthyExitMs` watchdog now restarts only for fatal store errors (for example a schema ledger mismatch) and stopped workers. `storage_health` logs `degraded`, `recovered` and `failed` transitions.
- A claim whose COMMIT acknowledgement is lost is reconciled by its original row IDs and lease token under row locks before any other claim (`storage_claim_recovery` `recovered` / `not_committed` / `empty`). Main's 0.2.24 behaviour (claim-stage `commit_unknown` is retryable) is kept.
- New optional `storage.claimTimeoutMs`: deadline of the background hook and outbox claims, default 15000 ms, allowed 1000–30000 ms (`invalid_storage_claim_timeout` otherwise); it was 1800 ms. It also bounds the Codex session reads that gate a turn (see B). Ingress and the other bridge stores keep 1800 ms.
- Idle communication polling backs off from 100 ms to 1 second and returns to 100 ms after claiming work. On an idle bot new hook and outbox work is picked up within about one second instead of 100 ms.
- A forward task retries a transient lease-renewal failure until its last confirmed lease ends (`forward_lease` `degraded` / `recovered`) instead of losing the lease on the first failed renewal. A definitive lost or expired lease still interrupts the task.
- A storage failure after a hook answered 204 or after a Feishu send is no longer turned into an immediate hook retry or delivery-failure record; the durable lease and platform UUID reconcile it.
- Storage timing diagnostics: `storage_operation` events (`storage_operation_slow` at 500 ms or more, `storage_operation_failed`) with pool wait, BEGIN, operation, COMMIT and rollback durations, deadline overshoot and the MySQL connection ID, at most 20 per minute; `storage_snapshot` every 60 s with event-loop delay, process and host load, pool counts and allowlisted MySQL global counters. No SQL, parameters, content or credentials are logged. Unlike the staging draft there is no `setup_ms`, because session setup no longer runs per operation (see B).
- `worker_poll_failed` and `storage_health` carry safe `reason`, `error_code`, `errno` and `sql_state` fields. The docs add macOS `ProcessType=Standard` guidance for the bridge and its MySQL.

### B. Indexes, SQL and connection pool

- Migration 006 adds four indexes online: `assistant_codex_events.idx_assistant_codex_events_message`, `assistant_codex_forward_jobs.idx_forward_status_finished`, `bridge_jobs.jobs_conversation_open`, `bridge_outbox.outbox_unknown_recent`. Matching pre-existing indexes are skipped; a same-named index with another definition stops the migration. 0.2.30 does not start before 006 is applied; a still-running 0.2.29 process reports `store` not ready once the ledger records 006.
- Hook and outbox claims select IDs first and read full rows only for claimed work. Per idle claim tick: 6 statements instead of 9, still 2 transactions, about 0.3 KB instead of 3.5 KB of result data. With the idle backoff an idle bot sends about 6 claim statements per second instead of about 85 (about 8 instead of 90 including the 500 ms readiness probe).
- The hook-ordering check probes each non-terminal status on `jobs_conversation_open` instead of scanning the conversation's hook history with `NOT IN`. Results are unchanged while the code writes only the 8 known statuses; a test fails when a new status write appears.
- The outbox claim runs a pending branch and a recent-uncertain branch (`FORCE INDEX (outbox_unknown_recent)`); uncertain sends older than 55 minutes are no longer scanned and locked on every poll. Eligibility and order are unchanged.
- Expired send leases are reclassified as `unknown` at most every 5 seconds per process (at once after a reconciled claim found its own lease expired), so such a send can be retried up to 5 seconds later than before.
- `GET /health/tasks` forces `idx_forward_status_finished` and reads only the requested window instead of every failed job.
- Group-context bookkeeping after a turn (`markForwarded`) uses two unique-key updates instead of one `OR` update that could scan and lock all of the bot's inbound rows.
- `SET SESSION innodb_lock_wait_timeout = 1` runs once per physical connection instead of before every operation; it now also covers the Codex session store's connections, whose row-lock waits therefore end after 1 s instead of the server default 50 s. A connection that arrives only after an operation's deadline is returned to the pool instead of being closed.
- Codex session-store SQL had no deadline before 0.2.30 (raw pool queries). Now the reads that gate a turn (binding, accepted-message check, steer events, injection marker) use `storage.claimTimeoutMs` (15000 ms by default), execution-card progress reads use 1800 ms, and binding and event writes use 10 s. All of them raise normalized `store_*` errors; for example a write's `ER_LOCK_WAIT_TIMEOUT` surfaces as `store_contention`.
- A forward task whose execution fails with `store_timeout`, `store_unavailable` or `store_contention` before its turn is submitted (for example a slow binding or receipt read) is retried after `retryDelayMs` (up to `maxAttempts`) instead of failing at once with the generic failure reply. Once the executor is about to send `turn/start` or attaches to the still-running turn of the same message (takeover), or after execution returned, such a failure is not retried: the job ends with the failure reply and the turn is never run again (the executor's receipt check alone cannot prove the turn ran: it sees only a non-empty final answer on the binding's current thread). A turn that completed always returns its answer: if its `assistant-final:` receipt or the binding touch cannot be stored, the executor logs `persist_final_answer` `failed` (warning, with `stage` and `error_class`) and the answer is still delivered. In 0.2.29 `store_timeout` was retried in that position through the generic `timeout` match; that retry is removed. `commit_unknown` is never retried this way.
- Realtime Codex event writes use at most two pool connections per process and queue the rest in order. When more than 200 best-effort events (`public:` progress and `agent-delta:` streamed text) are queued, the oldest of them are dropped and counted in a `codex_event_write` `dropped` warning (`code: codex_event_queue_full`, `dropped_events`, `dropped_events_total`, `queued_events`; at most one line per minute). Receipts (`assistant-final:`, `error:`, `user:`, `user-steer-*`) and every other key are never dropped, and a released slot goes to the oldest of those waiting writes before any queued best-effort event (best-effort events stay in order among themselves). A dropped progress event can leave a gap in the execution card; a dropped streamed-text rewrite is superseded by the next one or by the final answer. A streamed agent message rewrites its full text at most every 500 ms per item, and the last text is always written.
- History catch-up writes an idle conversation's cursor once per run instead of twice; conversations seen for the first time keep the previous behaviour.
- The readiness probe sends one statement instead of two. The explicit `migrate` command may run up to 15 minutes and waits at most 10 seconds for a metadata lock during 006. When it fails with a storage error it now logs that code (for example `"code":"store_contention"` for a metadata-lock timeout, `"code":"store_invalid"` for a missing privilege) instead of `startup_failed`, and its success line carries `version` and `applied`.

### C. Restart recovery crash

- Resuming a turn that Codex already reports interrupted or failed while the caller has stopped waiting (lease lost during shutdown) no longer exits the process with an unhandled `CODEX_TURN_INTERRUPTED` / `CODEX_TURN_FAILED` rejection (0.2.29 crash). The terminal state is persisted; the next attempt replies with the existing interrupted (`执行已停止。`) or failed message and starts no new turn.

Tests: the integration suites were run one by one on a disposable local MySQL 9.6. Six stale integration tests were aligned with behaviour already on main (writer lock removed in fe674e3, agent jobs no longer created by `acceptInbound` since 46f87d5, MySQL 9.x default `EXPLAIN` format, stricter store and outbound-media inputs); four legacy `src/core/runtime.mjs` suites still fail exactly as on 0.2.29.

## [0.2.29] - 2026-10-13

- Recover persisted `CODEX_OBSERVATION_LOST` receipts by observing the exact original native turn. A restart no longer turns an unknown observation into a cached `CODEX_TURN_FAILED`. Interrupted turns retain `CODEX_TURN_INTERRUPTED`; completed turns return their original result; active turns are observed without starting, steering or interrupting another turn. Missing or unreadable turns remain retryable/unknown.
- New observation-loss receipts retain the original start time and use `turnStatus: unknown`. Old receipts incorrectly marked failed are reconciled by error code. Duplicate terminal results preserve interruption and server-overload classifications.
- No schema/config migration or dependency change. Existing terminal forward jobs are not automatically replayed or rewritten. Correct historical classifications only after checking native turn evidence and preserving an audit copy; an interrupted job is not proof of completed business effects.
- Validation: executor shutdown/restart tests cover interrupted, failed, completed, active, missing and unreadable native turns, with no duplicate turn admission.

## [0.2.28] - 2026-10-11

- Add the optional per-group key `routing.groups[].reply` for `bridge` groups: `mode` (`"card"` default, or `"text"`), `ack` (`"none"` default, or `"reaction"`, text mode only) and `ackEmoji` (Feishu `emoji_type` matching `[A-Za-z0-9_]{1,80}`, default `OnIt`, only with `ack: "reaction"`). Without the key, or with `mode: "card"`, behaviour, outbound requests, stored job state and logs are those of 0.2.27.
- `mode: "text"`: no execution card and no processing Typing reaction or `processingFallbackText` for that group's human turns. The final answer is a reply to the triggering message (`reply_in_thread: false`, deterministic `uuid`): a `text` message for one plain line (a bare URL included), otherwise a `post` (mentions, line breaks, Markdown links or formatting), in 3000-character chunks that all reply to the same message. Failed and interrupted turns send exactly one `text` line of at most 200 characters. A `silentReply` token answer sends nothing (`result.silentReply.card = "none"`).
- Text mode accepts every at spelling `<at id|user_id|open_id = "ou_x">Name</at>` (quotes optional, name optional) and `@{ou_x}`, also inside code blocks, and sends a post `at` element with `user_id` and `user_name`; any remaining open_id-like token (`ou_` plus at least 8 of `[A-Za-z0-9_-]`, not inside a longer word) in post text, link text, text messages and the failure line is replaced with `@成员`. The card-mode fallback conversion is unchanged.
- Only a reply rejected because the triggering message was recalled (platform code `230011`) is created in the chat once (`forward_reply` `reply_rejected`, `code` `reply_target_gone`). Other rejections are logged once as `forward_reply` `reply_failed` with the real `code`, `platformCode` and `stage`, and retried as replies; an unconfirmed reply is retried as a reply only.
- The style is recorded on the job as `result.replyMode` when its turn starts (groups with the key only) and reused by retries, recovery and delivery; the job store accepts the feedback key `replyMode`. A job that already has an execution card and no recorded style finishes on that card; business-event jobs and private chats are unchanged.
- `ack: "reaction"` adds one reaction (`ackEmoji`) to the triggering message when its turn starts and never removes it; a failure logs `reply_ack` `failed` and the turn continues.
- Validation codes: `invalid_group_reply_fields`, `invalid_group_reply_mode`, `invalid_group_reply_ack`, `invalid_group_reply_ack_emoji`, `group_reply_ack_requires_text_mode`, `group_reply_ack_emoji_requires_reaction`, `group_reply_ack_emoji_conflicts_with_processing_reaction`, `group_text_reply_requires_silent_reply` (a text-mode group without effective `silentReply.tokens`), and `group_context_requires_bridge` for a hook-only group with `reply`. `check-config` reports them.
- `trigger: "all"` is unchanged and now documented with text replies: every authorized human message starts a turn; bot, app and self messages never do; messages older than `codex.maxEventAgeMs` (default 10 minutes) never do, including history catch-up; `replyTriggers` and passive context do not apply to triggering messages.

No database migration, no config `schemaVersion` change, no new dependency or environment variable. The only storage change is the accepted `replyMode` key inside the existing `result_json`.

## [0.2.27] - 2026-10-11

- Add the optional per-instance key `codex.permissionProfile`: the id of a named Codex permission profile (`[permissions.<id>]` in the Codex home `config.toml`, or a built-in such as `:workspace`). The value is trimmed and must be 1–128 characters matching `^:?[A-Za-z0-9][A-Za-z0-9._-]*$`, otherwise `invalid_codex_permission_profile`. It has no default.
- With the key set, `thread/start`, both `thread/resume` paths and `thread/fork` send `permissions: "<id>"` and no `sandbox` key; `turn/start` is unchanged (no `permissions`, no `sandboxPolicy`). Each of those responses must report `activePermissionProfile.id` equal to the id; otherwise the request fails with `CODEX_PERMISSION_PROFILE_MISMATCH` and the thread is not bound, loaded, given a turn or committed as a fork (fail-closed; the unused fork is recorded as the fork target). The error message is the fixed text `permission profile mismatch`, so no id can make the failure retryable; the ids are error fields and log fields. `/health/tasks` counts the failure under that code. Every check logs `thread_start`, `thread_resume` or `thread_fork` with `rpc_method`, `permissionProfile` and `activePermissionProfile` (`info` `succeeded`, or `error` `failed` with the code); the logger accepts these two fields.
- With the key set, the app-server child starts without `-c sandbox_workspace_write.network_access=…` (the profile's network table applies; a built-in id such as `:workspace` follows Codex's built-in network default). The other launch arguments are unchanged, and the `app_server_start` line carries `permissionProfile`.
- Validation errors: `codex_permission_profile_conflicts_with_sandbox` and `codex_permission_profile_conflicts_with_network_access` when `codex.sandbox` or `codex.networkAccess` appear next to the key, `group_codex_sandbox_conflicts_with_permission_profile` for any `routing.groups[].codex.sandbox`. Group `approvalPolicy`, `approvalsReviewer` and `cwd` overrides stay allowed. `check-config` does not ask Codex whether the profile exists.
- Requires codex-cli 0.153.4 app-server experimental API (`permissions`, `activePermissionProfile`; the bridge already sends `experimentalApi: true`) and a Codex home `config.toml` with `default_permissions = "<id>"` and the `[permissions.<id>]` tables.
- Failure signals (codex-cli 0.153.4):
  - An undefined id is rejected by Codex and logged as `rpc_request` `rejected` `CODEX_RPC_REJECTED`, not as a mismatch.
  - `CODEX_PERMISSION_PROFILE_MISMATCH` means Codex accepted the request but did not apply or report the profile.
  - A missing `default_permissions` next to profile tables gives the bridge no error: the profile is applied because the bridge sends `permissions`. Codex's startup `configWarning` is not logged by the bridge. Check the Codex home with `codex sandbox -P <id> -C <codex.cwd> -- /bin/echo ok` and `codex features list` (see [runtime](docs/runtime.md#checking-the-codex-home-and-reading-failures)).

No database migration, no config `schemaVersion` change, no storage change and no new dependency. Without `codex.permissionProfile` thread, turn and launch parameters and log output are byte-for-byte those of 0.2.26.

Operator checklist (only for an instance that adopts a profile; other instances sharing the checkout behave as on 0.2.26 after their next restart):

1. Deploy (fast-forward) 0.2.27 first. Instances without the key behave as on 0.2.26, and a restart during the next steps works with either the old or the new private configuration.
2. Define the profile in that instance's Codex home `config.toml`: `default_permissions = "<id>"` and `[permissions.<id>.filesystem]` / `[permissions.<id>.network]`; remove `sandbox_mode` and `[sandbox_workspace_write]` from that file. From `codex.cwd` with the same `CODEX_HOME`, check that `codex sandbox -P <id> -C <codex.cwd> -- /bin/echo ok` prints `ok` and `codex features list > /dev/null` exits 0. Do steps 2–5 in one window.
3. Back up the private configuration: `cp -p <bridge.json> <bridge.json>.bak-0.2.27-<timestamp>`. In the private bridge.json remove `codex.sandbox`, `codex.networkAccess` and any group `codex.sandbox`, and add `"permissionProfile": "<id>"` to `codex`.
4. Run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>` with the 0.2.27 code; it must log `check_config` `succeeded`.
5. Restart only that bridge: `kill -TERM <bridge-pid>` and let its supervisor start it again.
6. Verify:
   - `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready`.
   - The log shows `app_server_start` with `permissionProfile` once Codex starts. After a message it shows a `thread_start` or `thread_resume` line with `status` `succeeded` and `activePermissionProfile` equal to the id.
   - `rpc_request` `rejected` `CODEX_RPC_REJECTED` on thread requests usually means an undefined id.
   - `CODEX_PERMISSION_PROFILE_MISMATCH` means Codex did not apply the profile; remove the key and check the Codex version.
7. Rollback: restore the backup (and the previous `config.toml`), run `check-config`, then `kill -TERM <bridge-pid>` again. To return to 0.2.26, remove `codex.permissionProfile` first: 0.2.26 rejects the key with `invalid_codex_fields`.

## [0.2.26] - 2026-10-09

- Add the optional per-instance private-chat admission callback `routing.privateAdmission` (`url`, `tokenEnv`, `denyText` required; `timeoutMs` 100–5000, default 1000; `allowCacheMs` and `denyCacheMs` 0–86400000, defaults 300000 and 60000; `unavailableText` defaults to `denyText`). Before any Store write, a human private message from a sender not in `privateUserIds` is checked with `POST <url>`, `Authorization: Bearer <env[tokenEnv]>` and the body `{"connectionId","chatId","sender":{"openId","unionId"|null,"userId"|null}}`. HTTP 200 with a boolean `allowed` decides; any other status, a timeout, a network error or invalid JSON is "unavailable" and refuses the message (fail-closed).
- Results are cached per open_id in memory (admitted for `allowCacheMs`, refused and unavailable for `denyCacheMs`); concurrent checks for one sender with the same known union_id share one request. The union_id of live events is remembered; a history catch-up event without one first reads the sender's latest non-empty `sender_union_id` from this bot's forward jobs in the same chat (new read-only Store method `findSenderUnionId`, at most once a minute per sender). Live requests stay inside the 2000 ms ingest deadline minus 250 ms.
- A refused message is not stored, creates no hook job, starts no Codex thread and does not make the private chat known to history catch-up. A live refusal gets one direct reply (`denyText` or `unavailableText`) per unexpired cache entry, without retry or outbox row and never while the bridge is stopping; catch-up refusals get none. Only explicit endpoint denials (reason other than `no_union_id`) are remembered per message ID and never admitted later; unavailable and `no_union_id` refusals are checked again by history catch-up, so private messages sent by admitted people during an outage are processed once the endpoint answers. A person writing to the bot for the first time during an outage must resend.
- Recall events carry no chat type or operator and are not checked; on an admission-configured bot the recall of an explicitly denied message is dropped without a Store write (`reason: "recalled_refused"`), other recalls are stored as before. Private execution-card actions follow the cached decision; the card handlers now pass the job's recorded `senderUnionId` to authorization.
- Each real request and each refusal logs one `info` line with `operation: "private_admission"`, `decision`, `reason`, `cached`, the first six characters of the open_id and the `message_id`; the logger accepts the new fields `decision`, `cached` and `openId`. No token, union_id or message text is logged.
- Validation errors: `invalid_private_admission_fields`, `invalid_private_admission_url`, `invalid_environment_reference`, `invalid_private_admission_timeout`, `invalid_private_admission_cache`, `invalid_private_admission_text`, and `private_admission_conflicts_with_allow_all` when `allowAllPrivateUsers` is `true`. Startup fails with `required_environment_missing` when the token variable is missing or empty; `check-config` does not resolve it.

No database migration, no config `schemaVersion` change and no new dependency. Without `routing.privateAdmission` behavior and log output are unchanged.

Operator checklist (use the real values only in the private bridge.json and the supervisor's secret store):

1. Deploy the business endpoint first and give the bridge process the token under the `tokenEnv` name. Verify only that the variable is present; never print it.
2. Back up the private configuration: `cp -p <bridge.json> <bridge.json>.bak-0.2.26-<timestamp>`.
3. Set `"allowAllPrivateUsers": false` (or remove it) and add the `privateAdmission` object to `routing`.
4. Deploy 0.2.26 and run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>`; it must log `check_config` `succeeded`.
5. Restart only that bridge: `kill -TERM <bridge-pid>` and let its supervisor start it again. Instances without `privateAdmission` sharing the checkout behave as on 0.2.25 after their next restart.
6. Verify: `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready`; the log has no `required_environment_missing`. A private message from an admitted person logs `private_admission` `allow` and is answered; one from a person who is not admitted logs `deny` and receives `denyText` once, with no execution card.
7. Rollback: restore the backup, run `check-config`, then `kill -TERM <bridge-pid>` again. To return to 0.2.25, remove `privateAdmission` first: 0.2.25 rejects the key with `invalid_routing_fields`.

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
