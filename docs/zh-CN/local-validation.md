# 待完成的本机验证

[English](../local-validation.md) | [中文入口](../../README.zh-CN.md)。英文为主语言。

最新资源退役 worker、输入/输出独立 SQL 游标与仅错误通知的原生恢复，经过源码评审、语法和快速依赖注入测试。按暂停真实/端到端测试的要求，这些新增集成路径尚未在 MySQL、真实机器人/模型上验证。此前隔离 MySQL/模拟平台证据只覆盖当时冻结单元，不能认证后续变化。

恢复本机测试时，先用隔离数据库和模拟平台。harness 每次只接受一个测试路径，结束清理临时容器；不要让多套测试共用同一 schema。

```sh
node scripts/test-storage.mjs test/storage-resources.integration.test.mjs
node scripts/test-storage.mjs test/core-resource-retirement.integration.test.mjs
node scripts/test-storage.mjs test/core.integration.test.mjs
```

用“已完成输出历史 + 当前线程保留输入积压”检查新索引/执行计划。验证空输出及时回收、native/adopt 活动阻止删除、seal/delete/ack 中断可恢复、资源退役线程不能重新绑定/adopt；验证入站目录删除的持久性及输出源版本 claim 跨重启保留。

再核显式本机运行配置、readiness 和有序退出。之后任何真实飞书/Codex 测试都应使用指定测试应用、工作区和会话，覆盖私聊 image/post、群授权、catchup/live 首次去重、hook 持久 ACK、上传/发送前驱顺序，以及无 terminal 通知的非重试错误。未知 admission/upload 应可观测而不自动重放。不能默认指向原业务机器人或生产数据库。

兼容差异是有意的：不复刻前驱/孤儿自动中断，而以原生 ID、持久 admission 和审计核对保留未知工作。仅错误观察改为读取已知原生状态，不重复旧本地 promise 拒绝/transport 重试链。输入资源封存删除后永久禁止重新 adopt 对应线程。

本清单不包含部署、迁移已有业务状态、创建远端仓或发布操作。
