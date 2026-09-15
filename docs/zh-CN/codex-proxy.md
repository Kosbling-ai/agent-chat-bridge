# 可选的 Codex 代理配置

[英文原文](../codex-proxy.md)

bridge 不会把宿主的完整环境自动继承给 Codex。`codex.envNames` 按变量名明确选择 app-server 子进程的环境；默认示例只选择 `PATH` 和 `HOME`。因此，桌面端或另一套 Codex 启动器已有的代理，可能没有进入这个独立子进程。

可用可选的 `codex.proxyEnv` 只配置 Codex，避免给 bridge/飞书进程新增标准代理变量。键只允许 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`；值必须是大写环境变量引用，不能填写代理 URL。将[配置片段](../../examples/codex-proxy.fragment.json)中的 `codex.proxyEnv` 合并到完整配置，保留已有的 `bin`、`cwd`、`envNames`、模型和路由。该片段不能单独作为 bridge 配置使用。

无认证的本地代理可由受控启动器注入以下自定义变量，地址和协议应与实际监听一致：

```sh
export BRIDGE_CODEX_PROXY='http://127.0.0.1:7890'
export BRIDGE_CODEX_ALL_PROXY='socks5://127.0.0.1:7890'
export BRIDGE_CODEX_NO_PROXY='localhost,127.0.0.1,::1'
```

这些只是示例，不会自动探测系统代理。`ALL_PROXY` 可选；不需要回退代理时，可删除它的两个映射。代理需要认证时，只通过现有受控凭证注入机制读取 URL，不把凭证写入 JSON、`.env`、命令参数或日志。不要把自定义来源变量名再加入 `envNames`；映射本身就会将其值写入子进程的标准变量。

环境构造顺序明确如下：

1. 从启动环境复制 `codex.envNames` 选中的变量。
2. 仅在子进程环境中应用 `codex.proxyEnv`，覆盖 `envNames` 中选中的同名变量。被覆盖的变量只需映射来源存在，宿主原来的同名变量可以不存在。
3. 每个实际使用的来源必须是非空字符串。缺失或类型无效时，在组件启动前以 `required_environment_missing` 拒绝启动。未知映射键和无效引用会在配置校验时被拒绝。变量值不记入日志。

`envNames` 支持正常的大写或小写环境变量名，因此已有受控启动器仍可直接选择标准代理变量。数据库、token 等凭证引用仍只允许大写名称。如果同时选择大小写形式，应给它们相同的代理地址/绕过值，或者只选择本机客户端适用的一套。bridge 不为冲突的大小写变量虚构优先级，具体解释仍由网络库决定。

bridge 不会修改全局 `process.env`，也不会把这些映射变量加到飞书 SDK 选项中。使用自定义来源变量名，可避免通过标准环境变量为飞书 SDK 新增代理。bridge 进程中原本就存在的标准代理变量仍保持原有影响，`proxyEnv` 不会禁用或重写它们。在容器中运行时，代理必须从容器内可达；容器的 `127.0.0.1` 不是宿主的回环地址。

配置变更在下一次受控启动时生效。不要仅为切换代理打断正在执行的 turn，应在核对当前工作后安排重启。app-server initialize 握手和 bridge ready，并不能证明模型响应已经能通过代理传输。

## 离线验证

`node --test test/service-codex-proxy.test.mjs` 使用真实 service 环境筛选和 Codex 适配器，连接临时 Node stdio fixture。测试验证选中的大小写变量实际进入子进程、自定义映射覆盖直接选择、未选择的环境和 bridge 凭证不会进入子进程、缺少来源时在创建组件前失败，以及默认选择不会加入代理。bridge 进程环境保持不变。SDK/Store/飞书启动均为模拟，不连接代理、数据库、真实模型、机器人或 HTTP 服务。实际网络连通性及提供方重试行为仍需单独本机验证。
