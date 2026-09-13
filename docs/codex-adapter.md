# Codex stdio adapter

`createCodexAdapter` in `src/agents/codex/adapter.mjs` owns one app-server child for one lifetime. It has no Store dependency and never retries a provider operation. A failed instance must be replaced after core reconciles outstanding work.

## Construction and lifecycle

```js
const codex = createCodexAdapter({
  bin: '/trusted/path/to/codex',
  cwd: '/trusted/workspace',
  env: explicitlyAllowedEnvironment,
  threadDefaults: { approvalPolicy: 'never', sandbox: 'workspace-write' },
}, {
  onNotification: async ({ method, params }) => persistNotification(method, params),
  onFault: async ({ code, outcome }) => recordConnectionFault(code, outcome),
  log: (level, operation, status, fields) => structuredLog(level, operation, status, fields),
});
await codex.start();
```

Core validates executable/workspace ownership and allowed environment names. The adapter requires an absolute cwd and an explicit environment map, snapshots both environment and trusted thread defaults, and does not inherit `process.env`. It spawns `bin app-server --listen stdio://` without a shell. Readiness requires an initialize response and sending initialized. `status()` returns `{state,pendingRequests,queuedNotifications}`; it is connection status, not model authentication or Store readiness.

`start()` is idempotent while starting/ready. `close()` is idempotent, rejects outstanding RPCs, sends SIGTERM, escalates to SIGKILL after the grace period, and waits a bounded time for child close and queued notification delivery. Never restart a closed instance. Shutdown cannot cancel a callback already running; core callbacks must have bounded I/O and fencing and must keep unfinished work recoverable. Shutdown while provider work is active does not prove it failed.

Options and defaults: `rpcTimeoutMs=10000` (also callback deadline), `shutdownGraceMs=1000`, `maxFrameBytes=8388608`, `maxPendingRequests=128`, `maxQueuedNotifications=256`. Frames, unfinished stdout frames, pending requests, notification count, and stdin write buffering are bounded. Provider stderr is drained without logging or storage. Logs contain only fixed operations/status/codes; logging failures cannot interrupt cleanup. Core supplies its standard module/component fields and error reporting.

## Operations

All methods return the native RPC result. No method waits for a turn to complete.

| Method | Accepted parameters |
| --- | --- |
| `startThread()` | none; trusted constructor defaults and fixed cwd |
| `resumeThread()` | `threadId`; same defaults and cwd |
| `readThread()` | `threadId`, optional `includeTurns` |
| `startTurn()` | `threadId`, nonempty `input`, optional `model`, `effort`, `clientUserMessageId` |
| `steerTurn()` | `threadId`, `expectedTurnId`, nonempty `input`, optional `clientUserMessageId` |
| `interruptTurn()` | `threadId`, `turnId` |

Unexpected top-level fields are rejected locally, including cwd, approval policy and sandbox overrides. Constructor thread defaults accept only model, approvalPolicy, sandbox, developerInstructions and baseInstructions (strings). Core authorizes model/input and validates schema-specific nested input. Local parameter validation may throw synchronously; use `await` inside a try/catch.

## Notifications and server requests

`onNotification({method,params})` receives native notification names and native params, in wire order. For example `turn/completed` carries `{threadId,turn:{id,status,...}}`; `item/agentMessage/delta` carries native identifiers and delta. There is no invented completion event and no filtering of unfamiliar notifications. These callbacks contain user/model content and must never be logged wholesale. The callback resolves only after core's minimal durable update. Core must correlate thread/turn IDs with its bindings and fencing token; it must not rely on a callback closure installed after `startTurn` returns.

RPC responses settle independently of the notification queue, preserving admission before a completion notification following it in the same stdout chunk. Core must install the callback at construction and allow native notifications to arrive before application bookkeeping finishes. Queue overflow or callback timeout/rejection faults the connection and reports `onFault`; undelivered queued notifications are discarded and require reconciliation through durable core state/native reads. No successful admission is treated as successful execution.

This version supports no approval UI or dynamic tool execution. Every server request gets the original string/integer ID and JSON-RPC error `-32601`, `Unsupported server request`. It also emits `{method:'bridge/serverRequestRejected',params:{requestId,method,threadId,turnId}}`, excluding command/input payload. Core can surface this rejection; it must never convert it into approval or fake tool completion.

## Error and recovery contract

`CodexAdapterError` has fixed `message` and `code`, `outcome`, and optional numeric `rpcCode`. Provider error text is discarded.

| Outcome | Codes | Core action |
| --- | --- | --- |
| `rejected` | `codex_rpc_rejected` (+ provider numeric `rpcCode`) | Explicit provider RPC rejection; do not label as an unknown transport admission. |
| `not_started` | `invalid_codex_options`, `invalid_codex_params`, `invalid_codex_input`, `invalid_codex_payload`, `codex_not_ready`, `codex_lifecycle_closed`, `codex_request_capacity`, local `codex_frame_too_large`, `codex_connection_unavailable` | This call was not written. Preserve any earlier run state; local validation does not undo prior operations. |
| `unknown` | `codex_rpc_timeout`, `codex_process_exited`, `codex_process_closed`, `codex_spawn_failed`, `codex_invalid_frame`, received `codex_frame_too_large`, `codex_read_failed`, `codex_write_failed`, `codex_write_backpressure`, `codex_notification_capacity`, `codex_notification_delivery_failed`, `codex_closed`, `codex_start_interrupted`, shutdown/callback deadlines | Never blindly replay thread creation or turn admission. Core must reconcile or require operator resolution. |

`onFault({code,outcome:'unknown'})` fires at most once per failed connection. A spawn/initialize fault is conservatively connection-level unknown, but core knows that no application turn was allowed before readiness. Initialization failures additionally use `codex_initialize_failed` (a local thrown setup error defaults to not_started). Deadline codes are `codex_shutdown_timeout`, `codex_notification_timeout`; fault callback deadline uses internal `codex_fault_sink_timeout` and logs fixed `codex_fault_sink_failed`. Rejected/hung fault reporting cannot cause an unhandled rejection. An unmatched RPC response is ignored with warning code `codex_unmatched_response`.

Persist an attempt before calling startThread/startTurn. A native admission ID is not a server idempotency guarantee, and `clientUserMessageId` must not be assumed to deduplicate retries. Recovery policy and durable pending completion buffering belong to core, not this adapter.

## Verification boundary

`node --test test/codex-adapter.test.mjs` launches temporary Node protocol fixtures with an explicit synthetic environment. It does not launch Codex, authenticate, or execute a model. Tests cover actual stdio/process signals, split framing, out-of-order RPC responses, immediate ordered completion, unknown/rejected outcomes, unsupported server requests, redaction, capacity limits, slow callbacks, spawn/exit failures and SIGKILL escalation. Native field choices are based on the locally generated Codex app-server schema documented in the research report; real model/platform integration remains a separate acceptance step.
