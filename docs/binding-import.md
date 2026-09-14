# Controlled binding import

`import-bindings` is an operator-only cutover command. It copies existing Codex thread bindings into the bridge schema without starting, resuming, or writing to a Codex thread. There is no equivalent HTTP API.

The source exporter must stop new legacy producers and report zero `pending`, `running`, and `replyPending` jobs before producing the snapshot. `unknown` and `held` counts are retained as audit facts only; their jobs stay isolated in the source database and are never imported. Stop the legacy WebSocket owner before applying the snapshot.

The JSON snapshot has this exact version 1 shape; unknown or missing fields are rejected:

```json
{
  "version": 1,
  "connectionId": "stable-bridge-connection",
  "exportedAt": 1770000000000,
  "sourceQueue": { "pending": 0, "running": 0, "replyPending": 0, "unknown": 0, "held": 0 },
  "systemMappings": [
    {
      "legacyBindingOpenId": "system:legacy-daily-name",
      "callerId": "business-caller",
      "executionNamespace": "daily"
    }
  ],
  "bindings": [
    {
      "feishu_open_id": "system:legacy-daily-name",
      "chat_id": "oc_target_chat",
      "chat_type": "group",
      "codex_session_id": "native-thread-id",
      "thread_name": "existing-thread-name",
      "created_at": 1760000000000,
      "updated_at": 1760000001000,
      "last_message_id": "existing-message-id",
      "last_message_at": 1760000001000,
      "last_error": ""
    }
  ]
}
```

Human private bindings retain their open ID. Human group bindings must already equal the bridge's hash of the exact chat ID. Every legacy `system:*` binding requires an explicit caller/namespace mapping; the importer derives the destination hash itself. It rejects duplicate destinations and any native thread already assigned to a different connection, identity, or chat.

Set `codex.rolloverOnRulesUpdate` to `false` explicitly for the cutover. Rule rollover compares native thread creation time with target workspace rule-file mtimes, so a newly copied workspace can otherwise replace a valid imported binding on its first message. The importer preserves the real source timestamps and does not alter configuration. Re-enabling rule rollover later explicitly accepts that older threads may roll to a new thread. The configured idle rollover still applies; a binding whose real last activity exceeds that interval can roll normally.

Use a protected `0600` snapshot and the normal configuration/environment credential references. Preview first:

```sh
agent-chat-bridge import-bindings --config /path/to/bridge.json --input /path/to/bindings.json
```

The preview makes no database changes. Applying requires the extra flag and repeats every check:

```sh
agent-chat-bridge import-bindings --config /path/to/bridge.json --input /path/to/bindings.json --apply
```

Apply obtains the connection writer lock, so the target bridge service must be stopped. It also rejects any target `pending`, `running`, `reply_pending`, or `held` forward job. Inserts are one transaction: an identical existing binding is an unchanged no-op, while a different existing binding aborts the whole import. A commit reported as unknown must be inspected by rerunning the same snapshot; the stable identities make that retry read-only for rows already committed.

