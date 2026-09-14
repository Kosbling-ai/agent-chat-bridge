# Forward Runtime 中文补充

尚未发布的 0.2.4 开发版用一条带租约的 Codex forward worker 替换 0.1.1 的 generation worker；communication worker 只负责 hook 和已登记的消息 outbox。进程只持有一个飞书 bot/WebSocket 和一个 Codex app-server/executor。线程新建、恢复和 turn 启动使用协议定义的 `auto_review` 审批 reviewer。当前仅完成公开 bridge 代码与合成验证，Kosbling 业务 producer 的实际切换属于后续独立工作。

`codex.idleCloseMs` 只控制 bridge 活动归零后是否自动关闭其 app-server 子进程。原业务缺省值为 `60000` 毫秒；显式写 `0` 仍可关闭该定时器，其他值最大为 86400000。正常 shutdown 仍会关闭子进程，异常退出仍走既有故障处理。这不改变独立的会话 rollover；后者的闲置缺省值为五天（`432000000` 毫秒），规则更新或归档触发也保持原样。Codex 状态缺省使用启动用户共享的 `~/.codex`；可选 `codex.sharedHome` 与启动环境 `CODEX_HOME` 同时存在时必须解析到同一目录。app-server shell 继承策略只基于 bridge 传给子进程的受控环境。

`codex.requestUserInput` 缺省为 `false`。bridge 启动时检查当前 Codex 可执行文件是否提供 Default 模式用户提问功能；若存在，会显式传入 `features.default_mode_request_user_input=false`，覆盖共享 Codex home 继承的设置，并防御性拒绝意外收到的请求。显式设为 `true` 才选择启用，同一探测只在确认支持时打开该功能。功能不可用不会阻断其他执行，但 Codex 不能打开飞书提问卡。此配置控制 bridge 当前使用的 Default 模式功能；bridge 不会启动 Plan 模式工作流。

受支持的提问会为当前 active turn 创建一张独立飞书表单，可以一次包含多道题；每题接受一个已有选项、允许的“其他”输入或自由填空。只有原消息发送者能在原聊天中提交，bridge 会重新核对当前 job、卡片、授权、thread 和 turn。只要一批请求中包含 secret 提问，整批就会在展示和收集内容前被拒绝；普通飞书表单不是秘密输入通道。

首版 bridge 最多接受 3 道题、每题 20 个选项、每个自由填写答案 1000 字符，并把渲染后的卡片限制在 28 KB。它们是 bridge 与飞书投递限制，不是 Codex 协议上限；超限请求会被明确拒绝，不会截断问题或答案。

提交只接受一次。“已提交”表示 bridge 已接受表单并尝试交给仍存活的 native 请求，不表示 Codex 已经消费答案。native 已解决、停止执行、turn 完成或失败、app-server 断线、服务关闭都会让旧卡失效。bridge 不伪造超时答案，不在重启后恢复旧 RPC，也不重放 prompt 或答案。

群授权必须显式出现在 `routing.groups`。`capabilities` 只允许 `bridge`、`hook`，缺省两者都开，`[]` 表示两者都关。`bridge` 仍继续检查 @/all trigger 和可选 `userIds`；`hook` 只按自己的群授权与订阅过滤，不参加 Agent 路由、执行或回复。旧配置中只写在 `hooks[].conversationIds` 的群，需要补入 `routing.groups`，纯 hook 群可写 `capabilities:["hook"]`。

hook 只是带稳定 chat/message/event 标识的轻量通知。业务仍以 lark-cli 等自身查询接口为数据真源，并保留业务轮询兜底及双入口 messageId 去重；bridge 不迁入业务回补、历史同步、缓存或 cron，也不让业务另建飞书 WebSocket。

普通运行接口为 `POST /v1/runs`，接受可选 `executionNamespace` 与 `deliveryMode:"bridge"|"caller"`，仍返回 `202 {id,duplicate}`。bridge 模式负责 Typing、执行卡片、停止按钮、答案与附件；caller 模式只执行并保存结果，不自动发送这些飞书效果。`GET /v1/runs/:id` 分开暴露执行和投递状态，并保留 `rawAnswer`、native 与 held 事实；事件接口按该 run 的 binding/thread/chat/message 精确过滤且只返回安全公开投影。附件资源接口需通过相同会话授权，且不暴露本机绝对路径。

普通任务收到 `CODEX_THREAD_BUSY` 后第一次即走失败投递，即使 turn/start 的原生接收结果仍未知，也不等待下一次 claim；原卡片/回复链提示“会话被其他客户端占用，请释放后重试。原会话绑定保持不变。”其他可重试入场失败默认最多 3 次、每次相隔 60 秒；`codex.jobRetryMs` 允许 10 秒到 30 分钟，`codex.jobMaxAttempts` 允许 1 到 10。bridge 不自动新建会话或更换原 binding。

