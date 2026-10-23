# Store

MySQL is the durable boundary: 8.4 is the supported floor, and production runs and is verified on MySQL 9.6 (the 0.2.30 migration and its locking `UNION` claim were exercised on 9.6 only). Migrations are numbered and immutable:

- `001` the released communication ledger (`bridge_*` inbox, jobs, outbox, cursors and related tables).
- `002` the Codex binding/event tables.
- `003` the production-derived forward runtime tables (below).
- `004` a required `connection_id` on the five assistant tables, placed first in their unique, claim, history and context indexes, so several bots can share one bridge database.
- `005` nullable `sender_union_id` on `assistant_codex_forward_jobs` and `assistant_inbound_messages`.
- `006` four online secondary indexes: `assistant_codex_events.idx_assistant_codex_events_message`, `assistant_codex_forward_jobs.idx_forward_status_finished`, `bridge_jobs.jobs_conversation_open`, `bridge_outbox.outbox_unknown_recent` (see [query indexes and polling cost](runtime.md#query-indexes-and-polling-cost-0230)).

Migration `003` adds:

- `assistant_codex_forward_jobs`: caller idempotency, conversation/input snapshot, execution namespace, delivery mode, lease, reply-pending state, result, and feedback sidecars.
- `assistant_inbound_messages`: normalized message facts used by the bounded passive-context read and reply history.
- `assistant_message_events`: canonical inbound event facts and receipt linkage.

The existing `bridge_jobs` and outbox tables continue to carry hook and communication effects. New Agent execution does not enqueue a second `kind=agent` worker. `acceptInbound` registers the canonical receipt, normalized inbound fact, eligible forward job, and eligible hook jobs in its short transaction. It performs no network or model operation.

Existing communication inbox, delivery, cursor, recovery, resource and ownership tables remain for internal media/catchup paths and historical data. They are not exposed through public endpoints. Their detailed effect and filesystem rules remain in [outbound media](outbound-media.md), [input media](media.md), and [catchup](catchup.md); the forward tables do not replace those ledgers.

Forward claims use `SKIP LOCKED`, stable ordering, a lease owner and expiry. Every mutation requires the current lease owner. Expired known work can be reclaimed; the executor observes a persisted known thread/turn. Unknown native admission or observation becomes held and is not eligible for automatic re-execution.

`result_json` owns the execution result, execution-card snapshot, stop record, and transitional delivery data. Execution/result transitions merge these sidecars so reply-pending settlement does not erase them. Production Typing add/remove facts use `assistant_message_events`; new bridge attachment delivery consumes executor paths directly. Legacy unconfirmed Typing or attachment intent records are retained and never interpreted as confirmed delivery.

Terminal rows with unresolved Typing removal are claimed separately for feedback cleanup. That lease permits only the persisted cleanup sidecar update and cannot reopen Codex execution. Stop callbacks use a transactional intent keyed to the persisted run/thread/turn/message; repeated pending or unknown callbacks inspect that exact turn, and an unconfirmed observation cannot overwrite a later definitive stop result.

Forward event rows remain scoped to the persisted execution binding, thread, chat and source message for internal recovery and diagnostics. They are not exposed through HTTP.

The Store has no scheduler and does not query business history. It retains IDs as signed `BIGINT`, matching the frozen production schema. Migrations are explicit; start only asserts the current ledger version.

Use `node scripts/test-storage.mjs test/storage-forward.integration.test.mjs` for the disposable-MySQL path. Direct execution of the integration test skips unless the script supplies its generated database environment, preventing an accidental default MySQL connection.
