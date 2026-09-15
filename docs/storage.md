# Store

MySQL 8.4 is the durable boundary. Migration `001` remains the released communication ledger, `002` contains the Codex binding/event tables, and development migration `003` adds the production-derived forward runtime tables:

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
