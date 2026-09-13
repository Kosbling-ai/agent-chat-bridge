# Bridge receive-gap catchup

`createCatchup` in `src/core/catchup.mjs` polls only the bridge's own receive gaps. It does not consult business tables, wait for business completion, reconstruct an edit stream, or cancel Agent turns. Kosbling retains its existing business history/reconcile loops and SDK/CLI reads. History is an internal adapter capability, not a public history proxy.

## Integration contract

Construct with `{connectionId,botOpenId,chat,store,onEvent,listConversations,log}`. `chat.listMessages` is the existing bounded Feishu adapter method, always create-time ascending. `store.getCursor/setCursor` use versioned CAS. `onEvent(event,{signal})` must durably register inbox/routing before resolving; it must atomically deduplicate live/history by connection + conversation + message ID, even when platform event IDs differ. An already registered message observed with different history content does not create another Agent run or synthetic edit hook. Business reconcile owns edits. Do not wire catchup to an event-ID-only inbox.

`listConversations()` returns up to 1000 distinct approved `{conversationId,conversationType:'p2p'|'group'}` entries. The host combines current Agent/hook group scopes with its own known private conversations, using bounded Store pages; private user authorization is rechecked at ingestion. This callback must not list every chat visible to the bot. First-contact private conversations with no previously received message cannot be discovered by this algorithm; it does not invent chat IDs from user IDs. The host must reject or explicitly partition a scope exceeding this limit rather than silently dropping conversations.

`historyMessageEvent` maps the installed SDK 1.60.0 history shape (message.list): body, sender id type, flat mention IDs, parents and timestamps. It preserves `source=history_catchup`, `message.updated` and revision as facts, not ordering guarantees. An explicit `deleted:true` becomes a recalled observation; absence from a list never proves recall. Unknown sender ID types remain unknown, never guessed into an authorized open ID. A mismatching chat ID rejects the entire page before receipt.

`runOnce()` coalesces concurrent invocations and returns counts `{conversations,pages,received,failed,incomplete}`. `start()` begins polling immediately then waits between runs; call `stop()` before tearing down Store. Stop interrupts waits and ignores late read results. Callback/adapter operations have a 15-second budget by default; their own lower storage/HTTP deadlines still apply. Late durable receive is safe only with the required canonical deduplication. An in-flight page is never checkpointed before all its receipt callbacks complete.

## Durable windows and bounds

Cursor key is `catchup:` plus SHA-256 of the conversation ID, scoped by connection. Value is `{schemaVersion:1,throughMs,window:{startMs,endMs,pageToken}|null}`. A fixed second-aligned window is committed before fetching its first page. After every fully accepted page the next token is saved; only an explicit final page advances `throughMs`. A process stop, receipt failure, or lost cursor response can replay a page, which must not duplicate effects. Persisting pagination avoids dropping a dense group of messages sharing a timestamp when the per-run page budget is reached.

Defaults: 60-second interval, one-hour initial lookback, two-minute overlap, 50 messages/page, 20 pages/conversation/run, 500–1000ms jitter before requests. Known windows resume without applying a new lookback cap. These are generic bridge defaults; business-specific descending scans, product/OCR windows and processed-state criteria stay outside this module. Platform history retention and snapshot consistency are not guaranteed by these limits.

Malformed pages, missing/repeated continuation tokens, failed APIs or failed receipts keep the checkpoint and log a sanitized warning for the next cycle. An expired platform token may require a reviewed cursor repair that restarts the same fixed window; the module never skips to now to make an error disappear. No raw error, message content, cursor token or user ID is logged. Logger failures are contained. The host's logger handles terminal error reporting; catchup itself retries receipt/read failures without manufacturing terminal business failure.

## Verification and stage boundary

`node --test test/catchup.test.mjs` exercises timestamp-dense pagination, restart, lost receive response, malformed/cross-chat pages, shutdown, echo filtering and callback isolation. `node scripts/test-storage.mjs test/catchup.integration.test.mjs` uses isolated real MySQL and a synthetic history API to verify durable page replay and restart. Neither contacts Feishu or a model.

This module requires host wiring plus Store canonical first-receipt and known-conversation support. Its standalone tests do not establish the final live/history concurrency guarantee; that must be checked against the integrated Store/runtime. No production cutover or external read API is added by this module.
