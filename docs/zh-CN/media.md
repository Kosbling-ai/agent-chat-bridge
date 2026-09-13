# 飞书 Agent 图片输入

[English](../media.md) | [中文入口](../../README.zh-CN.md)。英文为主；本文保留原文阶段边界，最终装配状态见[运行说明](runtime.md)。

模块迁移旧传输层的 text/post 提取、图片 key 遍历、不支持类型标签和图片路径提示，不增加原生 Codex image block、lark-cli、文档 API 或通用媒体网关。原 Agent 接收含下载路径的文本，自行选择读文件工具；这里没有测试真实模型工具调用。

`await createFeishuMedia({chat,workspace,inboxDir,maxBytes?,maxImages?,maxTotalBytes?,timeoutMs?,log?})` 返回 `prepare(event,{runId,signal?})` 和 `release(runId)`。workspace/inboxDir 必须是显式绝对路径，inboxDir 严格位于 workspace 内。注入 chat client 的 SDK 资源流只在内部使用。仅对已授权、已持久化的 Agent job 调 prepare，且在登记原生 attempt 前进行；不在事务中或入站 ACK 前下载。

返回普通对象 `{status,text,addendum,localPaths,reason?,replyText?}`，status 为 ready/ignored/unsupported/failed。只有 ready 且路径真实验证成功才能注入模型。调用者用空行拼接身份/上下文前缀、text、addendum，保留旧文本输入格式。

- 下载私聊独立图片及 post 的 `img` 元素；按源顺序去重 key，全部成功才返回任何路径。
- 群 post 保留文字，忽略图片，不新开群 Agent 媒体能力。
- 私聊 file/video/audio/sticker/未知结构化消息保持旧版不支持；群/用户分享卡片只生成旧描述文字，不查身份。
- `extractMessageText(event)` 保留 post 行、换行、链接、标题行为，不新增原 helper 未支持的语言格式。

## 明确的可靠性调整

旧 20 MiB 设置只在超大图片写入后警告。新模块实施流式单文件限制（默认/最大 20 MiB）、最多 9 张图、总保留预算（默认 128 MiB，可配至 1 GiB），目录/文件扫描最多 2048 项。满额返回 failed，不删别的线程资源。prepare 默认 15 秒、最大 30 秒；取消或晚到下载不会返回假路径。

旧 MIME 映射对未知响应默认 .jpg；新模块仅接受原映射中的 PNG、JPEG/JPG、GIF、WebP、BMP、HEIC、HEIF，明确拒绝未知/非图片 MIME。这是有意收窄，不能称旧版已有校验，也不表示每种格式均真机验证。此处只校验 MIME，不完整解码图片。

run ID 和 image key 哈希成稳定路径。目录 0700、文件 0600；拒绝既有符号链接、他人可写目录、不安全文件及工作区外路径。完成 manifest 保存有界文件名、字节数和 SHA-256；重启验证并复用，不重复下载。失败只删本次创建的文件，不删已有完整 manifest。崩溃留下完整文件但无 manifest 时返回 `media_incomplete_recovery`，不静默覆盖、不假报完成。确认无原生读取者后，调用方可显式 release，再重试尚未接纳的 job。

资源跨 turn 完成与服务重启保留，因为原生线程/恢复运行仍可能读它们。不按 mtime/TTL 清理。`release(runId)` 幂等，只能在 core 确认对应线程已退役、无 pending/unknown 引用后调用；不接收用户文件路径。路径保护不等于对同 UID 其他进程的安全隔离。

生命周期日志只有固定 operation/status/code/duration，不含路径、用户正文、key 或原始 SDK 错误。prepare 失败是可恢复 warning；所属 worker 决定重试耗尽与终态上报。

## 验证与阶段说明

`node --test test/feishu-media.test.mjs` 用离线资源 client 和真实本地字节/权限/清理测试。迁移时旧/新文本与 post 图片提取做过对照；公开测试不依赖旧仓。不使用真实机器人、模型、平台下载或发送。

原模块阶段只负责入站准备；core/config/service 装配及旧输出扫描、自动上传/发送、发送后清理是独立协调单元。单测不能据此宣称完整旧媒体迁移完成；已有显式上传/发送接口仍可用，最终状态见运行文档。

图片和 manifest 内容在发布前 fsync；新目录项同步父目录，返回 ready 前同步 run 目录与 inbox 根目录，缓存重放也同步。完整 manifest rename 后最终目录 sync 失败时，操作失败但保留完整文件；重试验证并同步同一快照，不删、不重下。release 删除后同步父目录，文件系统同步错误不当作 Agent 交付成功。
