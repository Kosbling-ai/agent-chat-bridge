# 飞书专属代理

[英文原文](../feishu-proxy.md)

可选的 `feishu.httpProxyEnv` 填写一个大写环境变量名，该环境变量的值为 `http://` 或 `https://` 代理 URL。配置中只能写环境引用，不能内联 URL。请把[配置片段](../../examples/feishu-proxy.fragment.json)合并到已有的 `feishu` 对象。

service 创建一个专属 `HttpsProxyAgent`。REST、token、媒体与 WebSocket 连接配置请求通过 SDK `httpInstance` 使用它；WSS 首次建连和重连通过 `WSClient.agent` 使用同一个 agent。显式代理时，REST 请求强制使用 `proxy:false` 及该 `httpAgent`、`httpsAgent`，同时保留既有的 10 秒、32 MiB 和禁止重定向限制。SDK 的响应 interceptor 保持不变，业务响应形状不会改变。

未配置 `httpProxyEnv` 时，构造参数与请求选项保持原样。bridge 不修改 `process.env`、SDK defaults，也不新增 `NO_PROXY` 规则；环境中原有代理行为不属于这项显式设施。受控启动器确需认证代理时，URL 可以只存在于密钥注入的进程内存中；不得写入配置、源码、日志、health 或命令行。协议非法或 URL 格式错误统一返回固定错误码 `invalid_feishu_proxy`。

`node --test test/feishu-proxy.test.mjs` 使用真实 SDK 1.60.0 连接本机 HTTPS/WSS fixture。本机 CONNECT 代理会观测 token、REST、连接配置、首次 WSS 与重连隧道；测试 CA 只注入 fixture agent。测试不会解析或访问飞书域名、模型或业务数据库。
