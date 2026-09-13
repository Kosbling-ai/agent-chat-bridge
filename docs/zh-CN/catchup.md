# 接收缺口补收

[English](../catchup.md) | [中文入口](../../README.zh-CN.md)。英文为主，本文对应英文契约。

`src/core/catchup.mjs` 的 `createCatchup` 仅轮询 bridge 自身的接收缺口，不查询业务表、不等业务完成、不重建编辑流、不取消 Agent turn。Kosbling 保留业务历史核对和 SDK/CLI 读取。历史能力仅供适配器内部使用，不是公开代理。

## 接入契约

构造参数为 `{connectionId,botOpenId,chat,store,onEvent,listConversations,log}`。`chat.listMessages` 使用既有有界飞书方法，按创建时间升序。`store.getCursor/setCursor` 使用版本化 CAS。`onEvent(event,{signal})` 必须在 inbox/路由持久化后完成；即使平台 event ID 不同，也必须按 connection + conversation + message ID 原子去重 live/history。已登记消息的历史内容变化不会新建 Agent 运行或合成编辑 hook，编辑由业务核对处理。不能只按 event ID 去重就接入补收。

`listConversations()` 返回最多 1000 个唯一、已授权的 `{conversationId,conversationType:'p2p'|'group'}`。宿主结合当前 Agent/hook 群范围和 Store 有界分页的已知私聊；入站时再次核私聊用户授权。不能枚举机器人可见的全部聊天。没有任何已接收消息的首次私聊无法由此算法发现，不从 user ID 猜 chat ID。范围超限必须拒绝或显式分区，不能静默丢会话。

`historyMessageEvent` 映射 SDK 1.60.0 的 message.list 形态：body、sender ID 类型、平铺 mention IDs、父消息和时间。`source=history_catchup`、`message.updated` 与 revision 只保留为事实，不保证顺序。显式 `deleted:true` 转为撤回观察；列表中缺失不证明已撤回。未知 sender ID 类型保持未知，不猜成授权 open ID；chat ID 不匹配会在接收前拒绝整页。

`runOnce()` 合并并发调用，返回 `{conversations,pages,received,failed,incomplete}`。`start()` 立即轮询，之后间隔运行；Store 关闭前调用 `stop()`。停止会中断等待、忽略晚到读取结果。回调/适配器默认预算 15 秒，其自身更短的 Store/HTTP 超时仍生效。晚到持久接收只有在实现上述 canonical 去重时才安全。整页所有接收回调完成前不得推进检查点。

## 持久窗口与限制

游标 key 为 `catchup:` 加 conversation ID 的 SHA-256，按 connection 隔离。value 是 `{schemaVersion:1,throughMs,window:{startMs,endMs,pageToken}|null}`。读取第一页前先持久登记固定、按秒对齐的窗口；整页接收后保存下一 token，只有明确末页才推进 throughMs。停止、接收失败或游标响应丢失可重放页面，但不能重复效果。持久分页避免到达单轮页数预算时漏掉同一时间戳的密集消息。

默认间隔 60 秒、首次回看 3 小时、重叠 5 分钟、每页 50 条、每会话每轮 20 页，请求前抖动 500–1000ms。已知窗口恢复时不重新套回看上限。回看/重叠沿旧私聊传输默认值；业务降序扫描、产品/OCR 窗口和 processed 状态不属于本模块。这些限制不保证平台历史保留期或快照一致性。

畸形页、缺少/重复 continuation token、API 或接收失败均保留检查点，记录脱敏 warning 后下一轮重试。平台 token 过期可能要受控修复游标，从同一固定窗口重启；不会跳到当前时间掩盖错误。不记原始错误、正文、游标 token 或用户 ID。日志失败被隔离；宿主负责终态错误上报，本模块不会将读取/接收重试伪装成业务终态失败。

## 验证边界

`node --test test/catchup.test.mjs` 覆盖密集时间戳分页、重启、接收响应丢失、畸形/跨聊天页、停止、回声过滤和回调隔离。`node scripts/test-storage.mjs test/catchup.integration.test.mjs` 使用隔离 MySQL 和模拟历史 API 验证持久页重放；两者不接触飞书或模型。

模块需要宿主装配与 Store canonical 首次接收/已知会话支持。独立模块测试不能证明最终 live/history 并发正确性，仍需检查完整 Store/runtime。不包含生产切换或公开读 API。
