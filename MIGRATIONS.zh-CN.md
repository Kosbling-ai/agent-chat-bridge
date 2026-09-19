# 版本与迁移

[English](MIGRATIONS.md) | [中文入口](README.zh-CN.md)

应用版本：`0.2.8`（未发布开发版）。英文 `MIGRATIONS.md` 是完整主契约。

0.2.5 的版本化迁移 004 让五张 assistant 运行时表以 `connection_id` 隔离，并为唯一键、恢复、历史和群上下文查询增加连接前缀索引；bridge 表保留原有归属，只调整必要的 claim 索引。配置 `schemaVersion` 仍为 1。一个进程仍只运行一个飞书 bot 和一个 Codex executor；升级后可让多个不同连接的进程使用同一个专用 bridge schema。

升级旧库前须停止全部旧版 writer，并备份 bridge 数据库及配套 workspace/outbox。只要五张 assistant 表中有旧行，必须显式运行 `agent-chat-bridge migrate --config <路径> --legacy-connection-id <原bot的connectionId>`；不能拿新 bot 的配置 ID 猜旧行归属。全空新库可省略此参数。004 在 DDL 前拒绝旧行缺参，持有旧版数据库级 writer 锁，记录归属，分步回填并核验；中断后只能用同一旧连接 ID 续跑，改 ID 会拒绝。已成功的 004 重跑不会再次归属。失败时保持 writer 停止；回退需恢复升级前的数据库及配套文件快照，不能删账本伪装回退。真实实例迁移和真实消息/模型验收需单独授权。

开发改动先进入 `staging` 集成和测试，稳定后再用 `staging` 到 `main` 的 PR 提升；`main` 继续作为默认分支。代码进入任一分支都不会自动迁移数据库、部署、发布 npm、创建或移动 tag，也不代表已经发布。详见 [staging 流程](docs/zh-CN/staging-workflow.md)。

涉及 schema 的改动必须连同不可变的向前迁移和回滚方案先进入 `staging`。只有在已授权备份并停止唯一 writer 后，才可对独立 staging 数据库显式执行 migrate；提升到 `main` 只保留这段已审迁移历史，生产迁移仍是单独授权的操作。

0.2.4 不增加数据库迁移；它恢复 app-server 空闲 60000 毫秒关闭、受控环境中的 `inherit=all`、共享 Codex HOME 默认值、原执行卡控制器、普通 post/text 回复、Typing 生命周期、私聊图片输入及直接附件投递。可选 `codex.sharedHome` 必须与继承的 `CODEX_HOME` 指向同一目录，显式 `codex.idleCloseMs: 0` 仍可关闭定时器；`feishu.replyAsPost` 缺省为 `true`，`feishu.maxOutputChars` 缺省为 `3500`。0.2.3、0.2.2 和 0.2.1 同样不增加数据库迁移。

迁移 002–003 只用于 bridge 自己的 MySQL schema：002 增加 Codex binding/event 表，003 增加 forward job、入站消息和消息事件表及所需索引/收据字段。表结构虽来源于冻结生产实现，但这不是 Kosbling 生产/P 原库的原地转换，也不是透明升级。

新开发实例应使用空的独立 schema，并显式运行 migrate；普通启动只校验迁移账本，不执行 DDL。已有 0.1.1 bridge 试用实例升级前，要先停唯一 writer，并把数据库与 workspace/outbox 一起备份。`schemaVersion` 仍为 1，但启动 0.2.6 前必须删除旧的整个顶层 `auth` 配置（包括空对象），否则严格校验会拒绝；不要删除仍用于 outbound hook 凭证的 `hooks[].tokenEnv`。公开 `/v1` run、event、resource、recovery、delivery 和 upload 接口已移除。本次不增加数据库迁移，也不自动清理历史 API/system 行。

应用 002–003 后，0.1.1 的严格 schema 校验不会接受新账本。回退必须先停 writer，再恢复升级前的 bridge 数据库及匹配文件快照，或让 0.1.1 使用另一份兼容 schema。不能删除迁移记录、指向生产/P 原库或重放未知外部效果来假装降级。

0.2.6 没有打 tag 或发布；现有 P 实例未改动。业务 producer 保留自己的调度、Codex 与投递链路，只消费 bridge hook。
