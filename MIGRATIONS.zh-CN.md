# 版本与迁移

[English](MIGRATIONS.md) | [中文入口](README.zh-CN.md)

应用版本：`0.2.20`（未发布开发版）。英文 `MIGRATIONS.md` 是完整主契约。

0.2.20 不增加数据库迁移、不改配置 `schemaVersion`、不新增环境变量。新增可选的「静默回复哨兵」：`routing.silentReply` 为所有 `bridge` 群设默认值（`tokens` 缺省 `[]`，`card` 为 `"delete"` 或 `"complete"`，缺省 `"delete"`），`routing.groups[].silentReply` 可逐字段覆盖单个群，未写的字段继承全局，群上写 `"tokens": []` 即对该群关闭。不配置 token 时哨兵功能不生效。要生效，操作者需在私有 bridge.json 里给全局或相关群配置 token，例如 `"silentReply": { "tokens": ["NO_REPLY"] }`，跑 `check-config` 后重启一次实例。bridge 不会把 token 告诉 Agent，哨兵约定（例如「无需回复时只回 `NO_REPLY`」）要写进该群的群指令（`instructionFiles` / `instructionText`）或 Agent 工作区规则，字面值与配置一致。匹配规则：Agent 最终答复去掉首尾空白后与某个 token **精确相等**（区分大小写，不做前缀或包含匹配），私聊永不静默。命中后不发文字回复；`delete` 撤回执行卡（飞书只允许机器人撤回发送后 24 小时内自己发的消息，群里可能显示「撤回了一条消息」），撤回失败自动退化为 `complete`：把执行卡改为完成态并显示卡片文案 `silentReply`（缺省「已处理，无需回复。」），哨兵字面值不会出现在卡片或消息里。任务状态仍为 `completed`，结果 JSON 记 `silentReply: { "status": "silent", "card": … }`，日志记 `forward_reply` / `silent`（`reason` 为 `card_<值>`），不算失败。`card` 取值：`deleted` 已撤回；`completed` 已改为中性完成态；`none` 没有已确认的卡片，无需处理；`unchanged` 卡片存在但撤回和改卡都失败——此时任务退回 `reply_pending`（`last_error=silent_card_unchanged`），按 `codex.jobRetryMs` 间隔重试静默收尾，直到用满 `codex.jobMaxAttempts` 次回复尝试；仍失败才记 `completed` 并打 warning，卡片可能停在最后的执行中状态。以上任何情况都不发文字。

同版本起，撤回事件对所有群统一过滤（与是否配置 `silentReply` 无关）：实时 `im.message.recalled_v1`，或 history catch-up 读到的已删除消息，若其消息 ID 是 bridge 已记录的 bot 出站消息（执行卡、回复），仍照常入库并记墓碑，但不再转给 hook，也不作为群上下文。飞书撤回事件不带操作者，只能靠这张记录识别；查询失败时记 `recall_filter` warning 并按原逻辑转给 hook。依赖 hook 收到 bot 消息撤回的业务方需改为直接查飞书。

回退到 0.2.19：① 删掉 `routing` 与各 `routing.groups[]` 的 `silentReply`，否则旧版严格校验会拒绝启动；② 若 `feishu.cardTextFile` 指向的文案文件里自定义了 `silentReply` 键，也要删掉，否则 0.2.19 会判整个文案文件无效并退回默认文案；③ 切换前先确认没有待投递的静默任务，否则 0.2.19 会把哨兵原文当文字发进群，可用 `SELECT public_run_id, JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.answer')) AS answer FROM assistant_codex_forward_jobs WHERE connection_id='<connection-id>' AND status='reply_pending';` 查看，等到其中没有答复为哨兵的任务；④ 重启一次。已撤回的卡片不会恢复，hook 会重新收到 bot 消息的撤回事件。

0.2.15 热修增加只读 `GET /health/tasks` 任务失败汇总接口，不增加数据库迁移或配置变更。原 staging 0.2.15–0.2.18 依次顺延为 0.2.16–0.2.19；这四版均不增加数据库迁移。

