# 独立 MySQL Store

[English](../storage.md) | [中文入口](../../README.zh-CN.md)。英文为项目主语言；接口/状态名保留英文。

环境为 Node 24 / MySQL 8.4、mysql2 3.24.4。启动调用 createMysqlStore，校验迁移记录、用专用连接取得 writer 锁，不执行 DDL。每数据库仅一个 writer。获取锁的总超时包括连接池等待、数据库身份和 GET_LOCK；晚到连接会销毁。锁连接丢失后拒绝写入并调用 onWriterLost，宿主应停止接纳并让 ready 失败。不导入业务数据库、不隐式发现配置。

显式迁移：`node src/storage/migrate-cli.mjs --config /absolute/storage-references.json`。该独立 JSON 只包含 hostEnv/portEnv/userEnv/passwordEnv/databaseEnv 环境变量名，凭证经部署秘密机制注入。初始 DDL 可重启并有 checksum，但不是整体原子事务；使用专用迁移账号前先评审。测试工具不能指向业务数据库。启动不检测任意人工列结构漂移。

`createPoolFromEnvironment(references, env)` 建有界连接池；`createMysqlStore({pool,operationTimeoutMs=1800,onWriterLost})` 持有直到 close。SQL 超时销毁实际连接，晚取得连接也销毁。错误只给稳定 code，不暴露驱动消息/SQL/凭证。COMMIT 失败为 commit_unknown，重做任何效果前先按稳定 key 读取核对。断连后的 MySQL 回滚可能异步完成，事务内不做外部调用。

## 基础契约

输入均为对象，输出 camelCase；BIGINT sequence/generation 可能是十进制字符串。读分页最多 100，Store 不执行聊天/网络调用。

