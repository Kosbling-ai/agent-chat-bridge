# Agent 产物文件

[英文原文](../outbound-media.md) · [中文入口](../../README.zh-CN.md)

本模块恢复旧私聊产物发现算法：每个聊天使用一个平铺目录，选取修改时间不早于 turn 开始前一秒的普通文件，按修改时间排序，超过九个时取最新九个。群聊输出仍仅支持文本。文件实际大小上限为 28 MiB，保留旧 transport 的 `28 * 1024 * 1024` 限制，不把公开上传接口的 2 MiB JSON 上限当成 Agent 产物上限。

图片按 `.png/.jpg/.jpeg/.gif/.webp/.bmp` 扩展名识别，与原 helper 一致。`.pdf/.doc/.xls/.ppt/.mp4/.opus` 使用相应的飞书上传文件类型；新版 Office 格式、压缩包及其他扩展名使用 `stream`。图片上传仍受适配器独立的 10 MiB 平台上限约束，因此更大的图片会产生明确失败的 effect，并保留供后续处理。扩展名映射不等于 MIME 检测，也不会扩大入站媒体支持范围。

## 内部集成契约

`await createOutboundMedia({workspace,outboxDir,spoolDir,chat,maxBytes?,maxTotalBytes?,log?})` 返回下列方法。宿主选择的绝对目录必须严格位于受信任的 Agent 工作区内，且 outbox、出站 spool 和入站媒体 spool 必须互不重叠。已有的符号链接祖先目录、不安全的可写目录、符号链接文件和硬链接文件都会被拒绝。源目录按 connection/conversation 划分，快照按 run 划分。这是路径校验和完整性检查，不是针对与服务共享 UID 的进程的沙箱。

`scope = {connectionId,conversationId,runId}` 始终从已持久化且已授权的 run 推导，不能取自 HTTP 输入。`directory(scope)` 创建/返回受信任的每聊天目录，用于首次私聊提示词。`prepare({...scope,conversationType,sinceMs})` 接收持久化的原始 turn 开始时间，返回 `{artifacts:[{ref,kind,fileType,fileName,size}],failures:[{fileName,code}],omitted}`。`ref` 只包含 `{connectionId,conversationId,runId,artifactId}`，不包含文件系统路径。后续每个操作都会根据预期 scope 和已保存的 manifest 校验引用。不要将这些操作公开，也不要在公共 API 中接受 artifact 字段。

prepare 把有大小上限的文件内容复制到独立的出站 spool，并在返回前原子提交 manifest。先对文件及 manifest 执行 fsync，再对相应目录项执行 fsync。一旦 manifest 存在，重启就复用它，不重新选择新增或已变更的源文件。已登记的 artifact 绝不会被变更后的源文件替换。文件系统错误或超限会逐文件记录，源文件保留在原处，不会丢弃其他成功文件或独立的文本回复。core 必须在 run 结果中保留这些失败；文本回复成功不代表每个文件都已送达。

每个 artifact 对应现有有序 outbox 数组中的两个独立持久 effect：

1. 内部 `artifact_upload` effect，携带 `{ref}`。稳定幂等键为 `run:<runId>:artifact:<artifactId>:upload`。worker 对每个已领取、非 unknown 的 effect 调用一次 `upload({scope,ref})`，返回 `{image_key}` 或 `{file_key}`。上传没有平台 UUID；结果未知时必须保持挂起，不能自动重新上传。
2. 紧随该上传的内部 `artifact_send` effect，携带 `{ref}`。稳定键为 `run:<runId>:artifact:<artifactId>:send`。worker 只读取**已确认 sent 的上传前驱**结果，调用 `send({scope,ref,uploadResult,uuid:row.platformUuid})`。helper 在该 run 所属聊天中创建普通图片/文件消息。core 对结果不确定的消息发送保留有界的同 UUID 重试语义，必须明确把这个内部 kind 分类为支持 UUID 的发送。failed/unknown 前驱通过 Store 的持久链阻止后续 effect 执行。

这些是宿主集成使用的内部 kind 名称，不是新增的公共请求类型。helper 自己不登记 Store effect、不标记结果，也不会把上传与发送合成一个具有误导性的“原子”操作。产物 effect 应与文本 effect 一起提交到同一次原子 run 完成调用。重复完成 run 时必须复用 manifest 和稳定的 effect 键。

## 清理与保留

平台确认 artifact 发送后，core 必须原子持久化 `sent` **及** cleanup-pending 标记，然后才能调用 `cleanup({scope,ref,confirmedSent:true})`。持久清理扫描会在重启后重试待清理项；清理错误不会触发重新发送。只有清理成功后才清除标记。这样可覆盖发送提交与文件系统清理之间的崩溃窗口；Store/worker 支持属于单独的集成要求。

只有 inode/device/size/mtime 和内容哈希仍与快照版本一致时，清理才会删除原始源文件。被替换或修改的源文件会保留，并记录去除敏感内容的 warning。对应快照也会删除；任一次删除之后都可安全重试。小型 manifest 留作重放/审计，已完成的 run 不会自动重新扫描。unknown/failed 发送保留快照与源文件。已成功发送文件的源文件 unlink 失败会向上传播以便重试清理，不会再次报告发送成功。