真实飞书用户已有 binding 时，busy 失败卡片提供“保留历史并新建会话”。只有原消息发送者可点击，回调会重新核对当前 bot 范围内的 job、卡片、聊天、授权和冻结的源线程；它只执行一次显式 `thread/fork`，使用当前 bridge 的工作目录与权限默认值，并在同一 binding admission 锁内完成持久化与旧线程 CAS 切换。该操作不 resume/interrupt 源线程、不启动 turn，也不重放失败消息。原生明确拒绝或 binding 已变化时保留当前 binding；原生结果或数据库提交结果未知时会记录为未确认，不会自动重试，需管理员核查持久状态。跨进程 writer 占用时 native 是否支持 fork 取决于 Codex 实现，bridge 会将拒绝作为可见失败处理，不假定一定成功。

忙碌排队例外只授予配置中显式启用 `queueIfBusy` 的认证客户端：已持久化且非空的 `executionNamespace` 必须与认证 `callerId` 派生出并匹配该 run 保存的 system binding。请求 payload、sender/messageId/prompt 字符串或关闭 steering 都不能冒充。等待期间复用同一张 retrying 卡片并保持 Typing 关闭；恢复流程不再添加 Typing。

执行卡恢复冻结生产控制器：首张运行卡立即创建，后续进度按间隔 patch，终态卡失败后走普通消息 fallback。sidecar 保存原消息 ID、状态、最多 24 条进度和停止身份；已有旧控制器写下的未确认卡片效果继续 held，不会重放。普通 fallback 用 chat create，缺省 post 按 3000 字分片并转换 Markdown，可选 text 按 1900 字分片；两者受 `feishu.maxOutputChars`（缺省 3500）限制。live 执行前会等待原 Typing reaction 添加；失败时发送一次配置的文字 fallback。最终清理失败不阻断已完成回复；恢复只清理消息事件中仍开放的 reaction 及飞书第一页中相同 emoji 的 app reaction，不重放未确认添加。

私聊支持单图和 post 内图片，下载路径按原格式追加到文字 prompt；群聊只保留文字，忽略媒体。`mediaMaxBytes` 是原实现下载后的告警阈值，不会拒绝图片。bridge 模式直接投递 executor 返回的路径：私聊允许，群聊沿现有 bridge/API 会话 allowlist；单文件上限 28 MiB，成功后删除，单件失败保留文件且不阻断文字或其他附件。旧未确认附件 intent 不重放。

bridge 的投递状态包括 `waiting`、`pending`、`sent`、`failed`、`unknown`；caller 终态为 `not_requested`。投递失败或未知不会重跑已经完成的模型 turn。caller 附件快照的公开 `id` 是十进制资源索引，可用于 `/v1/runs/:id/resources/:index`；bridge 成功发送后会删除路径文件，因此不承诺之后仍可下载，查询可能返回不存在。

恢复循环先串行处理 reply-pending，再串行处理最多 5 条可执行任务，并阻止重入。已有 start intent、bound/native identity、未知 native 结果或未确认投递效果的旧行保持隔离，不重新提交或重发。`GET /v1/runs/:id/attempt`、`POST /v1/recoveries` 和 `POST /v1/sessions/reset` 在完成相应认证、管理权限和会话 scope 检查后返回 `409 unsupported_execution_model`，不会伪造 generation 或假装已登记恢复动作。`GET /v1/recoveries/:id` 只读取 communication schema 中真实存在的旧 recovery 记录，并保留原管理权限和会话检查；不存在时返回 404。

迁移 002–003 只用于 bridge 自己的新 MySQL schema，并非把 Kosbling 生产/P 原库原地转换成 0.2.0。启动只校验迁移账本，不自动执行 DDL；新开发实例应使用空的独立 schema 显式迁移。已有 0.1.1 bridge 试用库如需升级，必须先停唯一 writer，并把数据库与 workspace/outbox 一起备份。应用 002–003 后回退 0.1.1 需要恢复旧库快照或使用另一份兼容 schema，不能删迁移记录假装降级。

0.2.4 目前只是开发版本号和变更记录：没有打 tag、发布，也没有真实飞书/Codex 验收。现有 P 实例保持不动，业务的定时提交、caller 结果消费与 hook 后 lark-cli 查询仍需后续独立改造。

完整英文契约见 [Forward runtime and API](../runtime.md)。