- `acceptInbound({connectionId,conversationId,eventKey,eventType,messageId?,recalledMessageId?,revision?,occurredAt?,payload,semanticPayload?,policyVersion,passiveContext,source?,conversationType?,agentJob?:{payload},hooks?:[{hookId,payload?}]})` 原子登记 inbox、独立 agent/hook job。返回 eventId/sequence/duplicate/agentJobId/hookJobIds。同 key 不同语义 hash 拒绝 inbound_conflict；normalized identity 排除 receivedAt/source/isSelf，保留真实 revision/撤回身份。重放沿首次路由快照。source 仅 live/history_catchup，conversationType 是 p2p/group，省略可从规范 payload 推断，显式值冲突拒绝。message.received 按 connection/conversation/messageId 首次 canonical 去重，不依赖 event ID、actor 元数据、revision/source；后到 live/history 保留事件账，但不新派 Agent/hook，即使历史正文变化，也不合成 message.updated。另返回 firstReceipt/duplicateCanonical 及首次 event/job ID。真实 recalled 独立生成 hook/tombstone。
- `enqueueJob({kind,connectionId,conversationId,idempotencyKey,payload,hookId?})` 支持 agent/hook，返回 id/duplicate。`claimJobs({kind,owner,limit?,leaseMs})` 返回 job+leaseToken，可恢复过期租约。分配 inbox/job sequence 前锁持久会话 scope 行，防止并发登记后序先提交可运行。hook 按会话/订阅者保持登记顺序，失败尝试在终态前阻挡后序。
- `holdAgentAttempt({id,leaseToken,errorCode})` 保留 active session、标 unknown，不自动领取。retryJob terminal=true 原子释放对应 native attempt 并标 failed，只用于已证明拒绝。
- `renewJob({id,leaseToken,leaseMs})`、`retryJob({id,leaseToken,errorCode,nextAttemptAt?,terminal?})` 使用 leaseToken 隔离旧 worker。native attempt 重试前先核对；beginAgentAttempt 返回 recoveryRequired 时不得再次 turn/start。
- `beginAgentAttempt({id,leaseToken,agentId})` 锁 session、RPC 前持久意图，返回 generation/nativeThreadId/recoveryRequired。`bindAgentAttempt({id,leaseToken,expectedGeneration,nativeThreadId,nativeTurnId?})` 保存 admission ID。`bufferNativeEvent({connectionId,eventKey,nativeThreadId?,nativeTurnId?,payload})` 保存早到通知；`readNativeEvents({connectionId,nativeThreadId,nativeTurnId?,afterSequence?,limit?})` 供接纳后关联。nativeTurnId 可选过滤使用复合索引，排除 null/其他 turn，避免重复扫描整线程。
- `finishJobWithOutbox({id,leaseToken,result?,outbox?:[{idempotencyKey,kind,payload}]})` 原子完成 native、释放匹配 session attempt、登记回复。有效果时 job 为 reply_pending，直到全部 sent。数组顺序持久为 predecessorId 链，只有前驱 sent 才解锁后继，跨并发/重启保持；可选 predecessorIdempotencyKey 必须匹配前一项。终态发送失败原子将 job 改 delivery_failed，保留模型完成事实，不重领 Agent。宿主用 getJob/getOutbox 核对 commit_unknown，旧租约重试不重发模型工作。
- `recordOutbox({connectionId,conversationId,idempotencyKey,kind,payload,platformUuid?})`、`claimOutbox({owner,limit?,leaseMs})`、`settleOutbox({id,leaseToken,status,result?,errorCode?,nextAttemptAt?})`。status 为 sent/unknown/failed/pending，pending 仅表示已证明未发送的失败。过期 running 每批最多 100、稳定顺序恢复成 unknown。基础 create/reply 在首次尝试持久时间后 55 分钟内用同 UUID/payload 自动重领 unknown，调用者必须依赖官方 UUID 保证；未知 upload/reaction/update 待核对。getJob/getOutbox 读持久状态；后者还给 predecessorId/predecessorStatus/blocked。unknown/failed 的后继保持 pending+blocked=true，不跳过前驱。独立 recordOutbox 默认无依赖；内部 artifact 扩展见下。
- `getSession({connectionId,conversationId,agentId})`、`setSession({...key,expectedGeneration,nativeThreadId?,activeRunId?})`（0 创建，不能覆盖 active）、`resetSession({...key,expectedGeneration})`（拒绝 active 并增 generation）。不能直接删除绑定。
- `appendRunEvent({runId,eventKey,type,payload})`、`readRunEvents({runId,afterSequence?,limit?})` 持久/读取规范 run 事件。
- `readPassiveContext({connectionId,conversationId,afterSequence?,limit?})`、`consumePassiveContext({...key,runId,throughSequence})`、`excludeMessage({connectionId,messageId})`。宿主决定声明策略；撤回 tombstone 支持乱序，recalledMessageId 与入站登记原子持久化。revision key 是独立事件，编辑投影仍由调用方策略决定。
- `listKnownConversations({connectionId,conversationType:"p2p",afterConversationId?,limit?})` 返回 `{items:[{conversationId,conversationType}],nextCursor}`，索引支持稳定 keyset、limit≤100。仅列已观察私聊，群/私聊分类冲突拒绝；core 再授权补收，不是公开全 bot 目录。
- `getCursor({connectionId,key})`、`setCursor({connectionId,key,expectedVersion,value})` 实现乐观并发消费者游标。hook ACK 是消费者持久接收，不是业务完成。

Store 不提供假的运行实现，也不公开全部 sessions 列表。B4/core 阶段负责认证、授权、背压、生命周期/错误上报、worker 核对和 readiness；编辑投影与暂停后的恢复仍需明确编排策略和集成评审。

## 验证

npm test 跑离线套件；未显式提供 BRIDGE_TEST_* 时跳过真实 MySQL。npm run test:storage 在本机 Unix Docker daemon 创建临时 MySQL 8.4，随机 loopback 端口、内存模拟密码，结束删除容器。独立 core 套件用 `node scripts/test-storage.mjs test/core.integration.test.mjs`，每次新 schema，不供生产参数。覆盖真实事务/租约、原子完成回滚、驱动边界 COMMIT 响应丢失及实际连接销毁超时；驱动注入不等于 TCP 代理测试。

## 管理恢复

`getAgentAttempt({id})` 仅返回 scope/generation/native IDs/agent/创建时间/job状态。`enqueueRecovery({runId,callerId,idempotencyKey,expectedGeneration,action,evidence,nativeThreadId?,nativeTurnId?})` 对 generation/active 仍匹配的 **unknown** run 登记管理动作。evidence 必填≤4096，入审计，getRecovery 不返回。caller+key 唯一，改 payload 冲突，完成后仍可读重复请求。