spool 默认预算为 512 MiB，可配置至 1 GiB，另有目录项扫描上限。源目录扫描最多处理 4096 项。每聊天源文件属于 Agent 产物，不会被静默垃圾回收。旧 manifest、中断的准备文件和挂起的 artifact 最终需要经过审阅的保留/修复操作；达到配额会明确失败，不会删除 unknown 或正在使用的产物。备份/迁移规划应把 spool、manifest 与持久 Store 状态一并纳入。

## 验证与边界

`node --test test/outbound-media.test.mjs test/feishu.test.mjs` 验证真实本地文件选择、重启后不可变快照、类型映射、独立上传/发送、unknown 保留、以确认为前提的幂等清理、源文件变更保留、scope 越界、符号链接/硬链接、大小与完整性限制。SDK/HTTP 测试使用已安装的 SDK 和不访问网络的 transport，不联系机器人或模型。

宿主必须为内部 chat client 配置至少 28 MiB 的文件字节容量以及 HTTP multipart 额外开销，接入持久上传前驱结果，分类内部发送的 UUID 资格，持久化清理标记并扫描处理。独立模块测试不能证明整个集成生命周期或生产迁移已通过验证。不会额外公开文件系统或聊天读取代理。

## 跨 turn 的源版本归属

已发布的 run manifest 同时声明所选源版本的归属：conversation、文件名、device/inode、字节数、mtime 和内容哈希。准备阶段利用现有串行化的本地 manifest 扫描，在应用原“最新九个”选择规则前排除其他 run 已认领的版本。一秒时间余量保持不变。即使 stat 字段相同，也必须比较内容哈希，因此写入等长新内容并恢复 mtime 仍会形成新版本。快照清理后，保留的 manifest 继续保存归属；上传结果 unknown 不会让该源文件重新成为后续 turn 可选择的产物。

没有另行提交的 claim 文件。先同步快照数据，再发布 manifest 和目录项，最后由 core 登记 outbox effect。manifest 发布前失败不会认领任何版本。发布后失败或重启时，原 run 可以重新加载同一快照，后续 run 则跳过该版本。已有 manifest 重放在返回前会重新同步发布目录。这依赖 bridge 单 writer 和单个 outbound 模块实例，不是跨进程 spool API。

译注：此段描述独立模块的保留约束；当前 core 集成的已完成 run 退役流程见文末，仍受 Store 封存及源版本保留条件限制。

现有 4096 项 spool 上限同时计算 run 目录和文件；没有产物的 run 也会保留空 manifest 来固定结果，每个占两项。因此，仅约 2048 个空 run 就会达到该上限。当前没有自动 manifest 退役机制：盲目删除会丢失重放/归属事实。新准备在达到目录项或字节容量时会明确失败，而已发布 run 的 manifest 仍可读取。匹配源文件的哈希比较也有累计字节预算，等于配置的 spool 预算。本项修复不承诺无限期无人值守保留；长期运行部署前仍需经过审阅的生命周期操作。

## 可恢复的源文件清理

已确认发送后的清理，先把候选源文件重命名到同一文件系统内、该 run 私有的 `<artifactId>.source` 隔离位置，同步两个目录，再验证已移动的版本。它不会先单独校验哈希、再 unlink Agent 的活动路径，因为下一轮可能已经替换了该路径。匹配的已移动版本可以删除。不匹配的版本通过原子的、不覆盖目标的 `link` 恢复，然后删除其私有目录项。若活动路径已被另一文件占据，两个文件都保留，清理报告 pending，Store 继续保留清理标记。manifest 可在重启后识别隔离文件；后续扫描继续处理，包括在恢复 link 与私有 unlink 之间崩溃的情况。跨文件系统移动会保持 pending，不会退化为复制后删除。

每次成功清理都必须在 rename/unlink 后同步源目录和 run 目录，core 才能确认清理标记。因此，目录同步失败仍是可重试清理，不是重新投递。隔离文件计入现有 spool 配额。如果活动路径已被占据，导致不同的隔离版本无法恢复，必须明确保留/移动较新的活动文件，自动恢复才能完成；warning 代码为 `artifact_source_quarantined`。这保护普通下一轮对路径的替换，并保留中断的清理过程；它不声称能隔离共享 UID 的任意进程，也不负责协调故意保留私有已移动文件的可写描述符的写入者。

### 退役已完成的 run

core 只有在 Store 已持久封存输出退役、且持有 conversation cleanup guard 时，才能调用 `releaseRun(scope)`。已完成空 run 的 manifest 会立即删除，不等待原生线程退役。测试使用真实本地文件系统操作覆盖了超过 2048 次连续的空 prepare/release 循环。这为现有 4096 项 spool 上限提供了正常退出路径，而不是提高上限。

如果 manifest 仍认领当前源版本，或 run 中还有未解决的 `.source` 隔离文件，则返回 `{retired:false}`，继续保持 sealed，供后续重新判断。即使路径/stat 相同，源版本比较仍包含内容哈希。否则，release 只删除受控快照/临时文件，最后删除 manifest，再移除并同步 run 目录及 spool 父目录。它绝不删除或修改用户的源文件。删除过程中或 Store 完成登记前崩溃都可以重放；Store 中已完成退役的资源绝不能再次传给 prepare。failed/unknown 投递仍保留此前受控核对的要求，不符合自动输出退役条件。输入图片有独立且更严格的 Store 退役门槛，与原生及指导线程引用关联。
