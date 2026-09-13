# 职责边界

[English](../boundaries.md) | [中文入口](../../README.zh-CN.md)。项目以英文为主，本文为中文对应说明。

- **飞书 client**：持有机器人 WebSocket，在持久接收后确认。公开操作仅包括限定范围的发送、回复、上传和 reaction 写入。消息查询供内部回复/reaction 授权，历史读取供接收缺口补收，资源下载供私聊 Agent 图片；不提供通用飞书读代理。
- **Core**：负责会话路由、持久执行/指导意图、原生通知恢复、回复发送和带审计的管理动作。同一条消息可独立触发 hook 和 Agent。hook ACK 表示持久接收，不代表业务处理完成。
- **Codex 适配器**：负责子进程/stdio RPC、有限超时、已知 server-request 策略和协议错误分类。工作区和环境来自显式可信配置；调用者不能覆盖审批策略、sandbox 或 cwd。其他 Agent/chat 只是扩展边界，尚无已实现 provider。
- **Store**：独立 MySQL schema，含版本化迁移、inbox/jobs/sessions/outbox 和永久原生线程归属。消费者使用服务 API/hooks，不直接操作表；不包含业务 schema 或凭证。
- **静态 hooks**：声明 URL、token 环境变量引用和会话范围。消费者保留自己的持久接收、业务状态、重试、核对及 SDK/REST/lark-cli。可选 catchupGroupIds 显式声明群；任意 conversation ID 不自动确定聊天类型。
- **媒体**：使用受控工作区目录和不透明内部引用。输入文件在原生恢复仍可能引用时保留。输出上传/发送是有序的独立效果，只有确认发送后才持久登记清理。未知效果不会因文件年龄被删除。
- **服务 API**：所有任务、聊天、管理请求均认证并核会话范围。可信管理员恢复要求审计证据、固定工作区/原生 turn 验证，以及 Store 代数/归属检查；不提供强制重试或任意文件系统访问。

Kosbling 仍是 Agent 侧业务环境和 hook 消费者。文档、多维表格、通讯录和业务历史/编辑核对留在那里；bridge 不包装全部飞书 API、不引入 lark-cli，也不需要动态订阅注册表、工作流框架或 UI。

就绪状态反映真实 Store/writer、Codex、飞书连接和 worker 状态，不通过假的适配器/Store 报绿。秘密只经环境变量引用注入；公开仓不复制生产凭证、私有业务规则或原生 Agent 状态。本地集成测试不代表部署或发布。
