# Codex stdio 适配器

[英文原文](../codex-adapter.md) · [中文入口](../../README.zh-CN.md)

`src/agents/codex/adapter.mjs` 中的 `createCodexAdapter` 在单个实例的生命周期内管理一个 app-server 子进程。它不依赖 Store，也不会重试提供方操作。实例失败后，必须先由 core 核对未完成的工作，再创建新实例替换它。

## 构造与生命周期

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

core 验证可执行文件和工作目录的归属，以及允许传入的环境变量名。适配器要求绝对路径的 cwd 和显式环境变量映射；它会保存环境变量及受信任线程默认配置的快照，不继承 `process.env`。子进程以不经过 shell 的方式启动 `bin app-server --listen stdio://`。只有收到 initialize 响应并发送 initialized 后，连接才就绪。`status()` 返回 `{state,pendingRequests,queuedNotifications}`，表示连接状态，不代表模型认证或 Store 已就绪。

`start()` 在 starting/ready 状态下是幂等的。`close()` 也是幂等的：它拒绝尚未完成的 RPC，发送 SIGTERM，在宽限期后升级为 SIGKILL，并在有限时间内等待子进程关闭及通知队列投递完成。关闭后的实例不可重新启动。关闭过程无法取消已经开始执行的回调；core 回调必须使用有时限的 I/O 和 fencing 校验，并确保未完成的工作可以恢复。在提供方仍有工作进行时关闭连接，不代表该工作已经失败。

选项与默认值：`rpcTimeoutMs=10000`（也用作回调时限）、`shutdownGraceMs=1000`、`maxFrameBytes=8388608`、`maxPendingRequests=128`、`maxQueuedNotifications=256`。协议帧、尚未拼完的 stdout 帧、待处理请求、通知数量及 stdin 写入缓冲都有上限。提供方 stderr 会被持续读取并丢弃，不记录或存储。日志只包含固定的 operation/status/code；日志回调失败不能打断清理。core 提供其标准 module/component 字段及错误上报。

## 操作

所有方法都返回原生 RPC 结果，没有任何方法会等待 turn 执行完成。

| 方法 | 接受的参数 |
| --- | --- |
| `startThread()` | 无；使用受信任的构造配置和固定 cwd |
| `resumeThread()` | `threadId`；使用同样的默认配置和 cwd |
| `readThread()` | `threadId`，可选 `includeTurns` |
| `startTurn()` | `threadId`、非空 `input`，可选 `model`、`effort`、`clientUserMessageId` |
| `steerTurn()` | `threadId`、`expectedTurnId`、非空 `input`，可选 `clientUserMessageId` |
| `interruptTurn()` | `threadId`、`turnId` |

未列出的顶层字段会在本地被拒绝，包括 cwd、审批策略和 sandbox 覆盖参数。构造时的线程默认配置只接受 model、approvalPolicy、sandbox、developerInstructions 和 baseInstructions，值均为字符串。core 负责授权 model/input，并按对应 schema 验证嵌套 input。本地参数校验可能同步抛出异常；调用时应在 try/catch 中使用 `await`。

## 通知与服务端请求

`onNotification({method,params})` 按线路上的接收顺序交付原生通知名称和原生参数。例如，`turn/completed` 携带 `{threadId,turn:{id,status,...}}`；`item/agentMessage/delta` 携带原生标识符和 delta。适配器不会虚构完成事件，也不会过滤不认识的通知。这些回调包含用户或模型内容，绝不能整段写入日志。只有 core 的最小持久化更新完成后，回调才应 resolve。core 必须通过自身绑定关系及 fencing token 关联 thread/turn ID，不能依赖在 `startTurn` 返回后才安装的回调闭包。

RPC 响应独立于通知队列完成，确保同一个 stdout 数据块中先到的接纳响应不会被紧随其后的完成通知倒置。core 必须在构造时安装回调，并允许原生通知先于应用侧登记完成到达。队列溢出或回调超时/拒绝会使连接进入故障状态，并通过 `onFault` 报告；队列中尚未投递的通知会被丢弃，必须依靠 core 的持久状态和原生读取来核对恢复。操作被成功接纳，绝不等同于执行成功。

当前版本不支持审批 UI 或动态工具执行。每个服务端请求都会得到保留原始字符串/整数 ID 的 JSON-RPC 错误 `-32601`，内容为 `Unsupported server request`。同时会发出 `{method:'bridge/serverRequestRejected',params:{requestId,method,threadId,turnId}}`，不包含 command/input 载荷。core 可以呈现这次拒绝，但绝不能把它转换成批准或伪造的工具完成结果。

## 错误与恢复契约

`CodexAdapterError` 包含固定的 `message` 和 `code`、`outcome`，以及可选的数字型 `rpcCode`。提供方的错误文本会被丢弃。

| Outcome | Codes | core 的处理 |
| --- | --- | --- |
| `rejected` | `codex_rpc_rejected`（附提供方数字型 `rpcCode`） | 提供方明确拒绝了 RPC；不能标记为传输结果未知的接纳。 |
| `not_started` | `invalid_codex_options`、`invalid_codex_params`、`invalid_codex_input`、`invalid_codex_payload`、`codex_not_ready`、`codex_lifecycle_closed`、`codex_request_capacity`、本地 `codex_frame_too_large`、`codex_connection_unavailable` | 本次调用未被写出。保留此前的运行状态；本地校验不会撤销先前操作。 |
| `unknown` | `codex_rpc_timeout`、`codex_process_exited`、`codex_process_closed`、`codex_spawn_failed`、`codex_invalid_frame`、接收侧 `codex_frame_too_large`、`codex_read_failed`、`codex_write_failed`、`codex_write_backpressure`、`codex_notification_capacity`、`codex_notification_delivery_failed`、`codex_closed`、`codex_start_interrupted`、关闭/回调超时 | 绝不能盲目重放线程创建或 turn 接纳。core 必须核对，或要求操作人员处理。 |

每个故障连接最多触发一次 `onFault({code,outcome:'unknown'})`。spawn/initialize 故障会保守地记为连接级 unknown，但 core 知道就绪前不允许提交应用 turn。初始化失败还会使用 `codex_initialize_failed`（本地抛出的初始化错误默认归为 not_started）。超时代码为 `codex_shutdown_timeout`、`codex_notification_timeout`；故障回调超时内部使用 `codex_fault_sink_timeout`，日志记录固定代码 `codex_fault_sink_failed`。故障上报被拒绝或挂起，不会造成未处理的 Promise 拒绝。无法匹配的 RPC 响应会被忽略，并记录 warning 代码 `codex_unmatched_response`。

调用 startThread/startTurn 前必须先持久化 attempt。原生接纳 ID 不是服务端幂等保证，也不能假定 `clientUserMessageId` 会对重试去重。恢复策略及待关联完成通知的持久缓冲属于 core，不属于本适配器。

## 验证边界

`node --test test/codex-adapter.test.mjs` 使用显式的模拟环境变量启动临时 Node 协议 fixture，不启动 Codex、不认证，也不执行模型。测试覆盖真实 stdio/进程信号、分片组帧、乱序 RPC 响应、紧随接纳响应的有序完成通知、unknown/rejected 结果、不支持的服务端请求、敏感信息剔除、容量上限、慢回调、spawn/退出故障和 SIGKILL 升级。原生字段的选择依据本机生成的 Codex app-server schema，详见调研报告；真实模型/平台集成仍是独立的验收步骤。
