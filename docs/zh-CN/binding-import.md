# 受控导入会话绑定

`import-bindings` 是切换时使用的一次性运维命令。它只把现有 Codex thread 绑定写入 bridge 专用 schema，不会启动、恢复或写入 Codex thread，也没有对应的 HTTP API。

源端导出前必须停止新增 legacy producer，并确认 `pending`、`running`、`replyPending` 都为零。`unknown` 和 `held` 只保留为审计计数；对应 job 留在源库隔离，不会导入。apply 前还需停止旧 WebSocket owner。

快照必须严格符合版本 1，完整 JSON 结构见[英文说明](../binding-import.md)。未知字段、缺失字段和超长值都会被拒绝。私聊绑定保留原 open ID；群聊绑定必须等于 bridge 按准确 chat ID 计算的 group hash。每个旧 `system:*` identity 都必须提供唯一的 `legacyBindingOpenId + callerId + executionNamespace` 映射，目标 hash 由 importer 自己计算。不同 connection、identity 或 chat 不能共用同一个 native thread。

切换时必须在配置中显式设置 `codex.rolloverOnRulesUpdate:false`。规则更新 rollover 比较 native thread 创建时间和目标工作区规则文件 mtime，新复制工作区可能让导入绑定在第一条消息时被意外替换。importer 会保留源端真实时间，不会修改配置或伪造 native 时间。以后重新开启该选项，表示明确接受旧 thread 可能按新规则基线 rollover。现有 idle rollover 仍然生效；真实空闲时间超过配置阈值时可以正常换到新 thread。

快照文件应使用 `0600` 权限，并通过正常配置和环境变量引用数据库凭证。默认命令只预览，不写库：

```sh
agent-chat-bridge import-bindings --config /path/to/bridge.json --input /path/to/bindings.json
```

写入必须显式加 `--apply`，并重新执行全部检查：

```sh
agent-chat-bridge import-bindings --config /path/to/bridge.json --input /path/to/bindings.json --apply
```

apply 会取得目标 connection 的 writer lock，因此目标 bridge 服务必须停止；目标库存在 `pending`、`running`、`reply_pending` 或 `held` forward job 也会拒绝。全部新增绑定位于同一个事务中：已存在且 native thread 相同的绑定保持原值并作为幂等 no-op，不同绑定冲突会让整批失败。若 COMMIT 结果未知，使用同一快照重新检查；稳定 identity 会把已经提交的行识别为不改值的 no-op。
