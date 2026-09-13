# 运行时与 API

[English](../runtime.md) | [中文入口](../../README.zh-CN.md)。项目以英文为主；配置、API 和日志标识符保持英文。

本阶段装配独立飞书 + Codex 进程及 MySQL Store，已用模拟平台协议和隔离真实 MySQL 做本地验证。尚未通过真实机器人/模型验收，也不是旧应用全部聊天功能迁移完成的声明。

## 启动与配置

用 `examples/bridge.json` 了解配置结构，替换 ID、可执行文件和工作区路径。路径相对配置文件解析；`codex.bin` 是显式文件路径，不查 PATH。工作区必须归 runtime UID 所有，工作区和可执行文件都不能全局可写。构造策略固定为 approvalPolicy=never、sandbox=workspace-write，HTTP 调用者不能覆盖策略或 cwd。子进程只复制 codex.envNames 列出的变量；选择 HOME/CODEX_HOME 即赋予 Codex 对该显式原生环境的访问，操作方应配置受限 Agent 工作区/账号。

秘密只在 start/migrate 时从显式命名环境变量解析，不读 `.env` 或仓库凭证。check-config 只验证结构。API token 至少 24 字符、彼此不同；每个 client 显式列会话和 admin 布尔值，没有通配或默认全权限。健康接口公开且只包含固定组件状态。

以下命令从仓库根目录运行：

```sh
node bin/agent-chat-bridge.mjs check-config --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs migrate --config ./examples/bridge.json
node bin/agent-chat-bridge.mjs start --config ./examples/bridge.json
```

迁移是显式动作，应使用部署环境受控迁移凭证；start 只校验 schema 并取得单 writer 锁。仅含 schemaVersion/listen 的配置仍是健康模式，ready=503。provider 配置不完整则拒绝；旧健康模式的 auth.tokenEnv 占位不授予 API 权限。

`/health/ready` 要求 Store schema/writer 健康、Codex 握手成功、飞书 socket 真实 OPEN、worker 运行；`/health/live` 只检查 HTTP 进程。SIGTERM/SIGINT 依次停止 HTTP 接纳和飞书入站、排空 worker、关闭 Codex/Store/错误上报，未知工作保留在持久层。固定 SDK 关闭后仍留缓存 interval，因此 CLI 清理后显式退出；嵌入宿主需考虑此限制。

## 路由与执行

私聊要求 actor.openId 位于 privateUserIds。群必须显式配置，再按 mention 或 all 触发；默认允许群内人类成员，可选 group.userIds 才收窄范围，空列表不允许任何人。hook 会话范围独立于 Agent 用户/群准入。自己/应用消息不触发 Agent 或 hook。被动上下文是独立的显式群策略，只含已准入但未触发 Agent 的人类消息。重复输入沿用首次路由快照。撤回 tombstone 排除被动上下文，即使撤回先到；撤回不会启动新模型 turn。

飞书 handler 完成前，inbox 和独立 agent/hook job 必须提交。Agent 在原生 RPC 前持久登记 attempt；thread/turn 绑定由租约和 generation 隔离。原生通知在 admission 记账前先持久缓冲，之后按 thread/turn 关联。随机接收 key 保留重复 delta 为独立接收事实，不是语义去重键。终态效果采用稳定 per-run outbox key 和原子 fenced completion。

已知接纳 turn 可通过 thread/read 恢复；正常退出保留 pending，而不把已知 admission 改为 unknown。缺少原生 admission ID 则 status=unknown、锁会话、不自动重放，GET run 可见。可信管理员可走后述 adopt_turn/abandon_verified 审计流程。

同会话新任务在已知活跃 turn 可用时登记持久 steering 意图。明确拒绝或暂不能 steer 时持久延期，之后继续共享线程。reset 要求 admin、会话授权和精确 generation，拒绝 active/unknown。每 turn 最多读 100 条被动上下文。沿旧行为，撤回不追溯取消 Agent job；补收只填首次缺口，不公开编辑流。

RPC 错误按阶段分类：本次 thread/turn 接纳被明确拒绝，可失败并释放会话；原生读取（含终态通知后的最终 item 读取）被拒绝，不能证明已接纳 turn 执行失败。已知 attempt 保持 pending 和绑定，后续读取成功即可继续发送，不新建 turn/start。

