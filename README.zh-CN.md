# agent-chat-bridge

[English](README.md) | 简体中文

英文文档和实际代码是主契约；API、配置字段、命令和结构化日志保持英文。

版本：`0.2.3`，当前为未发布开发版；0.1.1 是此前实现版本。0.2.3 默认在 bridge 服务存活期间保持其 Codex app-server，不再空闲 60 秒就关闭；它不发送 keepalive，也不改变共享 HOME 或原生写锁语义。人工会话被其他客户端占用时仍只向飞书返回一次明确失败。参见英文[更新记录](CHANGELOG.md)和[版本与迁移策略](MIGRATIONS.md)。

这是独立的飞书 + Codex bridge。一个进程持有一套飞书 bot/WebSocket 和一个 Codex app-server/executor；MySQL 使用 bridge 自己的 schema。communication worker 负责 hook 和已登记消息 outbox，唯一的 forward worker 负责 Codex 执行、恢复、卡片、Typing、停止和答案/附件投递。

群必须显式列在 `routing.groups`。`capabilities` 缺省为 `['bridge','hook']`，也可写 `['bridge']`、`['hook']` 或 `[]`。hook 按自己的订阅过滤，不依赖 Agent 的 @、成员过滤、执行或回复。业务继续以 lark-cli 等查询接口为数据真源，自己负责轮询兜底和 messageId 去重；hook 只是带稳定事件/群/消息标识的轻量通知。

`deliveryMode:'bridge'` 由 bridge 发卡片、Typing、答案和附件；`deliveryMode:'caller'` 只执行并保存 `rawAnswer`、安全进度和受控附件资源，不自动发消息。原生或投递结果未知时保留 `unknown` 供核对，不自动重跑模型或重发不确定效果。依赖旧 generation ledger 的 attempt 查询及 recovery/reset 写接口明确返回 `409 unsupported_execution_model`，普通 run/events/resource 契约继续可用。

当前只完成公开 bridge 代码、合成测试和离线实现审阅。没有真实飞书/Codex 验收、部署、打 tag、发布或 Kosbling 业务 producer 切换；现有 P 实例保持不动。详细契约见[中文补充](docs/zh-CN/forward-runtime.md)和英文[运行说明](docs/runtime.md)。

```sh
npm ci
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
npm test
npm run check
```

迁移或启动前只使用独立 bridge schema 和受控凭证注入。不要把 token 写入 JSON、`.env`、日志或版本控制。迁移边界见[中文说明](MIGRATIONS.zh-CN.md)。
