# 版本与迁移

[English](MIGRATIONS.md) | [中文入口](README.zh-CN.md)

应用版本：`0.2.1`（未发布开发版）。英文 `MIGRATIONS.md` 是完整主契约。

0.2.1 不增加数据库迁移，只修正 Codex app-server 新建与恢复线程使用的审批 reviewer 枚举。

迁移 002–003 只用于 bridge 自己的 MySQL schema：002 增加 Codex binding/event 表，003 增加 forward job、入站消息和消息事件表及所需索引/收据字段。表结构虽来源于冻结生产实现，但这不是 Kosbling 生产/P 原库的原地转换，也不是透明升级。

新开发实例应使用空的独立 schema，并显式运行 migrate；普通启动只校验迁移账本，不执行 DDL。已有 0.1.1 bridge 试用实例升级前，要先停唯一 writer，并把数据库与 workspace/outbox 一起备份。`schemaVersion` 仍为 1，但要复核 `routing.groups[].capabilities`、API 的执行/投递状态拆分、十进制字符串事件游标和管理接口 `409`。

应用 002–003 后，0.1.1 的严格 schema 校验不会接受新账本。回退必须先停 writer，再恢复升级前的 bridge 数据库及匹配文件快照，或让 0.1.1 使用另一份兼容 schema。不能删除迁移记录、指向生产/P 原库或重放未知外部效果来假装降级。

0.2.1 没有打 tag 或发布；现有 P 实例未改动。业务 producer 的定时提交、caller 结果消费和 hook 后 lark-cli 查询仍需另行评审与实现。