静态 hook 配置 `{id,url,tokenEnv,conversationIds}`。交付为 `{deliveryId,event}`，带 `Idempotency-Key: deliveryId`。消费者必须先持久接收/去重，再返回 **204**；这是接收确认，不代表业务完成。禁止重定向，请求 3 秒超时、立即取消响应体，最多 8 次尝试。hook 失败不重建 Agent 输出。业务消息/历史/成员/资源查询及文档/Base API 留业务进程；已有 SDK/REST 读逻辑无需强改 lark-cli。

## 认证 HTTP API

所有 `/v1/` 操作要求 `Authorization: Bearer <token>`。运行/交付读取核对持久 connection 和 conversation 归属；回复/reaction 写入登记前，在内部校验平台消息所属会话。不接受调用者覆盖 actor、connection 或 workspace。

| 端点 | 契约 |
| --- | --- |
| POST /v1/runs | `{conversationId,idempotencyKey,text}` → 202 `{id,duplicate}`；text ≤64 KiB UTF-8，含转义 JSON ≤512 KiB |
| GET /v1/runs/:id | 持久 status/result/errorCode/时间戳 |
| GET /v1/runs/:id/events | after 序号、limit 1–100，只读 |
| POST /v1/deliveries | 通用 `{conversationId,idempotencyKey,kind,...}` → 202，种类见下 |
| GET /v1/deliveries/:id | 持久交付 status/result/errorCode |
| POST /v1/sessions/reset | `{conversationId,generation}`，要求 admin，busy/conflict=409 |

create/reply 接受 messageKind=text|post|interactive|image|file 和平台 content 对象；text 也可为字符串。reply 的 messageId 必须属于同一授权会话。reaction 使用 messageId+emojiType 添加，或 reactionId 删除。upload 接受 mediaType=image|file 和 base64；file 还需 fileName。上传上限 2 MiB，字节持久化在独立 Store；之后用返回 key 发授权 image/file 消息。两者是独立效果，不假称原子发送。content 上限 20 KB，不支持操作返回 422，不接受内联源文件路径。

create/reply 在 Store 保守 55 分钟窗口内保持平台 UUID 重试。长回复的分片有持久前驱链，仅前片确认 sent 后后片可领取，重启也保持顺序。前片失败阻断后片，运行变 delivery_failed，不重新执行模型。未知 upload/reaction 留待核对，绝不自动重复；unknown 与 failed 是不同 API 状态。

## 能力矩阵与剩余工作

| 能力 | 本阶段状态 |
| --- | --- |
| 入站文字→Codex→文字回复 | 已实现；真实 Store+模拟平台测试 |
| 私聊 image/post→Agent | 内部图片下载、文本路径提示；prepare 前 job 已持久化，已知 attempt 恢复跳过下载 |
| 群 post / 私聊 file/audio/media | 群只取文字；原不支持的私聊二进制类型明确拒绝 |
| 出站 text/post/interactive/image/file | 持久 create/reply API 已接适配器，未真实平台验收 |
| Agent 私聊产物文件 | 快照→上传→前驱确认发送→持久清理；未知上传暂停 |
| reaction 增删 | 写 API/适配器已接，未知写入暂停 |
| image/file 上传 | 有界持久 API 已接，未知上传暂停 |
| 内部资源/历史读取 | 仅 Agent 媒体和补收；业务读取不在公开 API |
| 业务编辑核对与撤回取消 | 编辑核对在业务侧；旧撤回也不取消执行 |
| 重连补收 | 默认内部首次缺口恢复，feishu.catchup:false 可关闭 |
| 活跃 steer | 持久单父意图；接纳后共用父结果，明确拒绝延期，未知暂停 |
| 缺少原生 ID 的未知接纳 | 不自动重放；限定范围的 admin API 支持审计 adopt/verified abandon |

这是阶段边界，不表示旧必需媒体/聊天能力可以删除。生产替换前仍需补齐缺失的原有能力。旧版不支持文件输入，撤回时取消 Codex 也不是旧行为，不能当作隐含迁移要求。

