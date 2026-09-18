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

Supported fields and placeholders are listed below. Values are nonempty, single-line plain text. Templates and the longer notices (`received`, `omitted`, `fallback`, `inputSubmitted`, `inputUnknown`, `inputExpired`) accept up to 200 Unicode code points; other labels accept up to 80. Omit `title` to use `feishu.displayName`. Templates accept only their listed placeholders, which are substituted once without evaluating code or interpreting inserted values as templates.

Card text is presentation configuration owned by the bridge. Enabling it does not add the file path, field list or editing rules to Codex prompts. An operator or authorized agent can still edit the file when given its explicit path and normal file-write authority; the bridge hot-loads the result on the next card update. The text applies to all conversations of that bot. Separate files isolate presentation settings, not OS permissions between agents sharing one macOS account.

Execution-card text and user-input form text are configurable. Tool counts, running counts, durations, exit codes and safe tool/file names come from actual events. Templates customize labels and formatting, not underlying execution state. Model-authored commentary, answers, question/option contents, legacy API reply cards, Typing fallback messages and action-response toasts are outside this facility. Actions, status transitions and backgrounds are unchanged. No database migration is required.

New tool events retain bounded, sanitized presentation metadata, so an active card can re-render their labels with updated wording. Older saved tool entries without metadata retain their recorded title/summary; the containing panels and card labels still use current copy. Raw shell text, arguments and tool output are never added to this metadata.

Example: change only these fields in your bot's existing text file:

```json
{
  "toolGroup": "{count} 项行动 · {activity}",
  "toolGroupRunning": "正在执行 {running} 项",
  "toolGroupFinished": "全部结束",
  "durationLabel": "用时",
  "inputSubmit": "确认回答"
}
```

## Fields

| Field | Default | Allowed placeholders |
| --- | --- | --- |
| `title` | (display name) | — |
| `received` | 已收到，正在处理你的请求。 | — |
| `running` | 执行中 | — |
| `completed` | 已完成 | — |
| `failed` | 执行失败 | — |
| `interrupted` | 已中断 | — |
| `retrying` | 连接恢复中 | — |
| `deferred` | 补充已转达 | — |
| `stopButton` | 停止执行 | — |
| `forkButton` | 保留历史并新建会话 | — |
| `omitted` | 较早的执行过程已收起，仅展示最近进度。 | — |
| `fallback` | 结果将通过普通消息送达 | — |
| `toolGroup` | {count} 个工具调用 · {activity} | `{count}`, `{running}`, `{activity}` |
| `toolGroupRunning` | {running} 个执行中 | `{running}` |
| `toolGroupFinished` | 已结束 | — |
| `toolItem` | {title} · {status} | `{title}`, `{status}` |
| `toolUnknownStatus` | 已结束 | — |
| `cardSummary` | {title} · {status} | `{title}`, `{status}` |
| `statusFooter` | {status} | `{status}` |
| `fallbackSuffix` |  · {fallback} | `{fallback}` |
| `inputSubmitted` | 回答已提交。 | — |
| `inputUnknown` | 提交状态未确认，请勿重复提交。 | — |
| `inputExpired` | 该提问已失效。 | — |
| `inputChoose` | 请选择 | — |
| `inputOther` | 其他（请填写） | — |
| `inputAnswer` | 请输入回答 | — |
| `inputSubmit` | 提交回答 | — |
| `inputSummary` | {title} · Codex 提问 | `{title}` |
| `inputTitle` | {title} · 需要你的回答 | `{title}` |
| `toolCommandExecutionLabel` | 执行命令 | — |
| `toolFileChangeLabel` | 更新文件 | — |
| `toolWebSearchLabel` | 搜索资料 | — |
| `toolImageViewLabel` | 查看图片 | — |
| `toolImageGenerationLabel` | 生成图片 | — |
| `toolCollabAgentLabel` | 协作任务 | — |
| `toolOrderLabel` | 处理订单 | — |
| `toolDocumentLabel` | 处理文档 | — |
| `toolSearchLabel` | 搜索资料 | — |
| `toolSheetLabel` | 处理表格 | — |
| `toolReadLabel` | 读取信息 | — |
| `toolGenericLabel` | 调用工具 | — |
| `actionReadLabel` | 读取 | — |
| `actionListFilesLabel` | 列出文件 | — |
| `actionSearchLabel` | 搜索 | — |
| `skillLabel` | 技能 | — |
| `fileLabel` | 文件 | — |
| `durationLabel` | 耗时 | — |
| `secondsLabel` | 秒 | — |
| `exitCodeLabel` | 退出码 | — |
| `commandLabel` | 命令 | — |
| `toolLabel` | 工具 | — |
| `toolTitleTemplate` | {name} · {label} | `{name}`, `{label}` |
| `fieldTemplate` | {label}：{value} | `{label}`, `{value}` |
| `readTargetTemplate` | {action} {target} | `{action}`, `{target}` |
| `readFallbackTemplate` | {action}{file} | `{action}`, `{file}` |
| `skillReadTemplate` | {action} {skill} {skillLabel} | `{action}`, `{skill}`, `{skillLabel}` |
| `actionTargetTemplate` | {action}：{target} | `{action}`, `{target}` |
| `durationTemplate` | {label}：{seconds} {unit} | `{label}`, `{seconds}`, `{unit}` |