`claimRecoveries({owner,limit<=100,leaseMs})` 返回租约动作，可信内部 worker 可拿 evidence。只有它在事务外验证 provider thread/turn、固定工作区和终态证据。`finishRecovery({id,leaseToken,outcome:'applied'|'rejected',errorCode?,verifiedNative?:{threadId,turnId}})` 核 lease，应用时再核原 unknown/generation/active。adopt_turn 的 verified ID 必须与请求及已有 attempt 一致；绑定后原 run pending，begin 返回 recoveryRequired:true，不建第二模型 attempt。abandon_verified 取消原 run、清绑定、增 generation，不排新 job。rejected 只终止管理请求，可关闭竞争失败、目标已变的动作。相同 lease+结果的终态 finish 幂等，含 COMMIT 响应丢失。

永久 bridge_thread_owners 按 connection/native-thread 绑定 conversation/agent。普通 bind、显式 session import、管理 adopt 在同事务认领；reset/退役不删，所以历史内容不能跨会话认领。scope 冲突整体回滚。Store 不调用 provider、不记录 evidence 日志、不 force retry、不删 native thread；core 负责授权和结构化管理事件。

英文原文记录这些表首次处于未发布 initial schema 的开发阶段，仅在一次性本地 MySQL 使用；现有安装 checksum 不匹配时需受控迁移，启动不 DDL。发布后的 SQL 不可变政策见[版本与迁移](../../MIGRATIONS.zh-CN.md)。

## 已确认产物清理

artifact_upload/artifact_send 使用原有有序 outbox。都要求已完成 job 的可信 `{scope,ref}`；send 的直接前驱必须是同 artifact 上传。getOutbox.predecessorResult 仅在前驱确认 sent 时有值。未知上传暂停；artifact_send 同 text create/reply 使用原 UUID 和 55 分钟窗口，不改变 upload/reaction 重试策略。

artifact_send 结算 sent 同事务设置 cleanup_pending。`listPendingCleanup({afterId?,limit<=100})` 用 `(cleanup_pending,id)` 索引/keyset 返回 `{items:[{id,connectionId,conversationId,jobId,payload}],nextCursor}`。单 writer 扫描执行可重放本地清理，再 `completeOutboxCleanup({id,connectionId,conversationId})`。ACK 仅适用于确认 sent 的 artifact_send，幂等清标记，不改 send/job 状态。失败保留 pending，重启只重清理不重发。不增加另一个租约 job/外部队列。

## 空闲/规则退役

session.lastMessageAt 是最近**确认接纳 turn**的原 bridge_attempts.created_at，在 bind 非空 nativeTurnId 或管理 adopt 已验证 turn 时记录。它是 bridge attempt 开始时间，不是精确平台接纳或事件入站时间。入站、意图、仅 thread bind、claim、通知不更新；恢复不刷新为当前时刻。turn 接纳前拒绝不改旧活动时间，unknown 保留 active 因而不能退役；无确认接纳时为 null，core 可用 provider 线程创建时间兜底。

`rotateIdleSession({connectionId,conversationId,agentId,expectedGeneration,expectedThreadId,expectedLastMessageAt?,reason,idempotencyKey})` 仅做数据库隔离退役。reason=session_idle/rules_updated/thread_archived；core 先核阈值/规则时间/provider证据。事务要求 generation/thread 一致、无 active，可选旧活动值一致（含显式 null）。增代、清 native 绑定，bridge_session_rotations 持久旧thread/原因/代数/时间，永久归属保留。返回 `{generation,retiredThreadId}`；同scope/key/请求可在 COMMIT 未知后重放，改内容冲突。key取等待run+reason+旧generation。不原生 archive/delete/create，后续创建仍须RPC前持久attempt。

## 活跃 turn 的持久指导

`beginSteerAttempt({id,leaseToken,agentId})` 只考虑无 native attempt 的 agent job。无合适父、父unknown/无接纳turn、同目标曾拒绝、父已有其他intent/unknown指导时返回 inactive；否则登记唯一指导job/目标run意图，返回 `{kind:'new',targetRunId,generation,nativeThreadId,nativeTurnId,clientMessageId}`，clientMessageId=指导job ID。旧未解决意图返回 recovery_required，不允许重发RPC。父job串行化指导登记/结算，锁内不做网络。

`finishSteerAttempt({id,leaseToken,outcome:'accepted'|'rejected'|'unknown',errorCode?})` 核租约并审计。accepted 仅指导job succeeded、结果 `{deferred:true,targetRunId,nativeTurnId}`，无第二outbox、不改父；父已完成的迟到确认仍是accepted。只有原generation/thread匹配时用意图时间MAX更新活动，防倒退。rejected让指导pending至少1秒，不再发同父；其他新父可有独立新审计。unknown暂停指导、阻止该父结束前的后续指导RPC，不取消/释放父；普通native attempt也拒未解决指导，防错走新turn。