## 可观测性与测试

日志只含固定 module/component/operation/status/code/duration，不含原 payload/SDK 错误。可选 errorReporting `{url,tokenEnv}` 将终态结构化错误发到可信 HTTP 接收端，2 秒超时、最多 4 并发；上报失败/满额记 warning，不递归；取消响应体、拒绝重定向。未配置时仅结构化日志，部署前应配置生产错误收集端。

`npm test`、`npm run check`、`node scripts/test-storage.mjs test/core.integration.test.mjs` 分别执行测试、检查和隔离 MySQL 集成。后者创建临时库、注入模拟凭证，不连接真实机器人/模型。core 覆盖早到终态通知、重复输入、独立 hook、授权、unknown 不重放、reset busy 拒绝和已完成原生 turn 恢复。

## 补收装配

service 在 native/WS 启动后开始 catchup，在 worker/Store 关闭前停止。合并 Agent 群、hook 显式 catchupGroupIds 和 keyset 分页的已接收私聊，硬上限 1000 会话。catchupGroupIds 默认空、必须是 conversationIds 子集；任意 hook 目标不自动判群，既有私聊从 Store 发现。显式群与观察到的私聊类型冲突时拒绝补收，避免污染首次接收。无全 bot 枚举或公开读 API；默认私聊回看 3 小时、重叠 5 分钟。

Store 原子实现 live/history canonical 首次接收。历史内容变化不伪造编辑 hook。若历史发送者缺少私聊/限定群成员准入所需 open ID，或 mention ID 无法识别 bot，core 在 canonical 登记前拒绝，页检查点保留重试，不让不完整历史压住后续完整 live。允许全员的群不单为成员核验要求 open ID。SDK 1.60.0 message.list 没有 user_id_type 参数，此保护不猜测或转换身份。

## Agent 输入媒体生命周期

内部图片准备器位于 Codex 工作区 `.agent-chat-bridge/inbox`。feishu.mediaBudgetBytes 默认 128 MiB，可配 20 MiB–1 GiB；单文件仍限 20 MiB，HTTP 调用者不能指定输入路径。

入站只持久授权 job。worker 在首个原生 attempt 前准备私聊 image/post，并在接纳前续租，使用旧文本格式加入已验证路径。已有 attempt 恢复不再准备。文字/群 post 使用旧提取器，群图片忽略。下载失败/不支持私聊类型产生明确持久事实及回复，不执行 native；准备中断则未接纳 job 回 pending。

输入跨 turn 完成/重启保留；只有后续退役流程证明无原生恢复引用才 release，不按年龄删。预算满明确拒绝。输出自动上传/发送使用下面独立持久生命周期。

## 最终回复投影

正常完成与重启恢复使用同一持久 assistant 投影。支持 agentMessage.text、显式 assistant message.text 或 content 字符串/text/input_text/output_text、两种 agent-message delta、完成 item 和终态 item 数组。user/tool/reasoning/未知角色内容不作回复兜底。优先 terminal 明确 final answer；否则保留持久 final answer 不被后续 commentary 覆盖，再用 terminal/stream assistant 文本。后两条有意修复旧版 commentary 覆盖与未知角色视为 assistant 的问题。

delta 保留之前 12,000 字符尾部，最多 128 个活跃 item 累加器。原生重放按 turn 筛选、持久接收序号分页，上限 100,000 事件；到界仍未读完则保留可恢复状态，不提交不完整回复。`test/core-answer.test.mjs` 用相同事件序列对照冻结的原生产提取/投影，明确差异单独断言。

## 受控未知接纳恢复

拥有目标会话范围的 admin 可 GET `/v1/runs/:id/attempt`，POST `/v1/recoveries`：`{runId,idempotencyKey,generation,action,evidence,nativeThreadId?,nativeTurnId?}`。evidence 必填、最多 4096 字符、仅入 Store 审计。登记后返回 202；GET `/v1/recoveries/:id` 只显示 action/status/error，不返回 evidence。非 admin/跨会话拒绝，冲突 409。