0.2.5 的版本化迁移 004 让五张 assistant 运行时表以 `connection_id` 隔离，并为唯一键、恢复、历史和群上下文查询增加连接前缀索引；bridge 表保留原有归属，只调整必要的 claim 索引。配置 `schemaVersion` 仍为 1。一个进程仍只运行一个飞书 bot 和一个 Codex executor；升级后可让多个不同连接的进程使用同一个专用 bridge schema。

升级旧库前须停止全部旧版 writer，并备份 bridge 数据库及配套 workspace/outbox。只要五张 assistant 表中有旧行，必须显式运行 `agent-chat-bridge migrate --config <路径> --legacy-connection-id <原bot的connectionId>`；不能拿新 bot 的配置 ID 猜旧行归属。全空新库可省略此参数。004 在 DDL 前拒绝旧行缺参，持有旧版数据库级 writer 锁，记录归属，分步回填并核验；中断后只能用同一旧连接 ID 续跑，改 ID 会拒绝。已成功的 004 重跑不会再次归属。失败时保持 writer 停止；回退需恢复升级前的数据库及配套文件快照，不能删账本伪装回退。真实实例迁移和真实消息/模型验收需单独授权。

开发改动先进入 `staging` 集成和测试，稳定后再用 `staging` 到 `main` 的 PR 提升；`main` 继续作为默认分支。代码进入任一分支都不会自动迁移数据库、部署、发布 npm、创建或移动 tag，也不代表已经发布。详见 [staging 流程](docs/zh-CN/staging-workflow.md)。

涉及 schema 的改动必须连同不可变的向前迁移和回滚方案先进入 `staging`。只有在已授权备份并停止唯一 writer 后，才可对独立 staging 数据库显式执行 migrate；提升到 `main` 只保留这段已审迁移历史，生产迁移仍是单独授权的操作。

0.2.4 不增加数据库迁移；它恢复 app-server 空闲 60000 毫秒关闭、受控环境中的 `inherit=all`、共享 Codex HOME 默认值、原执行卡控制器、普通 post/text 回复、Typing 生命周期、私聊图片输入及直接附件投递。可选 `codex.sharedHome` 必须与继承的 `CODEX_HOME` 指向同一目录，显式 `codex.idleCloseMs: 0` 仍可关闭定时器；`feishu.replyAsPost` 缺省为 `true`，`feishu.maxOutputChars` 缺省为 `3500`。0.2.3、0.2.2 和 0.2.1 同样不增加数据库迁移。

迁移 002–003 只用于 bridge 自己的 MySQL schema：002 增加 Codex binding/event 表，003 增加 forward job、入站消息和消息事件表及所需索引/收据字段。表结构虽来源于冻结生产实现，但这不是 Kosbling 生产/P 原库的原地转换，也不是透明升级。

新开发实例应使用空的独立 schema，并显式运行 migrate；普通启动只校验迁移账本，不执行 DDL。已有 0.1.1 bridge 试用实例升级前，要先停唯一 writer，并把数据库与 workspace/outbox 一起备份。`schemaVersion` 仍为 1，但启动 0.2.6 前必须删除旧的整个顶层 `auth` 配置（包括空对象），否则严格校验会拒绝；不要删除仍用于 outbound hook 凭证的 `hooks[].tokenEnv`。公开 `/v1` run、event、resource、recovery、delivery 和 upload 接口已移除。本次不增加数据库迁移，也不自动清理历史 API/system 行。

应用 002–003 后，0.1.1 的严格 schema 校验不会接受新账本。回退必须先停 writer，再恢复升级前的 bridge 数据库及匹配文件快照，或让 0.1.1 使用另一份兼容 schema。不能删除迁移记录、指向生产/P 原库或重放未知外部效果来假装降级。

0.2.6 没有打 tag 或发布；现有 P 实例未改动。业务 producer 保留自己的调度、Codex 与投递链路，只消费 bridge hook。