`getSteerAttempt({id})` 给最新scope/target/IDs/status/time/error。相同lease的终态finish可在COMMIT丢失后幂等重放。native管理adopt要求普通attempt，不能认领指导记录。初期unknown指导可观测，不force retry/自动新turn；core负责授权prompt/provider调用、明确拒绝/未知分类与日志，Store不重发steer、不重复父回复。

## 接纳 turn 前的明确 archived 拒绝

`resetRejectedThreadAdmission({id,leaseToken,expectedGeneration,expectedThreadId,reason:'thread_archived'})` 是core在发送turn前遭到已证实且scope匹配拒绝时的内部延续。要求owned running job、相同active session/generation/thread、native attempt无turn ID。一次事务审计旧绑定/run、session和attempt增代清thread，但保留run active预约、原attempt时间与永久归属。

只有首次提交返回 `{generation,nativeThreadId:null,recoveryRequired:false}` 允许继续创建。内部job/旧gen/thread/reason key幂等，重复返回当前IDs及recoveryRequired:true，不把旧成功当新创建许可。DB响应丢失/重启走保守unknown/read；已有任何接纳turn则拒替换。provider证据与阶段判断在core，无公开force-reset或Store内provider调用。

`getConversationActivity({connectionId,conversationId,agentId})` 一条只读SQL返回 `{activeRunId,unresolvedGuidance}`。任何持久native active都算，包括unknown/recovery。指导intent/unknown且指导job pending/running/unknown即算，父完成也算。用精确session scope及steering scope/status索引；core先取得本地cleanup/execution guard，查询本身不是锁，也不授权与新接纳竞争。不持DB事务跨FS/provider。

abandon_guidance_verified 复用管理入口，只适用于latest steering unknown、job unknown、generation匹配。不接受native IDs，不调用provider；这是停止追踪/重试指导的管理决定，不证明provider没执行。enqueue和applied finish都再核目标，仅cancel指导job，保留steering unknown，不改父/session/generation/native绑定。父结束后可解除未解决指导清理门槛。accepted指导/普通native run不能用；证据/租约/幂等审计仍适用。

## 受控资源退役

`listRetirableResources({connectionId,kind:'input'|'output',afterRunId?,limit<=100})` 返回对应kind未完成退役的终态Agent job分页，含run/scope/thread及inputState/outputState/inputRetirable/outputRetirable。资格是提示，不是删除许可。输出要求succeeded、所有关联outbox sent且cleanup确认；failed/unknown待受控核对。不要求当前线程退役，所以日常聊天可回收完成的空输出。

输入还要求thread非current、没有该thread的未终态native或accepted/unknown/intent指导引用，没有pending/running管理adopt。accepted指导无普通attempt，但图片仍属于steering thread。无native/steering thread引用的终态输入可回收。查询有界、精确列与scope/thread索引，不由应用逐行查详情。

在本地cleanup guard下，`sealResourceRetirement({runId,kind:'input'|'output'})` 短事务重核事实、标sealed并返回run/scope/state。新seal及sealed重放都以retirement_conflict拒active native预约/未解决指导，core不必再单查activity。输入永久标owner.resource_retired_at，后续bind/import/adopt（含恢复登记）拒resource_retired。seal可崩溃重放；输出seal拒新增关联outbox，已有相同effect登记仍幂等。

仅封存后core可在事务外做FS release，再 `completeResourceRetirement({runId,kind})`，完成幂等且可恢复COMMIT响应丢失。job上input/output各自pending→sealed→complete，FS失败保sealed并继续列出。输出releaseRun若manifest还claim未变源或有quarantine，返回retired:false，不能complete。无自动unknown重发、源删除或通用GC调度器。

输入/输出游标与状态索引独立。输出只取succeeded且output pending/sealed，不因current输入保留让已退输出再入扫描；输入有独立有界页。每次先限候选再算引用资格，不为凑满页无界过滤全历史。即使候选均不可退，core也推进对应游标，优先输出，并使用有界积压续扫。暂停真实测试后的query/index仅静态/快测覆盖，更新SQL仍待用户本机MySQL集成验证。