仅原 unknown run 可用。adopt_turn 要显式 thread/turn ID；worker 读取线程，核固定工作区、turn 存在及状态，然后 Store 原子核 generation/active 和永久归属。原 run 转 pending 仅读恢复，不 turn/start。abandon_verified 要管理员明确核对声明；已知 thread 要读取，active/不确定 turn 拒绝放弃。缺少原生 ID 时可依据该声明取消原 run、释放其 generation，不创建替代 job。无 force-retry，也不原生 interrupt。

provider 读拒绝让管理动作保留租约后再仅读重试，不代表执行拒绝。应用 COMMIT 响应丢失根据持久 action 核对；未确认应用不改为矛盾的 rejection。固定错误/日志不含原生 payload 或审计证据。

`node scripts/test-storage.mjs test/core-recovery.integration.test.mjs` 覆盖真实 Store 登记、授权、adopt/abandon、活跃拒绝、工作区、归属、幂等及零新 native admission；模拟协议测试覆盖读取拒绝和 COMMIT 响应丢失。不操作真实平台或生产管理动作。

## Agent 私聊输出发送

service 创建互不重叠的 `.agent-chat-bridge/outbox` 与 `.agent-chat-bridge/outbound-spool`；前者注入每个新私聊线程的输出提示。完成后按持久原 attempt 时间扫描，快照最多 9 个选中文件，与文本和独立 upload/send effects 原子提交。群只文字。准备失败和 omitted 数量保留在 run result 及明确文字提示中，文字成功不表示全部文件成功。

artifact_send 只能用确认上传成功的前驱结果；采用同 UUID 55 分钟重试，unknown artifact_upload 不自动重试。文件 28 MiB、内部 HTTP multipart 含开销 32 MiB、图片另限 10 MiB。feishu.outputBudgetBytes 默认 512 MiB，可配 28 MiB–1 GiB。公开上传仍独立限 2 MiB，不接内部 artifact ref/路径。

确认发送原子设置 cleanup_pending。有界扫描重试 FS 清理，成功才清标记；重启不重发、不重跑 Agent。源文件变化由 identity/hash 检查保留；未知上传/发送保留快照和源，通过 blocked delivery 可观测，不按年龄删。

`node scripts/test-storage.mjs test/core-outbound.integration.test.mjs` 用真实 MySQL、本地 3 MiB PDF 和模拟 model/chat 验证上传前驱、key 发送、清理失败/重启不重复执行、未知上传暂停；不连接 provider。平台调用与 outbox 结算错误分开：sent COMMIT 响应丢失经 getOutbox 回读，确认 sent 后可清理；stale/conflict 不改称平台 unknown，不停其他 worker。`test/core-delivery.integration.test.mjs` 注入 text/upload/artifact upload/send 的真实已提交响应丢失及 failed effect，验证不反向结算、不重复调用、不关闭 worker。

## 空闲与规则更新退役

codex.rolloverIdleMs 默认两天，0 关闭。rolloverOnRulesUpdate 默认 true，rulesFiles 默认 `["AGENTS.md"]`，最多 20 个工作区相对文件，不内置 Kosbling 路径；缺失文件忽略。保留原秒/毫秒归一化与规则更新一秒余量。

新 attempt 前读取不活跃绑定并核 native turns；已有持久 attempt/active session 不旋转。idle 使用之前确认输入时间和原子 expectedLastMessageAt 检查；bind/adopt 记原 attempt 时间，轮询/恢复不刷新；规则更新优先。provider/元数据检查失败让未接纳 job 保持 pending，记脱敏 warning，不丢弃可能活跃线程。

退役增 generation、审计旧 thread、保留永久会话归属，不 archive/delete 原生线程。输入保留到 thread 非 current 且无 native/已接纳指导/未解决指导/管理引用；删除前持久封存，禁止将来 bind/adopt，不按年龄猜可删。保留预算满拒绝新准备。turn admission 前，thread/resume 的已证实且身份匹配 archived 拒绝可原子重置 active attempt；仅新确认允许一次替代 thread/start。reset 响应丢失或替代结果未知仍保留 unknown，重放 reset 不再授予 start。读取侧明确 archived 拒绝也可退役不活跃绑定。

## 持久活跃 turn 指导

