# Per-bot execution-card text

Set `feishu.cardTextFile` to a project-relative JSON path, for example:

```json
{ "feishu": { "cardTextFile": ".agent-chat-bridge/bot3-card-text.json" } }
```

This is a fragment of bridge.json, not a complete configuration. The default is disabled. Restart the instance once after adding the setting. Use different paths for bots sharing a project. The file must be a regular file inside `codex.cwd`; absolute paths, parent traversal and symlinks are rejected.

Example text file:

```json
{
  "title": "Cookie",
  "received": "收到啦，我来看看。",
  "running": "正在认真处理",
  "completed": "处理完成",
  "failed": "遇到问题，请查看详情",
  "stopButton": "停止本次执行"
}
```

The provider reads the file on each execution-card create/update. Changes affect the next update, including an active card; completed historical cards are not proactively rewritten. Write to a temporary file and atomically rename it into place. A missing file or `{}` restores default wording. Omitted keys use defaults; invalid JSON, unknown fields, invalid strings or oversized files keep the last valid snapshot (or defaults after a process restart). One warning is emitted until a valid file is read. File size is limited to 16 KiB.

Supported keys: `title`, `received`, `running`, `completed`, `failed`, `interrupted`, `retrying`, `deferred`, `stopButton`, `forkButton`, `omitted`, `fallback`. Values are nonempty, single-line plain text. `received`, `omitted`, `fallback` accept up to 200 Unicode code points; others accept up to 80. Omit `title` to use `feishu.displayName`.

When enabled, Codex receives the file path and editing rules on each turn, so an authorized user can ask in chat: “把你的卡片标题改成 Cookie，处理中提示改成‘收到啦，我来看看’。” This remains a normal agent request, not a new bypass of Codex file-write approvals. The text applies to all conversations of that bot. Separate files isolate presentation settings, not OS permissions between agents sharing one macOS account.

This first version changes execution-card copy only. It does not change model answers, tool-generated progress summaries, user-input forms, legacy API reply cards, Typing fallback messages, callback payloads, status transitions, colors or backgrounds. Keep the text truthful about the actual status and action. No database migration is required.
