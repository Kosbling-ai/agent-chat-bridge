# Forward Runtime 中文补充

尚未发布的 0.2.4 开发版用一条带租约的 Codex forward worker 替换 0.1.1 的 generation worker；communication worker 只负责 hook 和已登记的消息 outbox。进程只持有一个飞书 bot/WebSocket 和一个 Codex app-server/executor。线程新建、恢复和 turn 启动使用协议定义的 `auto_review` 审批 reviewer。当前仅完成公开 bridge 代码与合成验证，Kosbling 业务 producer 的实际切换属于后续独立工作。

`codex.idleCloseMs` 只控制 bridge 活动归零后是否自动关闭其 app-server 子进程。原业务缺省值为 `60000` 毫秒；显式写 `0` 仍可关闭该定时器，其他值最大为 86400000。正常 shutdown 仍会关闭子进程，异常退出仍走既有故障处理。这不改变会话空闲两天、规则更新或归档时的 rollover。Codex 状态缺省使用启动用户共享的 `~/.codex`；可选 `codex.sharedHome` 与启动环境 `CODEX_HOME` 同时存在时必须解析到同一目录。app-server shell 继承策略只基于 bridge 传给子进程的受控环境。

群授权必须显式出现在 `routing.groups`。`capabilities` 只允许 `bridge`、`hook`，缺省两者都开，`[]` 表示两者都关。`bridge` 仍继续检查 @/all trigger 和可选 `userIds`；`hook` 只按自己的群授权与订阅过滤，不参加 Agent 路由、执行或回复。旧配置中只写在 `hooks[].conversationIds` 的群，需要补入 `routing.groups`，纯 hook 群可写 `capabilities:["hook"]`。

hook 只是带稳定 chat/message/event 标识的轻量通知。业务仍以 lark-cli 等自身查询接口为数据真源，并保留业务轮询兜底及双入口 messageId 去重；bridge 不迁入业务回补、历史同步、缓存或 cron，也不让业务另建飞书 WebSocket。

普通运行接口为 `POST /v1/runs`，接受可选 `executionNamespace` 与 `deliveryMode:"bridge"|"caller"`，仍返回 `202 {id,duplicate}`。bridge 模式负责 Typing、执行卡片、停止按钮、答案与附件；caller 模式只执行并保存结果，不自动发送这些飞书效果。`GET /v1/runs/:id` 分开暴露执行和投递状态，并保留 `rawAnswer`、native 与 held 事实；事件接口按该 run 的 binding/thread/chat/message 精确过滤且只返回安全公开投影。附件资源接口需通过相同会话授权，且不暴露本机绝对路径。

人工飞书请求在 native turn 尚未开始前遇到其他客户端持有会话写锁时，第一次明确的 `CODEX_THREAD_BUSY` 就终止本次请求，并只通过原卡片/回复链提示“会话被其他客户端占用，请释放后重试或新建会话。”bridge 保留原 binding，不新建会话，也不自动重放。其他明确可重试的入场失败默认最多 3 次，每次相隔 60 秒；`codex.jobRetryMs` 允许 10 秒到 30 分钟，`codex.jobMaxAttempts` 允许 1 到 10。

system 等待只授予已持久化且非空的 `executionNamespace`：它必须与认证 `callerId` 派生出并匹配该 run 保存的 system binding。sender/messageId/prompt 字符串或关闭 steering 都不能冒充。等待期间复用同一张 retrying 卡片并保持 Typing 关闭，确认入场后才激活一次。已绑定 turn 的观察失败、turn start 结果不明和未决 steer 核对失败始终进入 `held`，保留 native/intent 身份，不受重试次数影响。

执行卡恢复冻结生产控制器：首张运行卡立即创建，后续进度按间隔 patch，终态卡失败后走普通消息 fallback。sidecar 保存原消息 ID、状态、最多 24 条进度和停止身份；已有旧控制器写下的未确认卡片效果继续 held，不会重放。普通 fallback 用 chat create，缺省 post 按 3000 字分片并转换 Markdown，可选 text 按 1900 字分片；两者受 `feishu.maxOutputChars`（缺省 3500）限制。附件与 Typing 仍保留当前 intent/收据处理，文件只在发送收据落库后清理；Typing 结果不明时只核对原消息返回的前 50 条 reaction，并按 `operator_type=app` 与配置 emoji 匹配。

bridge 的投递状态包括 `waiting`、`pending`、`sent`、`failed`、`unknown`；caller 终态为 `not_requested`。投递失败或未知不会重跑已经完成的模型 turn。公开附件 `id` 是十进制资源索引，可直接用于 `/v1/runs/:id/resources/:index`。

已知 thread/turn 的恢复只观察，不重新提交；原生结果不确定时进入 held。`GET /v1/runs/:id/attempt`、`POST /v1/recoveries` 和 `POST /v1/sessions/reset` 在完成相应认证、管理权限和会话 scope 检查后返回 `409 unsupported_execution_model`，不会伪造 generation 或假装已登记恢复动作。`GET /v1/recoveries/:id` 只读取 communication schema 中真实存在的旧 recovery 记录，并保留原管理权限和会话检查；不存在时返回 404。

附件最多九件，公开 bridge 的读取/发送采用 **总计 28 MiB** 预算。这比冻结生产源“最多九件、每次上传单文件 28 MiB”更严格，属于公开边界，不应描述为原样复制。

迁移 002–003 只用于 bridge 自己的新 MySQL schema，并非把 Kosbling 生产/P 原库原地转换成 0.2.0。启动只校验迁移账本，不自动执行 DDL；新开发实例应使用空的独立 schema 显式迁移。已有 0.1.1 bridge 试用库如需升级，必须先停唯一 writer，并把数据库与 workspace/outbox 一起备份。应用 002–003 后回退 0.1.1 需要恢复旧库快照或使用另一份兼容 schema，不能删迁移记录假装降级。

0.2.4 目前只是开发版本号和变更记录：没有打 tag、发布，也没有真实飞书/Codex 验收。现有 P 实例保持不动，业务的定时提交、caller 结果消费与 hook 后 lark-cli 查询仍需后续独立改造。

完整英文契约见 [Forward runtime and API](../runtime.md)。
