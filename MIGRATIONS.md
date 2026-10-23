# Versions and migrations

Application version: `0.2.34`

## 0.2.31 business-card form transport

No additional database migration, configuration change, dependency change or business policy beyond 0.2.30. When upgrading from 0.2.29 or earlier, apply migration 006 and follow the 0.2.30 checklist below before starting 0.2.31. Existing durable JSON payloads gain optional `formValue`. Field validation, actor authorization, card-version checks and business processing remain the hook consumer's responsibility; the bridge acknowledgement confirms registration only.

1. Run `npm test`, `npm run check` and `npm run version:check` in the release checkout.
2. Deploy the reviewed release through the instance supervisor's supported restart lifecycle; do not start a second WebSocket owner. Confirm database connectivity and readiness before acceptance.
3. Submit a synthetic form against an authorized hook and verify durable event form values, actor/message identity, consumer receipt and exact-replay deduplication. Verify a registration failure does not show success. Never use a real business decision as a smoke test.
4. Roll back via the supervisor to 0.2.30 if needed; no stored-state reversal is required. Old consumers may ignore the optional field; roll back any dependent feedback UI with the bridge so submissions are not silently dropped.

Version 0.2.30 adds migration 006 (four secondary indexes, built online; no table, row or existing index changes) and must be migrated before its processes start. The config `schemaVersion` stays 1; the only new key is the optional `storage.claimTimeoutMs` (default 15000 ms, 1000–30000). Transient storage failures now leave the bridge running in a degraded state instead of restarting it. Two instances that share one bridge database run the migration once. See [0.2.30 query indexes and degraded storage](#0230-query-indexes-and-degraded-storage).

Version 0.2.29 does not add a database or configuration migration. It reconciles disconnected Codex turns before classifying them.

Version 0.2.28 does not add a database migration, change the config `schemaVersion`, change storage or add a dependency. It adds the optional, backward-compatible per-group key `routing.groups[].reply` (`mode` `card`/`text`, `ack`, `ackEmoji`); groups without it behave as before. See [0.2.28 group text replies](#0228-group-text-replies).

Version 0.2.27 does not add a database migration, change the config `schemaVersion`, change storage or add a dependency. It adds the optional, backward-compatible key `codex.permissionProfile` (a named Codex permission profile per instance); configurations without it behave, and send Codex the same parameters, as before. See [0.2.27 named Codex permission profile](#0227-named-codex-permission-profile).

Version 0.2.26 does not add a database migration, change the config `schemaVersion` or add a dependency. It adds the optional, backward-compatible routing key `routing.privateAdmission` (a private-chat admission callback); configurations without it behave as before. See [0.2.26 private-chat admission callback](#0226-private-chat-admission-callback).

Version 0.2.25 does not add a database migration or change the config `schemaVersion`. It adds the optional per-group working directory `routing.groups[].codex.cwd` and announces the result-file directory as an absolute path; see [0.2.25 per-group Codex working directory](#0225-per-group-codex-working-directory).

Version 0.2.24 adds bounded retries only for claim-stage `commit_unknown`. Unconfirmed claim results are discarded; persisted leases fence work, and existing expiry/idempotency rules apply. No business run is replayed by this retry. Persistent errors still exhaust the six-attempt/30-second budget and trigger health recovery. No database or configuration migration. Upgrade by deploying this version and restarting the bridge through its supervisor during an idle window; verify readiness and worker diagnostics. Roll back to 0.2.23 through the same lifecycle; no stored state is changed.

Version 0.2.23 does not add a database migration. It adds the optional card text key `commandTitleTemplate` (default `{name}`); the default output is unchanged. There is no configuration format change; see the note below.

Version 0.2.22 does not add a database migration. It compacts the execution-card layout: the answer (or latest progress while running) and the status line stay visible, and the process folds into at most one collapsed, non-nested panel. There is no configuration change, no card text key was removed or renamed (one optional key, `processGroup`, was added), and stored card state keeps its format; see the note below.

Version 0.2.21 does not add a database migration. It adds the optional per-group `routing.groups[].codex` override (`approvalPolicy`, `approvalsReviewer`, `sandbox`) for `bridge` groups. It applies to the group's human thread and to business-event threads whose hook `inbound.defaultChatId` is that group. Without the field nothing changes; see the enable and rollback steps below.

Version 0.2.20 does not add a database migration. It adds the optional `routing.silentReply` object (`tokens` default `[]`, `card` default `"delete"`) and the optional per-group `routing.groups[].silentReply` override. With the defaults nothing changes except that hooks no longer receive recalls of the bot's own recorded messages; see the upgrade note below.

Version 0.2.19 does not add a database migration. Optional group `replyTriggers` defaults to `false`; confirmed bot text and execution-card message IDs are recorded in the existing inbound-message table for indexed reply lookup. Unknown parent and root IDs are checked through bounded Feishu message reads.

Version 0.2.18 does not add a database migration. `routing.groups[].allowMentionAll` is optional and defaults to false. Reply mentions are rendered as Feishu post elements; text-mode replies with valid mentions are sent as posts.

Version 0.2.17 does not add a database migration. Business-card callback times are normalized from seconds, milliseconds, microseconds or nanoseconds before forwarding. Existing card-action event IDs and deduplication keys are unchanged.

Version 0.2.16 does not add a database migration. Group prompts gain a message identity block, passive messages store `parentId`/`rootId` in the existing content JSON, and injection fingerprints use the existing `assistant_codex_events` unique key. The new optional `routing.groups[].instructionFiles`, `instructionText`, `instructionMode` and `replyContext` fields default to absent; group triggers that reply to a message now make one additional bounded Feishu message read; existing configurations keep working unchanged. Business-event threads now receive the `【独立系统任务】` preamble only on the first turn or after it changes, so producers must not rely on it appearing in every turn.

Version 0.2.15 adds no database migration or configuration change. It adds the read-only `GET /health/tasks` endpoint.

Version 0.2.14 does not add a database migration. It adds the optional `routing.unlistedGroupReply` configuration (enabled, text, cooldownMs); existing configurations keep working with the defaults.

Version 0.2.13 adds migration 005. It adds nullable `sender_union_id` columns to `assistant_codex_forward_jobs` and `assistant_inbound_messages` so the bridge can preserve Feishu's cross-application identity alongside the existing `sender_open_id`. Existing rows are not backfilled and an absent union ID remains valid. Stop bridge writers and take the dedicated bridge-schema backup required by the standard migration procedure before applying it; rollback requires restoring that pre-migration backup because the prior binary cannot accept schema ledger version 5.

Version 0.2.12 does not add a database migration. It changes only runtime connection-pool and worker-retry behavior.

Version 0.2.11 does not add a database migration. Rich-post attachment extraction changes no configuration or stored schema.

Version 0.2.10 does not add a database migration. The Events API reuses the existing forward-job request key and request hash for hook-scoped idempotency.

Version 0.2.9 does not add a database migration.

`VERSION` is the application release version. Keep package.json, both root package-lock versions, README and CHANGELOG aligned; `npm run version:check` and `npm run check` enforce this. Use an explicit stable `MAJOR.MINOR.PATCH` number, with 0.x denoting ongoing initial development. Bump once per delivery batch, not per fix. Once released, do not move its tag or rewrite its versioned history; subsequent fixes get a new release. Documentation-only corrections need no empty migration or release bump.

Application versions, config `schemaVersion` and numbered database migrations are separate contracts. Changing one does not mechanically increment the others. Startup validates the DB migration ledger and checksum; only the explicit migrate command performs DDL. Applied SQL is immutable. After this initial release, schema changes require a new numbered forward migration and corresponding runner support, not edits to 001. MySQL DDL is not transactionally reversible; do not promise an automatic down migration.

## 0.2.32 large Codex RPC frames

No database/config migration or dependency change. Queue records, native turn IDs, permissions and retry/admission rules are unchanged. Memory limits are not raised. Full-history responses can still require substantial memory; this release removes the quadratic framing overhead, not their payload size.

Production host checklist (Bruce):

1. In `/Users/kosbling/kosbling-automation/agent-chat-bridge`, run `git fetch origin`, then `git merge --ff-only origin/main` after the scoped release is reviewed, checked and authorized for deployment. Run `npm run check`.
2. Capture `/Users/kosbling/kosbling-automation/kosbling-auto/logs/status.json` and inspect both Bridge logs and active forward jobs. Defer planned restart while a native turn is active. An existing pre-admission timeout loop can recover using the same persisted job; never delete/reset jobs, change session bindings, or replay business operations.
3. Only from the host's main checkout, send `kill -TERM <bridge-pid>` to the verified `agent-chat-bridge` or `agent-chat-bridge-auth` PID. This is the supported supervisor restart: Bridge shuts down gracefully, exits 0 and `kosbling-auto` restarts that enabled child. Do not restart the runtime or signal unrelated PIDs. An instance already in its automatic restart loop may load this release on its next restart without an extra signal.
4. Check `curl --noproxy '*' -fsS http://127.0.0.1:18832/health/ready` and port `18833` on this host (verify configured ports first). Observe several former restart cycles, stable Bridge PIDs, bounded RSS and no repeated `rpc_request/timed_out` or `codex_executor/restart_required`. Compare other long-running PIDs with the baseline. Verify any pending job retains its identity and receives at most one native admission; do not send a synthetic business request.
5. New diagnostics: `rpc_request/timed_out` includes `rpc_method`, `CODEX_RPC_TIMEOUT` and `durationMs`; `memory_guard/restart_pending` includes `CODEX_MEMORY_LIMIT`, `rss_bytes`, `heap_used_bytes`, `rss_limit_bytes`, `heap_limit_bytes`. The eventual idle restart also retains the fixed code.

Rollback: restore the previously recorded Bridge commit and repeat the targeted restart in an idle window. No data rollback or schema operation is required. Rolling back restores the large-history framing bug.

## 0.2.30 query indexes and degraded storage

Migration `006-query-indexes.sql` adds `idx_assistant_codex_events_message`, `idx_forward_status_finished`, `jobs_conversation_open` and `outbox_unknown_recent` with `ALGORITHM=INPLACE, LOCK=NONE`. Reads and writes continue while the indexes build; on the production USB SSD the build can take tens of seconds. The migration waits at most 10 seconds for each table's metadata lock (a long open transaction makes it fail instead of queueing every reader behind it); rerunning it is safe. It skips an index that already exists with the same definition and stops with `schema_version_mismatch` if a same-named index has another definition. 0.2.30 refuses to start until the ledger records version 6, and a 0.2.29 process that is still running reports `store` not ready once version 6 is recorded; its `runtime.unhealthyExitMs` watchdog (30 s by default) then exits it with `runtime_unhealthy`. Behaviour changes are listed in the [changelog](CHANGELOG.md) and [runtime notes](docs/runtime.md#query-indexes-and-polling-cost-0230).

Upgrade (two instances sharing one database; run the migration once, then restart both). Run steps 3 to 6 back-to-back: after step 3, any unplanned restart of a 0.2.29 process (a crash, or its unhealthy exit) starts 0.2.30 code against the version-5 ledger, which fails at startup with `schema_version_mismatch` and keeps restarting until step 5 has succeeded.

1. Pick an idle window: no Codex turn active on either instance (the last activity in each bridge log is followed by `"operation":"app_server_close","status":"succeeded"`), and no scheduled business job is due in the next few minutes. Check that each instance has been up for at least 10 minutes: the supervisor delays the restart of a child that ran for a shorter time.
2. 006 changes no rows. Take the routine bridge-schema backup only if the host's DDL policy requires one; rollback does not need it.
3. Fast-forward the bridge checkout to 0.2.30: `git -C <bridge-dir> fetch origin` and `git -C <bridge-dir> merge --ff-only origin/main`. There is no dependency change. The running processes keep their loaded code until they restart.
4. For each instance run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>`; it must log `check_config` `succeeded`.
5. Run once, with either instance's configuration: `node bin/agent-chat-bridge.mjs migrate --config <bridge.json>`. Success is exit status 0 and `{"level":"info",…,"operation":"migration","status":"succeeded","version":6,"applied":true}` (`"applied":false` on a rerun when 006 was already recorded). A metadata-lock timeout (an open transaction on one of the four tables for more than 10 seconds) ends with exit status 1 and `{"level":"warning",…,"operation":"startup","status":"failed","code":"store_contention"}`; `store_timeout` and `store_unavailable` are reported the same way. A missing `ALTER`/`INDEX` privilege or another deterministic error logs `"code":"store_invalid"`; fix the cause (for example grant the privilege) and run step 5 again. **If step 5 fails, do not run step 6.** The 0.2.29 processes keep working: the indexes already built stay, the ledger stays at version 5, and 0.2.29 accepts that schema. Wait for the long transaction to end and run step 5 again; it skips the indexes that already exist.
6. Immediately after a successful step 5, restart both instances through the supervisor: `kill -TERM <bridge-pid>` for each (the pids are in the supervisor's `logs/status.json`). Without this step each 0.2.29 process exits about 30 seconds later through its watchdog and restarts unplanned.
7. Verify each instance: `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready` return 200; the log has no `schema_version_mismatch`; a `storage_snapshot` line appears within 60 seconds. Optionally confirm `SELECT version FROM bridge_schema_migrations ORDER BY version` returns 1 through 6.
8. `storage.claimTimeoutMs` is optional. Add it only to change the 15000 ms deadline, which bounds both the background hook and outbox claims and the four Codex session reads that gate a turn (binding, accepted-message check, steer events, injection marker); then run `check-config` and restart that instance.

While storage is slow or unavailable, 0.2.30 stays alive with `/health/ready` returning 503 and `degraded` details, and logs `worker_poll_failed` (first failure, then at most every 5 minutes, at `error` level once the degradation has lasted 5 minutes) and `storage_operation` / `storage_snapshot` diagnostics; it no longer restarts after six failed polls. A schema ledger mismatch, a deterministic driver error (`store_invalid`, for example a missing table or denied access) or a stopped worker still restarts it after `runtime.unhealthyExitMs`.

Known limits of 006: an equivalent index under another name is not detected, so 006 builds its own index next to it. While an `ALTER` waits for a metadata lock (at most 10 seconds), new statements on that table wait behind it; claims of a running 0.2.29 (1800 ms deadline) can time out in that window. If the 15-minute `migrate` deadline fires during an `ALTER`, the server may still finish that index while the ledger row is not written; a rerun skips the finished index and records version 6.

Rollback to 0.2.29, symmetric to the upgrade (run steps 2 to 4 back-to-back):

1. Remove `storage.claimTimeoutMs` from every bridge.json that has it (0.2.29 rejects it with `invalid_storage_fields`) and run `check-config` with the 0.2.29 code.
2. Switch the checkout back to the 0.2.29 commit.
3. Delete the ledger row: `DELETE FROM bridge_schema_migrations WHERE version = 6;`. This is a write to the production database and needs the user's explicit authorization. 0.2.29 accepts only versions 1–5. The four indexes can stay: 0.2.29 does not use them and a later 0.2.30 migration skips them.
4. Immediately `kill -TERM` both instances together through the supervisor, so they restart on 0.2.29. A 0.2.30 process that is left running reports `store` not ready (`schema_version_mismatch`) and its watchdog exits it about 30 seconds later.

Rolling back restores the 0.2.29 behaviour this release fixes: the process crash when a restart resumes an already interrupted or failed turn, and the communication worker's exit after six failed polls or 30 seconds of storage failures.

## 0.2.28 group text replies

No database migration, no config `schemaVersion` change and no new environment variable; the job store additionally accepts the `replyMode` key inside the existing `result_json`. `routing.groups[].reply` is optional; without it, or with `mode: "card"`, the execution card, Typing and fallback replies are those of 0.2.27. With `mode: "text"` that group's human turns create no execution card and no Typing reaction, answer with a reply to the triggering message (text for one plain line, post otherwise), send one short text line on failure and nothing for a `silentReply` token; open_ids are never shown as text. A text-mode group must have effective `silentReply.tokens` (`group_text_reply_requires_silent_reply` otherwise). `ack: "reaction"` leaves one `ackEmoji` reaction (default `OnIt`) on each triggering message. `trigger: "all"` is unchanged. See [group text replies and trigger all](docs/runtime.md#group-text-replies-and-trigger-all).

To enable it for a group:

1. Back up the private configuration: `cp -p <bridge.json> <bridge.json>.bak-0.2.28-<timestamp>`.
2. Make sure the group has `silentReply.tokens` (directly or from `routing.silentReply`) and that its Agent rules answer that exact token when nothing needs to be said.
3. Add `"reply": { "mode": "text" }` to the group (optionally `"ack": "reaction"`); for a group that should answer every human message set `"trigger": "all"`.
4. Deploy 0.2.28 and run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>`; it must log `check_config` `succeeded`.
5. Restart only that bridge: `kill -TERM <bridge-pid>` and let its supervisor start it again.
6. Verify: `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready`; mention the bot in the group and check that the answer arrives as a reply to that message with no execution card.

To turn it off on 0.2.28, first set every group that was switched to `"trigger": "all"` back to `"mention"`, then remove `reply` (or set `"mode": "card"`), run `check-config` and restart the bridge once. Rollback to an earlier version: first set those groups back to `"trigger": "mention"` and remove every `routing.groups[].reply` (0.2.27 and earlier reject the key with `invalid_group_fields`), run `check-config`, then switch the binary and restart once. Jobs finished in text mode need no cleanup; a recorded `replyMode` is ignored by earlier versions.

## 0.2.27 named Codex permission profile

No database migration, no config `schemaVersion` change, no storage change and no new environment variable. `codex.permissionProfile` is optional and has no default; without it thread, turn and launch parameters and logs are those of 0.2.26. When set, thread start, resume and fork send `permissions` instead of `sandbox`, a thread is used only when Codex reports the same `activePermissionProfile.id` (`CODEX_PERMISSION_PROFILE_MISMATCH` otherwise, with a fixed error message), and the app-server starts without the legacy `sandbox_workspace_write.network_access` flag. The key cannot be combined with `codex.sandbox` (`codex_permission_profile_conflicts_with_sandbox`), `codex.networkAccess` (`codex_permission_profile_conflicts_with_network_access`) or a group `codex.sandbox` (`group_codex_sandbox_conflicts_with_permission_profile`). The instance's Codex home `config.toml` must set `default_permissions` and define `[permissions.<id>]`. It relies on the app-server experimental API of codex-cli 0.153.4. See [named permission profile per instance](docs/runtime.md#named-permission-profile-per-instance).

Failure signals (codex-cli 0.153.4):

- An undefined id is rejected by Codex and logged as `rpc_request` `rejected` `CODEX_RPC_REJECTED`, not as a mismatch.
- `CODEX_PERMISSION_PROFILE_MISMATCH` means Codex accepted the request but did not apply or report the profile.
- A missing `default_permissions` next to profile tables produces no bridge error: the profile is still applied because the bridge sends `permissions`. The only signal is Codex's startup `configWarning`, which the bridge does not log. Set `default_permissions` anyway and check the home as in step 2.

To enable it:

1. Deploy (fast-forward) 0.2.27 first. Instances without the key behave as on 0.2.26, and a restart during the next steps works with either the old or the new private configuration.
2. Define the profile in the instance's Codex home `config.toml` (`default_permissions = "<id>"` and the `[permissions.<id>]` tables, without `sandbox_mode` / `[sandbox_workspace_write]`). With the same `CODEX_HOME`, from `codex.cwd`, `codex sandbox -P <id> -C <codex.cwd> -- /bin/echo ok` must print `ok` (it catches an undefined id), and `codex features list > /dev/null` must exit 0 (it catches a missing `default_permissions`). Do steps 2–4 in one window.
3. Back up the private bridge.json, remove `codex.sandbox`, `codex.networkAccess` and any group `codex.sandbox`, add `codex.permissionProfile`, then run `node bin/agent-chat-bridge.mjs check-config --config <path>` with the 0.2.27 code and fix any reported code.
4. Restart only that bridge process (`kill -TERM <bridge-pid>`; its supervisor starts it again), then check:
   - `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready`;
   - the `app_server_start` line with `permissionProfile`;
   - after one message, a `thread_start` or `thread_resume` line with `status` `succeeded` and `activePermissionProfile` equal to the id.

To turn it off on 0.2.27, restore the backup (or remove `codex.permissionProfile`), run `check-config` and restart the bridge once. Rollback to 0.2.26: remove `codex.permissionProfile` first, because 0.2.26 rejects the key with `invalid_codex_fields`; then switch the binary and restart once.

## 0.2.26 private-chat admission callback

No database migration, no config `schemaVersion` change and no storage change. `routing.privateAdmission` is optional; without it private chats keep the `privateUserIds` / `allowAllPrivateUsers` rules and logs are unchanged. When configured, its `tokenEnv` names a new required environment variable for that bot only (startup fails with `required_environment_missing` without it), and it cannot be combined with `allowAllPrivateUsers: true` (`private_admission_conflicts_with_allow_all`). Refused and unavailable private messages are not stored; caches live only in memory. See [private-chat admission callback](docs/runtime.md#private-chat-admission-callback).

To enable it:

1. Deploy the admission endpoint and provide the token to the bridge process under the `tokenEnv` name.
2. Back up the private bridge.json, set `allowAllPrivateUsers` to `false` (or remove it) and add `routing.privateAdmission`.
3. Run `node bin/agent-chat-bridge.mjs check-config --config <path>` and fix any reported code.
4. Restart only that bridge process (`kill -TERM <bridge-pid>`; its supervisor starts it again), then check `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` and `/health/ready`, and one admitted and one refused private message.

To turn it off on 0.2.26, restore the previous routing (remove `privateAdmission`), run `check-config` and restart the bridge once. Rollback to 0.2.25: remove `privateAdmission` first, because 0.2.25 rejects the key with `invalid_routing_fields`; then switch the binary and restart once.

## 0.2.25 per-group Codex working directory

No database migration, no config `schemaVersion` change and no new environment variable. `routing.groups[].codex.cwd` is optional, must be an absolute path (`invalid_group_codex_cwd` otherwise) and is stored normalized. Startup and `check-config` require an existing directory owned by the bridge user that is not world-writable, the same rules as the global `codex.cwd`, and fail with `invalid_group_codex_workspace`. The group's human thread and business-event threads delivering to the group use it on `thread/start`, `thread/resume`, `thread/fork` and every `turn/start`; other groups and private chats keep the global cwd. Bridge-owned paths stay under the global cwd. Prompts now name the result-file directory as `<global codex.cwd>/data/feishu-outbox/...` for every conversation; business-event threads therefore receive their system-task preamble once more.

Existing threads of a group that gets a `cwd` move to a new thread on their next turn: Codex keeps the cwd recorded at `thread/start`, so the executor replaces a thread whose recorded cwd differs through the normal rollover path and logs `thread_rollover` with `reason` `cwd_changed`. The new thread receives the full first-turn context. Codex reads `AGENTS.md` from the cwd when a thread is created, so edits to the workspace `AGENTS.md` take effect for new threads. See [per-group Codex permissions](docs/runtime.md#per-group-codex-permissions).

To enable it:

1. Create the group workspace: `mkdir -p <parent-dir>`, then `mkdir -m 700 <workspace-dir>`, and add its `AGENTS.md` (for example `ln -s <source>/AGENTS.md <workspace-dir>/AGENTS.md`). Verify that `stat -f '%Su %Lp' <workspace-dir>` prints the bridge user and `700`. A directory outside any git repository gives project-less Codex threads, which read only the Codex home `AGENTS.md` and the directory's own `AGENTS.md`.
2. Deploy 0.2.25 by fast-forward: `git -C <bridge-checkout> fetch origin`, then `git -C <bridge-checkout> merge --ff-only origin/main`. The running bridge keeps the old code until its restart.
3. Back up the private configuration (`cp -p <bridge.json> <bridge.json>.bak-0.2.25-<timestamp>`), then add `"cwd": "<workspace-dir>"` to each target group's `codex` object. Keep the group's `instructionFiles` unchanged, including an entry that points at the same `AGENTS.md`: the human thread then also receives it as group instructions, which are re-injected when the file changes, while business-event threads read it only from the cwd when the thread is created.
4. Run `node bin/agent-chat-bridge.mjs check-config --config <bridge.json>` from the updated checkout; it must log `check_config` `succeeded`.
5. Confirm that no turn is running: the bridge log must show `"operation":"app_server_close","status":"succeeded"` after the last activity (the Codex child closes only when idle), with no newer activity.
6. In that idle window restart only the bridge: `kill -TERM <bridge-pid>`, and let its supervisor start it again. Find the pid with `ps -axo pid,command | grep '[a]gent-chat-bridge.mjs start'` or in the supervisor's `logs/status.json` (`services["agent-chat-bridge"].pid`). Do not restart other services.
7. Verify: `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/live` returns `{"live":true}` and `curl --noproxy '*' -fsS http://127.0.0.1:<port>/health/ready` returns HTTP 200 with `"ready":true`. The bridge log must not contain `invalid_group_codex_workspace`. On their next turn, the group's existing threads log `thread_rollover` with `reason` `cwd_changed` once each.
8. Rollback: restore the backup (or remove `cwd`), run `check-config`, then repeat steps 5–6. To return to 0.2.24, remove every `codex.cwd` first: 0.2.24 rejects the key with `invalid_group_codex_fields` at startup. Threads already moved keep the workspace as their recorded cwd (their turns run in the global cwd) until their next rollover.

Warning: the group workspace is checked at every start. If the directory is deleted, becomes world-writable or changes owner, the next bridge start fails as a whole (`invalid_group_codex_workspace`), which stops every group and private chat until the directory is restored or `cwd` is removed.

## 0.2.23 command title template

No database migration, no config `schemaVersion` change, no new configuration field and no new environment variable. The optional card text key `commandTitleTemplate` (placeholders `{name}` and `{label}`, default `{name}`) sets the title of an execution-card command line that has no recognised action; `{label}` is `toolCommandExecutionLabel`. Without the key the card is identical to 0.2.22. See [card text](docs/card-text.md).

Upgrade: switch the binary and restart once. Rollback to 0.2.22: first remove `commandTitleTemplate` from every card text file, because 0.2.22 rejects unknown fields and would fall back to default wording for the whole file; then switch the binary back and restart once.

## 0.2.22 compact execution card

No database migration, no config `schemaVersion` change, no new configuration field and no new environment variable. The sidecar card state (`messageId`, status, up to 24 progress entries, stop and fork identity) keeps its format, and every card is re-rendered from that state on each patch, so a running card created by 0.2.21 switches to the new layout on its next update and needs no conversion. Existing `feishu.cardTextFile` files keep working because no key was removed or renamed; `toolGroup`, `toolItem` and `omitted` now title, fill and head the single process panel, and tool lines no longer carry durations, exit codes or tool names. The optional new key `processGroup` (default `执行过程`) titles the panel of a finished card that has commentary but no tool call. See [the execution-card layout](docs/runtime.md) and [card text](docs/card-text.md).

Upgrade: switch the binary and restart once. Rollback to 0.2.21: first remove `processGroup` from every card text file, because 0.2.21 rejects unknown fields and would fall back to default wording; then switch the binary back and restart once. Cards return to the nested-panel layout on their next patch.

## 0.2.21 per-group Codex permissions

No database migration, no config `schemaVersion` change and no new environment variable. Without `routing.groups[].codex` every thread keeps the global `codex.approvalPolicy`, `codex.approvalsReviewer` and `codex.sandbox`, and the Codex request parameters are the same as in 0.2.20.

The object accepts `approvalPolicy` (`untrusted`, `on-request`, `never`), `approvalsReviewer` (`user`, `auto_review`, `guardian_subagent`) and `sandbox` (`read-only`, `workspace-write`, `danger-full-access`), at least one of them, compared exactly. It is rejected on a hook-only group. It applies to group bindings of that chat id: the human group thread and business-event threads whose hook `inbound.defaultChatId` is the group. Private chats never match. Codex full access needs both `"approvalPolicy": "never"` and `"sandbox": "danger-full-access"`; with `never` and the sandbox still `workspace-write`, Codex rejects every MCP tool call that needs approval with `MCP tool call requires approval, but approval policy is never`. See [per-group Codex permissions](docs/runtime.md#per-group-codex-permissions).

To enable it:

1. Add the object to the group in the private bridge.json:

   ```json
   { "conversationId": "oc_example", "trigger": "mention", "passiveContext": true, "capabilities": ["bridge", "hook"],
     "codex": { "approvalPolicy": "never", "sandbox": "danger-full-access" } }
   ```

2. Run `node bin/agent-chat-bridge.mjs check-config --config <path>` and fix any reported code.
3. Restart the bridge once. The bridge does not reload configuration while it runs. Existing threads need no rollover: after the restart, the new app-server child resumes each thread with the new settings before its next turn.

To turn it off on 0.2.21, remove the object and restart once; the threads return to the global settings on their next turn.

Rollback to 0.2.20:

1. Remove `codex` from every `routing.groups[]` entry; 0.2.20 rejects the key with `invalid_group_fields` at startup.
2. Switch the binary and restart once. Threads resume with the global settings.

## 0.2.20 silent-reply sentinel

No database migration, no config `schemaVersion` change and no new environment variable. Silent jobs keep the existing `completed` status; the outcome is stored inside the existing result JSON as `silentReply: { "status": "silent", "card": "deleted" | "completed" | "unchanged" | "none" }`, with `reply_sent_at` left empty.

The feature is off until the operator lists at least one token. To enable it, add the token to the private bridge.json either for every `bridge` group or for selected groups, then run `check-config` and restart the instance once:

```json
{ "routing": { "silentReply": { "tokens": ["NO_REPLY"], "card": "delete" } } }
```

```json
{ "conversationId": "oc_example", "trigger": "mention", "passiveContext": true, "silentReply": { "tokens": ["NO_REPLY"] } }
```

A group object inherits each omitted field from `routing.silentReply`; `"tokens": []` on a group turns the feature off for that group only. Tokens are 1–200 characters without surrounding whitespace or control characters, at most 20 per level; `card` is `"delete"` or `"complete"`. `silentReply` is rejected on a hook-only group. Matching is exact and case-sensitive after trimming the Agent answer: `NO_REPLY` matches `" NO_REPLY\n"` but not `no_reply`, `NO_REPLY.` or `NO_REPLY 已处理`. Private chats are never silenced.

The bridge does not tell the Agent which tokens are configured. Put the convention (for example "reply exactly `NO_REPLY` when no answer is needed") into the group's instructions (`routing.groups[].instructionFiles` / `instructionText`) or the Agent workspace rules, using the same literal value as the configuration.

`delete` recalls the bot's execution card through `im.v1.message.delete`. Feishu only lets a bot recall its own message within 24 hours of sending it, and the chat may show a "recalled a message" notice. Any recall failure falls back to `complete`, which patches the card to completed with the per-bot card text `silentReply` (default `已处理，无需回复。`). The sentinel itself is never rendered or sent. Once a recall or completion is persisted, a delivery retry does not repeat it.

`result.silentReply.card` (and the `forward_reply` `silent` log `reason`, prefixed `card_`) means: `deleted` recalled; `completed` closed with neutral text; `none` no confirmed card existed, so nothing was shown or changed; `unchanged` an existing card could be neither recalled nor patched. For `unchanged` the job returns to `reply_pending` with `last_error = silent_card_unchanged` and is retried after `codex.jobRetryMs` until `codex.jobMaxAttempts` reply attempts are used; if the card is still unchanged it finishes `completed` with a `forward_reply` `silent` warning, and the card may keep its last running state. No text is sent in any of these cases.

Recall events are now filtered for every group, independent of `silentReply`: a live `im.message.recalled_v1` event, or a history catch-up message returned as deleted, whose message ID is a bot outbound message already recorded in `assistant_inbound_messages` (execution cards and replies) is still accepted and tombstoned but is no longer delivered to hooks and is never group context. Feishu recall events carry no operator, so this lookup is the only way to recognize the bridge's own recall. A failed lookup logs a `recall_filter` warning and keeps the previous hook delivery. Hook consumers that relied on seeing recalls of bot messages must read them from Feishu directly.

Rollback to 0.2.19:

1. Remove `silentReply` from `routing` and every `routing.groups[]` entry; 0.2.19 rejects these unknown keys at startup.
2. If the per-bot `feishu.cardTextFile` defines a custom `silentReply` key, remove it too; 0.2.19 treats the whole card-text file as invalid and falls back to default wording.
3. Before switching binaries, confirm that no silent job is waiting for delivery, because 0.2.19 would send the sentinel text into the group. List pending replies with `SELECT public_run_id, JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.answer')) AS answer FROM assistant_codex_forward_jobs WHERE connection_id='<connection-id>' AND status='reply_pending';` and wait until none of them has a configured token as its answer.
4. Restart once. Already recalled cards stay recalled, and hooks again receive recalls of bot messages.

## Branch promotion

Development changes are integrated and tested on `staging` before a `staging` to `main` promotion pull request. `main` remains the default branch. Moving source to either branch does not automatically run a migration, deploy an instance, publish npm, create or move a tag, or declare a release. See the [staging workflow](docs/staging-workflow.md).

## 0.2.10 Feishu inbound attachments

Version 0.2.10 adds no database migration. Private inbound attachment metadata and prepared prompts are stored in the existing forward-job execution JSON. Existing configurations may add `feishu.mediaDownloadTimeoutMs`; it defaults to 120000. `feishu.mediaMaxBytes` now defaults to 33554432 and is validated as a hard limit from 1 through 33554432 bytes. Remove the former `feishu.mediaUnsupportedReply` key because strict configuration validation rejects it.

## 0.2.9 writer-lock hotfix

Version 0.2.9 adds no database migration. The writer-lock probe, fail-closed shutdown, and runtime health watchdog change process lifecycle behavior only; they do not alter the database schema.

A schema change must reach `staging` with its immutable forward migration and rollback plan. Apply it only to a dedicated staging database through the explicit migrate command after an authorized backup and writer stop. Promotion to `main` preserves that reviewed migration history; production migration remains a separate, authorized operation.

## 0.2.5 shared-schema bot isolation

Migration `004-bot-connection.sql` adds a required `connection_id` to five assistant runtime tables and places it first in their uniqueness, claim, history and context indexes. It also puts the existing connection first in the bridge job, outbox and recovery claim indexes. Existing `bridge_*` ownership is unchanged; migrations 001–003 and their checksums remain immutable. The configuration schema stays at 1. Each running process still owns one Feishu bot and one Codex executor; multiple processes can use one dedicated bridge database after their storage is scoped by connection.

Stop **all** old bridge writers before migration and keep them stopped until the new version is ready. Back up the bridge database together with its matching workspace/outbox files. For an existing database with any assistant rows, invoke `agent-chat-bridge migrate --config <path> --legacy-connection-id <original-bot-connection-id>` using the original bot's exact connection ID. Do not infer that value from the new bot's config. The separate storage CLI accepts the same optional flag. A completely empty new database can run `migrate --config <path>` without it. The migration refuses missing ownership before 004 DDL, holds the old database-level writer lock, stores the selected ownership for interrupted DDL recovery, and verifies non-null columns and expected indexes before recording ledger version 4. Resume a partial migration with the same explicit legacy ID; a different ID is rejected. A completed 004 is a no-op on rerun.

MySQL DDL commits independently. If migration fails, leave all writers stopped and resolve the cause before resuming with the same legacy ID. Do not delete the scope record or migration ledger to change ownership. Rollback after 004 requires stopping the writers and restoring the pre-migration database and matching workspace/outbox backup; the old binary cannot accept ledger 4. This source change does not authorize migration of a real installation or a provider turn.

## 0.2.4 production runtime defaults

Version 0.2.4 adds no database migration. It restores the 60000 ms app-server idle-close default, controlled `inherit=all` shell policy, production execution-card controller, ordinary post/text replies, Typing lifecycle, private image input and direct attachment delivery. Optional `codex.sharedHome` selects the shared Codex directory and must match an inherited `CODEX_HOME`; configurations may still set `codex.idleCloseMs` to `0` explicitly. Optional `feishu.replyAsPost` defaults to `true`, and `feishu.maxOutputChars` defaults to `3500`.

## 0.2.3 app-server idle lifecycle

Version 0.2.3 adds no database migration. Optional `codex.idleCloseMs` defaults to `0`, which disables automatic idle child close. A nonnegative integer up to 86400000 ms is accepted; explicit service shutdown and crash handling remain active.

## 0.2.2 busy retry policy

Version 0.2.2 adds no database migration. Optional `codex.jobRetryMs` defaults to 60000 and accepts 10000–1800000; `codex.jobMaxAttempts` defaults to 3 and accepts 1–10. Existing configurations may omit both fields.

## 0.2.1 protocol fix

Version 0.2.1 adds no database migration. It corrects the Codex app-server approval-reviewer enum used by new and resumed threads.

## 0.2.0 development migration

Version 0.2.0 is unreleased. Migrations `002-codex-sessions.sql` and `003-forward-runtime.sql` add the Codex binding/event tables and the forward/inbound/message-event tables to a **dedicated bridge schema**. Migration 003 also adds the indexes and source-message receipt field used by exact event reads and API-created runs.

Do not point this build at the Kosbling production/P database and do not treat the similarly named production-derived tables as an in-place conversion. The bridge schema also contains migration 001 communication tables and has its own checksum ledger. For a new development instance, create an empty dedicated schema and run the explicit migrate command. For an existing 0.1.1 bridge trial, stop its only writer, preserve the database and workspace/outbox together, review the new configuration and run the same explicit migration once. Startup itself never applies DDL.

Configuration `schemaVersion` stays 1. Add every authorized group to `routing.groups`. Omitted `capabilities` means `['bridge','hook']`; use `['bridge']`, `['hook']`, or `[]` deliberately. A group listed only in `hooks[].conversationIds` is no longer sufficient. Keep one Feishu bot/WebSocket and one Codex app-server/executor for the instance. Before starting 0.2.6, remove the entire former top-level `auth` block, including an empty `auth` object; strict validation now rejects it. Do not remove `hooks[].tokenEnv`, which still supplies each outbound hook credential. The public `/v1` run, event, resource, recovery, delivery and upload endpoints are removed. No database migration or automatic cleanup of historical API/system rows is performed.

Rollback after applying migrations 002–003 requires stopping the writer and restoring the pre-migration bridge database and matching workspace/outbox, or starting 0.1.1 against a separate compatible schema. Version 0.1.1's strict schema assertion does not accept the later ledger. Do not delete later ledger rows, replay unknown external effects or reuse the Kosbling production database as a rollback shortcut.

No current P instance, production data, credentials or real provider was touched to prepare this migration. The Kosbling business producer keeps its native scheduling, Codex and delivery path and consumes the bridge hook.

## 0.1.1 upgrade

This batch changes final reply presentation and adds optional `codex.proxyEnv`
references. Config schema stays 1; migration 001 and the database checksum are
unchanged. Do not rerun initialization or reset the existing trial database.

Before switching code, stop the existing writer gracefully and preserve the
workspace and database. Start exactly one bridge instance with the reviewed
configuration. Existing persisted text effects retain their original payload;
only newly finalized replies use cards. Unknown native work and unknown sends
retain their recovery state and must not be replayed during upgrade. Proxy
references resolve at startup and affect only the Codex child; missing values
fail before provider startup. See [proxy configuration](docs/codex-proxy.md).

Rollback to 0.1.0 uses the same unchanged schema, but remove the optional
`codex.proxyEnv` field before starting the old strict config validator. Stop
the current writer first. Do not move the published v0.1.0 tag or erase external
effects to simulate rollback. Dynamic progress cards and the broader migration
parity audit remain outside this batch.

## 0.1.0 initial installation

This release targets a new, dedicated MySQL 8.4 database and config schema 1. It does not import or modify the existing Kosbling database. Choose an owned Agent workspace and inject credentials through the host's controlled secret mechanism; never commit local configuration or secrets. Follow [runtime setup](docs/runtime.md) for explicit configuration and migration commands.

Before upgrading an existing local trial installation, stop its writer and preserve a database backup plus the Agent workspace/media directories together. Development databases with a different initial-schema checksum cannot be upgraded by silently editing the ledger: use a separately reviewed data-preserving migration, or explicitly discard only a disposable synthetic test database and initialize a fresh one. Do not reset a real database to make startup pass.

Run version/syntax/config checks before starting. Confirm schema validation, health readiness and scoped delivery/recovery according to [local validation](docs/local-validation.md). These commands are checks, not proof of completed provider acceptance. The current release does not add an automatic host version-acceptance marker or deployment process.

For rollback, stop the bridge before selecting the previous code version. Reuse the database only if its schema is compatible with that version. Otherwise restore the deliberately captured database and filesystem backup as an operator-controlled procedure; account for already-sent external effects before resuming. Never replay unknown sends or native attempts as a rollback shortcut.

## Source publication

A release commit records version and changes; an annotated `v0.1.0` tag may identify its exact source snapshot once publication is authorized. Public GitHub source, a GitHub release, npm publication and production deployment are separate actions. Keep `private: true`; do not deploy, publish npm packages or claim real-platform acceptance merely because source was pushed.


## 0.2.33 event execution observation

No database/config migration, dependency change or job replay. `GET /v1/events/:event_id` gains `execution.state`, `scope.state` and `observed_at`. Consumers must treat absent or unknown evidence as unverified; a deferred job is not itself native completion. These are snapshots, not an exclusive execution lease or proof of business completion.

Production host checklist (Bruce):

1. In `/Users/kosbling/kosbling-automation/agent-chat-bridge`, deploy the reviewed 0.2.33 commit from the shared remote, then run `npm test`, `npm run check` and `npm run version:check`. No migrate command is required. Follow the configured supervisor's supported restart lifecycle in an idle window; do not start a second bot WebSocket owner.
2. Confirm configured instances recover `/health/ready`. Read an existing owned event using its hook bearer, without logging the bearer. Verify a running/deferred target reports running/busy, then ended/idle after its native target and all same-scope work end. Other active scopes must not block this one; missing evidence must remain unknown. Do not create a business operation just for verification.
3. Confirm the dependent consumer uses both native-ended and scope-idle evidence before recovery and still checks its own current business version and authorization. HTTP success, job completion or idle scope does not authorize business writes.
4. Roll back to the recorded 0.2.32 commit through the same targeted supervisor restart if needed. No data rollback; consumers must fail closed when the observation fields disappear.

Local verification includes the real HTTP handler, forward runtime and Codex executor against a synthetic RPC child. The isolated MySQL suite verifies exact scope/caller/connection matching; it requires a local Docker daemon and must not run against production credentials.


## 0.2.34 shared ordinary conversations

No database migration or dependency change. Config schemaVersion remains 1. Optional settings are `routing.groups[].sharedConversationId` and `conversationInput: { tokenEnv, chatIds }`.

1. Review the intended shared groups. Use an existing configured group as the anchor. Anchor instructions govern the shared thread; remove member instruction overrides and make Codex workspace/permission settings identical. Sharing explicitly makes both groups' context available to this thread.
2. Set a dedicated secret reference for conversationInput; allow only intended target groups. Configure scheduling in the existing instance supervisor, not in a new bridge scheduler. Do not reuse business-event hooks.
3. Run `npm test`, `npm run check`, and `npm run version:check` in the release checkout. Restart via the instance supervisor; never launch a second WebSocket owner.
4. Verify two group messages resume the same native thread, source replies/files remain in their original group, a third group stays isolated, and a prompt POST returns 202 without a group execution card. Verify actual work through the normal Agent tools before enabling recurring prompts.
5. Rollback: disable the external schedule, remove the optional config keys, then restore 0.2.33 via the supported restart lifecycle. Shared-thread history is retained on the anchor; do not delete business records. The second group's old binding is deliberately not rewritten.
