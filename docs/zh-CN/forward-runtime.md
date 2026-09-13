# Forward Runtime 中文补充

尚未发布的 0.2.2 开发版用一条带租约的 Codex forward worker 替换 0.1.1 的 generation worker；communication worker 只负责 hook 和已登记的消息 outbox。进程只持有一个飞书 bot/WebSocket 和一个 Codex app-server/executor。线程新建、恢复和 turn 启动使用协议定义的 `auto_review` 审批 reviewer。当前仅完成公开 bridge 代码与合成验证，Kosbling 业务 producer 的实际切换属于后续独立工作。

群授权必须显式出现在 `routing.groups`。`capabilities` 只允许 `bridge`、`hook`，缺省两者都开，`[]` 表示两者都关。`bridge` 仍继续检查 @/all trigger 和可选 `userIds`；`hook` 只按自己的群授权与订阅过滤，不参加 Agent 路由、执行或回复。旧配置中只写在 `hooks[].conversationIds` 的群，需要补入 `routing.groups`，纯 hook 群可写 `capabilities:["hook"]`。

hook 只是带稳定 chat/message/event 标识的轻量通知。业务仍以 lark-cli 等自身查询接口为数据真源，并保留业务轮询兜底及双入口 messageId 去重；bridge 不迁入业务回补、历史同步、缓存或 cron，也不让业务另建飞书 WebSocket。

普通运行接口为 `POST /v1/runs`，接受可选 `executionNamespace` 与 `deliveryMode:"bridge"|"caller"`，仍返回 `202 {id,duplicate}`。bridge 模式负责 Typing、执行卡片、停止按钮、答案与附件；caller 模式只执行并保存结果，不自动发送这些飞书效果。`GET /v1/runs/:id` 分开暴露执行和投递状态，并保留 `rawAnswer`、native 与 held 事实；事件接口按该 run 的 binding/thread/chat/message 精确过滤且只返回安全公开投影。附件资源接口需通过相同会话授权，且不暴露本机绝对路径。

人工飞书请求在 native turn 尚未开始前遇到其他客户端持有会话写锁时，第一次明确的 `CODEX_THREAD_BUSY` 就终止本次请求，并只通过原卡片/回复链提示“会话被其他客户端占用，请释放后重试或新建会话。”bridge 保留原 binding，不新建会话，也不自动重放。其他明确可重试的入场失败默认最多 3 次，每次相隔 60 秒；`codex.jobRetryMs` 允许 10 秒到 30 分钟，`codex.jobMaxAttempts` 允许 1 到 10。

system 等待只授予已持久化且非空的 `executionNamespace`：它必须与认证 `callerId` 派生出并匹配该 run 保存的 system binding。sender/messageId/prompt 字符串或关闭 steering 都不能冒充。等待期间复用同一张 retrying 卡片并保持 Typing 关闭，确认入场后才激活一次。已绑定 turn 的观察失败、turn start 结果不明和未决 steer 核对失败始终进入 `held`，保留 native/intent 身份，不受重试次数影响。

卡片保存期望/已确认版本、消息 ID、终态快照和十进制字符串游标。明确拒绝才可走完整正文 fallback；创建结果未知时不重建卡片，也不改发正文来假装成功。正文和每个附件在平台调用前持久化 intent，确认后持久化收据；崩溃遗留的 intent 公开为 `unknown`，不会自行重发。明确失败保留事实，后续附件仍各自尝试。文件只在发送收据落库后清理。Typing 结果不明时只核对原消息返回的前 50 条 reaction，并按 `operator_type=app` 与配置 emoji 匹配；这不能精确证明属于某一个 app，也不能证明后续分页不存在。终态清理有独立租约重试。

bridge 的投递状态包括 `waiting`、`pending`、`sent`、`failed`、`unknown`；caller 终态为 `not_requested`。投递失败或未知不会重跑已经完成的模型 turn。公开附件 `id` 是十进制资源索引，可直接用于 `/v1/runs/:id/resources/:index`。

已知 thread/turn 的恢复只观察，不重新提交；原生结果不确定时进入 held。`GET /v1/runs/:id/attempt`、`POST /v1/recoveries` 和 `POST /v1/sessions/reset` 在完成相应认证、管理权限和会话 scope 检查后返回 `409 unsupported_execution_model`，不会伪造 generation 或假装已登记恢复动作。`GET /v1/recoveries/:id` 只读取 communication schema 中真实存在的旧 recovery 记录，并保留原管理权限和会话检查；不存在时返回 404。

附件最多九件，公开 bridge 的读取/发送采用 **总计 28 MiB** 预算。这比冻结生产源“最多九件、每次上传单文件 28 MiB”更严格，属于公开边界，不应描述为原样复制。

迁移 002–003 只用于 bridge 自己的新 MySQL schema，并非把 Kosbling 生产/P 原库原地转换成 0.2.0。启动只校验迁移账本，不自动执行 DDL；新开发实例应使用空的独立 schema 显式迁移。已有 0.1.1 bridge 试用库如需升级，必须先停唯一 writer，并把数据库与 workspace/outbox 一起备份。应用 002–003 后回退 0.1.1 需要恢复旧库快照或使用另一份兼容 schema，不能删迁移记录假装降级。

0.2.2 目前只是开发版本号和变更记录：没有打 tag、发布，也没有真实飞书/Codex 验收。现有 P 实例保持不动，业务的定时提交、caller 结果消费与 hook 后 lark-cli 查询仍需后续独立改造。

完整英文契约见 [Forward runtime and API](../runtime.md)。
