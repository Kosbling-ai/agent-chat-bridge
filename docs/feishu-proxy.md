# Dedicated Feishu proxy

[中文说明](zh-CN/feishu-proxy.md)

Set the optional `feishu.httpProxyEnv` to the name of an uppercase environment variable containing an `http://` or `https://` proxy URL. It is an environment reference, never an inline URL. Merge the [fragment](../examples/feishu-proxy.fragment.json) into the existing `feishu` object.

The service creates one dedicated `HttpsProxyAgent`. REST, token, media, and WebSocket connection-configuration requests receive it through the SDK `httpInstance`; WSS connection and reconnection receive the same agent through `WSClient.agent`. Explicit REST request options force `proxy:false` plus this `httpAgent` and `httpsAgent`, while preserving the existing ten-second, 32 MiB, and zero-redirect limits. The SDK response interceptor remains installed, so business response shapes do not change.

Without `httpProxyEnv`, construction and request options remain unchanged. The bridge does not modify `process.env`, SDK defaults, or define a `NO_PROXY` policy. Ambient proxy behavior is outside this explicit facility. Proxy URLs may contain credentials only when the launcher's controlled secret injection requires them; never write those URLs to configuration, source, logs, health output, or command arguments. Invalid schemes and malformed values fail with the fixed `invalid_feishu_proxy` code.

`node --test test/feishu-proxy.test.mjs` uses SDK 1.60.0 against local HTTPS and WSS fixtures. A local CONNECT proxy observes token, REST, connection-config, initial WSS, and reconnect tunnels. The fixture CA is injected only into its test agent. The test does not resolve or contact Feishu, a model, or a business database.
