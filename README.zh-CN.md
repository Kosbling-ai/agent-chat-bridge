# agent-chat-bridge

[English](README.md) | 简体中文

英文文档和实际代码是主契约；API、配置字段、命令和结构化日志保持英文。

版本：`0.2.23`，当前为未发布开发版；0.2.23 新增可选卡片文案键 `commandTitleTemplate`（占位符 `{name}`、`{label}`，缺省 `{name}`，输出不变），用于重写执行卡里只显示程序名的命令行标题，例如 `{label}` 显示「执行命令」，无迁移。0.2.22 压缩执行卡：可见区只保留答复（运行中为最近一条进展）和状态行，执行过程最多折叠进一个不嵌套的面板，卡片文案键未删改（新增可选键 `processGroup`），已存状态不变。0.2.21 新增 `routing.groups[].codex` 按群覆盖 Codex 权限（`approvalPolicy`、`approvalsReviewer`、`sandbox`），作用于该 `bridge` 群的人类群线程，以及 hook `inbound.defaultChatId` 为该群的业务事件线程；私聊和其它群不变。Codex 完全权限需要 `approvalPolicy: "never"` 与 `sandbox: "danger-full-access"` 同时设置，启用与回退步骤见[版本与迁移](MIGRATIONS.zh-CN.md)。0.1.1 是此前实现版本。0.2.5 增加多 bot 共用专用 bridge MySQL schema 所需的迁移 004，旧 assistant 数据必须显式指定原 bot 的连接 ID；还可把 Codex 支持的用户提问映射为当前 turn 的独立飞书卡片，由原发送者一次提交多道单选或自由填空。此能力默认禁用，需显式配置 `codex.requestUserInput:true` 才启用；secret 提问会被拒绝，过期或断线后的请求不能恢复。0.2.4 恢复原业务的 Codex 宿主默认值、执行卡控制器、普通 post/text 回复、Typing、私聊图片和直接附件投递路径。参见英文[更新记录](CHANGELOG.md)、[版本与迁移策略](MIGRATIONS.md)和[staging 流程](docs/zh-CN/staging-workflow.md)。

这是独立的飞书 + Codex bridge。一个进程持有一套飞书 bot/WebSocket 和一个 Codex app-server/executor；MySQL 使用 bridge 自己的 schema。communication worker 负责 hook 和已登记消息 outbox，唯一的 forward worker 负责 Codex 执行、恢复、卡片、Typing、停止和答案/附件投递。

群必须显式列在 `routing.groups`。`capabilities` 缺省为 `['bridge','hook']`，也可写 `['bridge']`、`['hook']` 或 `[]`。hook 按自己的订阅过滤，不依赖 Agent 的 @、成员过滤、执行或回复。业务继续以 lark-cli 等查询接口为数据真源，自己负责轮询兜底和 messageId 去重；hook 只是带稳定事件/群/消息标识的轻量通知。

业务系统只通过 hook 接入 bridge，并继续使用自己的原生 SDK、Codex、调度与消息投递链路。bridge 不公开 run、event、resource、upload 或消息投递接口；HTTP 监听器只提供健康检查。bridge 内部仍为人类飞书会话发送执行卡、Typing、答案和附件，并把未知原生或投递结果保留为待核对状态，不自动重跑模型或重发不确定效果。

`GET /health/tasks?window_minutes=120` 与 `/health/ready` 具有相同的访问条件，只读统计当前进程配置的 `connection_id` 下的任务。窗口须为 5–1440 的整数分钟，缺省 120；非法参数返回 400 `invalid_window_minutes`。统计窗口内结束且状态为 failed 的聊天任务（`bridge`）和业务事件任务（`caller`）；错误码 `CODEX_TURN_INTERRUPTED` 只计入 `interrupted.total`，deferred 不计入。按结束时间最多统计最近 500 条，超过时 `failed.truncated=true`。不符合 `[A-Z0-9_]{1,64}` 的错误码归 `OTHER`，最多返回 10 个错误码，余项并入 `OTHER`。读库失败返回 503 `task_health_unavailable`，不会伪装为零失败。响应不包含提示词、消息正文、发送人、群标识或原始错误文本。

响应示例：

```json
{"window_minutes":120,"checked_at":1790000000000,"failed":{"total":3,"truncated":false,"latest_finished_at":1789999000000,"by_code":[{"code":"CODEX_USAGE_LIMIT_EXCEEDED","count":2},{"code":"OTHER","count":1}],"by_mode":{"bridge":1,"caller":2}},"interrupted":{"total":0}}
```

首次健康通知仍需异常持续 30 分钟。额度恢复后，已失败任务不会自动补跑；窗口未结束时检查项仍会显示异常，不代表当前仍无额度。

当前只完成公开 bridge 代码、合成测试和离线实现审阅。没有真实飞书/Codex 验收、部署、打 tag、发布或 Kosbling 业务 producer 切换；现有 P 实例保持不动。详细契约见[中文补充](docs/zh-CN/forward-runtime.md)和英文[运行说明](docs/runtime.md)。

```sh
npm ci
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
npm test
npm run check
```

### 静默回复哨兵

Agent 判断某次群聊触发无需回复时，可以只回一个由操作者配置的哨兵字符串。`routing.silentReply` 为所有 `bridge` 群设默认值，`routing.groups[].silentReply` 可逐字段覆盖单个群：

```json
{ "routing": { "silentReply": { "tokens": ["NO_REPLY"], "card": "delete" } } }
```

`tokens` 缺省 `[]`（即关闭），`card` 缺省 `"delete"`。bridge 不会把 token 告诉 Agent，哨兵约定要以相同字面值写进群指令或工作区规则。Agent 最终答复去掉首尾空白后与某个 token 精确相等（区分大小写，不做前缀或包含匹配）时，bridge 不发文字回复：`"delete"` 撤回执行卡（飞书只允许机器人撤回发送后 24 小时内自己发的消息，群里可能显示「撤回了一条消息」），撤回失败退化为 `"complete"`；`"complete"` 把执行卡改为完成态并显示中性卡片文案 `silentReply`（缺省「已处理，无需回复。」）。哨兵字面值不会展示。任务记为 `completed`，结果中 `silentReply.status` 为 `silent`；卡片既撤不回也改不了时按 `codex.jobMaxAttempts` 重试。私聊、失败或补充转达的任务、非哨兵答复均不受影响；outbox 附件照常发送。bot 自己消息的撤回事件不再转给 hook。升级说明见[中文迁移说明](MIGRATIONS.zh-CN.md)。

迁移或启动前只使用独立 bridge schema 和受控凭证注入。不要把 token 写入 JSON、`.env`、日志或版本控制。迁移边界见[中文说明](MIGRATIONS.zh-CN.md)。
