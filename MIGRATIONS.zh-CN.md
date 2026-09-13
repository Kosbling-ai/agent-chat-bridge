# 版本与迁移

[English](MIGRATIONS.md) | [中文入口](README.zh-CN.md)

英文为项目主语言；本页对应英文版本与迁移策略。

应用版本：`0.1.0`

`VERSION` 是应用发布版本。package.json、package-lock 两处根版本、README 和 CHANGELOG 必须一致；`npm run version:check` 和 `npm run check` 会校验。使用明确的 `MAJOR.MINOR.PATCH`，0.x 表示初期开发。每个交付批次升一次版本，不逐修复升版。已发布标签不得移动，已发布版本历史不得重写；之后修复使用新版本。仅文档修正无需空迁移或升版。

应用版本、配置 `schemaVersion` 和数据库迁移序号是独立契约，不机械同步递增。启动检查数据库迁移记录与 checksum；只有显式 migrate 命令执行 DDL。已应用的 SQL 不可修改。初版之后的结构变化要新增顺序迁移及相应执行器支持，不修改 001。MySQL DDL 不能整体事务回滚，不承诺自动 down migration。

## 0.1.0 首次安装

本版面向全新专用 MySQL 8.4 数据库和配置 schema 1，不导入或修改既有 Kosbling 数据库。选择归运行用户所有的 Agent 工作区，通过宿主受控秘密机制注入凭证；不提交本机配置或秘密。配置和显式迁移命令见[运行说明](docs/zh-CN/runtime.md)。

升级既有本机试装前，停止 writer，将数据库备份与 Agent 工作区/媒体目录一起保存。初始 schema checksum 不同的开发数据库不能靠静默改迁移记录升级：应使用另行评审的保数据迁移，或明确丢弃仅供模拟测试的一次性数据库并新建。不能为让启动通过而重置真实数据库。

启动前检查版本、语法和配置。按[本机验证清单](docs/zh-CN/local-validation.md)确认 schema、健康就绪、授权范围内的发送与恢复。这些检查不等于平台验收通过。当前版本不增加宿主的自动版本接受标记或部署流程。

回滚时先停止 bridge，再选择旧代码版本。仅在 schema 兼容时复用数据库；否则由操作人员受控恢复事先保存的数据库和文件系统备份。恢复前核对已经发生的外部发送效果，不能通过重发 unknown 消息或重启未知原生尝试来简化回滚。

## 源码发布

发布提交记录版本和变更；获授权后，可用 annotated `v0.1.0` 标签标识精确源码快照。GitHub 公开源码、GitHub Release、npm 发布和生产部署是不同操作。保留 `private: true`；不能仅因代码已推送就部署、发 npm 或宣称真实平台验收通过。
