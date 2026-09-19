# agent-chat-bridge

[English](README.md) | 简体中文

英文文档和实际代码是主契约；API、配置字段、命令和结构化日志保持英文。

版本：`0.2.7`，当前为未发布开发版；0.1.1 是此前实现版本。0.2.5 增加多 bot 共用专用 bridge MySQL schema 所需的迁移 004，旧 assistant 数据必须显式指定原 bot 的连接 ID；还可把 Codex 支持的用户提问映射为当前 turn 的独立飞书卡片，由原发送者一次提交多道单选或自由填空。此能力默认禁用，需显式配置 `codex.requestUserInput:true` 才启用；secret 提问会被拒绝，过期或断线后的请求不能恢复。0.2.4 恢复原业务的 Codex 宿主默认值、执行卡控制器、普通 post/text 回复、Typing、私聊图片和直接附件投递路径。参见英文[更新记录](CHANGELOG.md)、[版本与迁移策略](MIGRATIONS.md)和[staging 流程](docs/zh-CN/staging-workflow.md)。

这是独立的飞书 + Codex bridge。一个进程持有一套飞书 bot/WebSocket 和一个 Codex app-server/executor；MySQL 使用 bridge 自己的 schema。communication worker 负责 hook 和已登记消息 outbox，唯一的 forward worker 负责 Codex 执行、恢复、卡片、Typing、停止和答案/附件投递。

群必须显式列在 `routing.groups`。`capabilities` 缺省为 `['bridge','hook']`，也可写 `['bridge']`、`['hook']` 或 `[]`。hook 按自己的订阅过滤，不依赖 Agent 的 @、成员过滤、执行或回复。业务继续以 lark-cli 等查询接口为数据真源，自己负责轮询兜底和 messageId 去重；hook 只是带稳定事件/群/消息标识的轻量通知。

业务系统只通过 hook 接入 bridge，并继续使用自己的原生 SDK、Codex、调度与消息投递链路。bridge 不公开 run、event、resource、upload 或消息投递接口；HTTP 监听器只提供健康检查。bridge 内部仍为人类飞书会话发送执行卡、Typing、答案和附件，并把未知原生或投递结果保留为待核对状态，不自动重跑模型或重发不确定效果。

当前只完成公开 bridge 代码、合成测试和离线实现审阅。没有真实飞书/Codex 验收、部署、打 tag、发布或 Kosbling 业务 producer 切换；现有 P 实例保持不动。详细契约见[中文补充](docs/zh-CN/forward-runtime.md)和英文[运行说明](docs/runtime.md)。

```sh
npm ci
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
npm test
npm run check
```

迁移或启动前只使用独立 bridge schema 和受控凭证注入。不要把 token 写入 JSON、`.env`、日志或版本控制。迁移边界见[中文说明](MIGRATIONS.zh-CN.md)。