codex.steering 默认 true；false 延期新任务，但仍核对旧未解决意图。turn/steer 前 Store 记录指导 job、目标 run/generation/thread/turn 与稳定 client message ID，只有新意图发 RPC。每父 run 同时最多一个未解决指导；没有可操作已知 turn 的 pending/unknown 父运行不猜 RPC 目标。

accepted 指导自己的结果为 `{deferred:true,targetRunId,nativeTurnId}`，不另回消息，父 final 为准；父先完成也不丢 accepted 事实。明确拒绝则延期，不向同目标重复发送。未知响应/恢复到未解决 intent → unknown 指导，不重复 steer/自动新 turn，父状态保留。active-turn mismatch 不触发旧推测中断。

admin GET attempt 可见 native 与 steering；未知指导不同于未知 native，不能 native adopt/abandon。POST recoveries 的 action=`abandon_guidance_verified` 携 runId/generation/idempotencyKey/有界 evidence，经显式核对仅取消 unknown 指导 job；不调用 provider、不改父/session、保留 unknown steering，不接受 native IDs。保留的不确定性仍阻止向同一活跃父再 steer；父结束后新任务正常进行。这不是 force retry，也不声明 provider 未接收。

`test/core-steering.integration.test.mjs` 验证真实 Store 串行、父先完成、共享单回复、明确拒绝延期下一 turn、unknown 重启不重放；离线覆盖结算响应丢失和关闭新 steer 但保留旧未知。

恢复 steering intent 在输入准备、输出目录、rotation 或新 native attempt 之前检查，哪怕已关闭新 steering。缺本地媒体不能把已提交指导改为输入失败。仅接受必需 TurnSteerResponse.turnId 且与记录目标一致，缺失/不匹配都 unknown。过期 intent 真库回归断言零媒体/输出目录/新 attempt 准备调用。

## 产物发布与清理归属

单 writer 会话 guard 允许 native/steering/管理核对共享活动，清理独占。清理先取得本地归属再核持久 native active 和未解决指导，重启也保留这些约束。新 native/adopt 等 FS 清理及持久 ACK 退出 guard；不持 DB 锁跨 FS/provider。

turn 完成前，发布产物必须写完并关闭。后台进程/保留 fd 不得在完成后继续写，私聊提示也包含此要求。隔离/版本检查可保护路径替换，不能保护同 UID 后台持 inode 写者；guard 防止 bridge 控制的下一 turn 造成重叠。

## 资源退役

worker 独立扫描 output/input 游标，output 优先，每种最多 25 候选。output 使用自己的 pending/sealed 索引，保留 current-thread input 的历史不会重复进入已完成 output 扫描；积压页 1 秒续扫，扫完等 30 秒。SQL 先限候选再聚合引用。在 cleanup guard 下 Store 原子 seal 再核执行/指导和引用；输入须退役线程永久禁止未来 adopt 后才删，空输出独立于线程生命周期回收。FS 在事务外，之后登记完成；删除/ACK 失败可重放 sealed。

仍需源版本 claim/quarantine 的输出 manifest 保留，failed/unknown 待受控核对，不重试模型或上传。绑定/adopt 已退役资源 thread 返回 resource_retired（HTTP 409）。快速单元覆盖先seal后文件、ACK丢失、claim保留、执行排斥、seal拒绝和游标重放。`test/core-resource-retirement.integration.test.mjs` 已准备，按暂停真实/E2E的要求本阶段未执行。

## 原生错误观察与恢复差异

已绑定 thread/turn 的持久 error 且 willRetry !== true 会唤醒原生读取。只有 completed/failed/interrupted 可结束 attempt；in-progress/缺失/unknown turn 或读取失败保持原 IDs 和 pending。willRetry:true 等provider，两支都不新建模型 turn。

这是明确可靠性变化：旧版非重试错误会拒绝本地 promise，再由 transport 分重试/失败；旧前驱/孤儿 handler 还会 interrupt 原生 turn。bridge 不复刻宽泛自动中断，而以持久 admission/generation、已知 turn 读取和带审计未知核对代替。严格时序不等同旧版，未知工作可能要人工处理。快速观察测试覆盖仅错误流、terminal/retry控制、读拒绝、缺失 turn 与未知状态；未新增真实模型/E2E验证。
