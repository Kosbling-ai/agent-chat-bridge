# agent-chat-bridge

[English](README.md) | 简体中文

项目以英文为主语言；本页及中文文档对应英文原版，存在差异时以英文文档和实际代码契约为准。API、配置字段、命令和结构化日志保持英文。

版本：`0.1.0`，初始开发版本。参见[更新记录](CHANGELOG.zh-CN.md)和[版本与迁移策略](MIGRATIONS.zh-CN.md)。

独立运行的飞书 + Codex 桥接进程。业务代码、Skills/MCP，以及文档、表格 API 留在 Agent 工作环境或 hook 消费者中。

运行时装配 MySQL、Codex app-server、唯一的飞书 WebSocket 持有者、限定会话范围的 hooks，以及需要认证的任务/聊天 API。已实现私聊图片输入、Agent 产物文件发送、首次接收缺口补收、持久化执行中指导、带审计的恢复、空闲/规则更新/归档线程替换，以及封存后的资源退役。业务编辑核对、文档/多维表格/通讯录工具仍在 bridge 之外。参见[能力矩阵与运行边界](docs/zh-CN/runtime.md)。

先前的隔离 MySQL 测试使用模拟平台。最新的资源退役/游标和仅错误通知恢复改动经过快速单元与源码检查，新增集成路径仍待后续本机测试。尚未完成真实机器人/模型验收，也未替换生产运行。[本机验证清单](docs/zh-CN/local-validation.md)记录剩余验证，包括与旧前驱/孤儿运行中断行为的明确差异。

需要 Node.js 24.x、npm 和 MySQL 8.4。依赖锁定在 package-lock.json。默认测试不使用真实平台或业务数据库。

```sh
npm ci
node bin/agent-chat-bridge.mjs --help
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
```

迁移或启动前，配置显式环境变量引用和归运行用户所有的工作区。不要把 token 写入 JSON、`.env`、日志或版本控制。参见[运行配置与 API](docs/zh-CN/runtime.md)、[Store](docs/zh-CN/storage.md)、[Codex 适配器](docs/zh-CN/codex-adapter.md)、[职责边界](docs/zh-CN/boundaries.md)。

原 config.example.json 仍是仅健康检查的配置：live=200、ready=503。完整运行配置根据组件的真实状态报告就绪；存活不等于平台已就绪。

```sh
npm test
npm run check
node scripts/test-storage.mjs test/core.integration.test.mjs
```

npm 发布仍被禁用（`private: true`）。公开源码仓地址为 [Kosbling-ai/agent-chat-bridge](https://github.com/Kosbling-ai/agent-chat-bridge)；创建、推送源码与部署、平台验收是不同操作。尚未完成生产替换。许可证仍待决定：公开可见不自动授予开源许可。参见[来源说明](docs/zh-CN/provenance.md)。
