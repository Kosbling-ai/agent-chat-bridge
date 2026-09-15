# Optional Codex proxy configuration

[中文说明](zh-CN/codex-proxy.md)

The bridge does not automatically inherit the host environment into Codex. `codex.envNames` selects exact environment names for the app-server child; the default example selects only `PATH` and `HOME`. A proxy configured for a different Codex launcher or the desktop therefore may be absent from this independent child.

Use optional `codex.proxyEnv` to configure only Codex without introducing standard proxy variables into the bridge/Feishu process. Each key must be one of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`; each value is an uppercase environment-variable reference, not a proxy URL. Merge the `codex.proxyEnv` object from [the configuration fragment](../examples/codex-proxy.fragment.json) into your complete configuration, keeping its existing `bin`, `cwd`, `envNames`, model and routing. The fragment alone is not a valid bridge configuration.

For an unauthenticated local proxy, an explicit launcher can supply custom variables like these, using the actual listener and supported protocols:

```sh
export BRIDGE_CODEX_PROXY='http://127.0.0.1:7890'
export BRIDGE_CODEX_ALL_PROXY='socks5://127.0.0.1:7890'
export BRIDGE_CODEX_NO_PROXY='localhost,127.0.0.1,::1'
```

These values are examples, not automatic system-proxy discovery. `ALL_PROXY` is optional: omit its two mappings if no fallback proxy is needed. For an authenticated proxy, load the URL only through the existing controlled secret injection mechanism; keep credentials out of JSON, `.env`, command arguments and logs. Do not add the custom source names to `envNames`: the mapping already resolves them into the child's standard names.

Environment construction is explicit:

1. Copy names selected by `codex.envNames` from the launch environment.
2. Apply `codex.proxyEnv` mappings in the child environment, overriding a same-name `envNames` selection. An overridden name needs only the mapping's source variable; its original host variable need not exist.
3. Every used source must be a nonempty string. Missing/invalid sources reject startup with `required_environment_missing`, before components start. Unknown mapping keys and invalid references reject configuration. Values are not logged.

`envNames` accepts ordinary uppercase or lowercase environment names, so an existing controlled launcher can still select standard proxy names directly. Database/token/secret reference validation stays uppercase-only. If both uppercase and lowercase forms are selected, give them the same endpoint/bypass value, or select only one form appropriate for the installed client. Bridge does not invent a precedence rule between conflicting proxy spellings; the networking library decides how it interprets them.

The bridge never changes global `process.env`, nor adds these mapped variables to Feishu SDK options. Custom source names avoid newly configuring the Feishu SDK through standard ambient proxy variables. Existing standard proxy variables already present in the bridge process retain their existing effects; `proxyEnv` does not disable or rewrite them. A proxy inside a container must be reachable from that container: its `127.0.0.1` is not the host's loopback.

Configuration changes apply on the next controlled service start. Do not interrupt an active turn merely to switch proxy settings; arrange the restart after ongoing work has been reconciled. An app-server initialize handshake and bridge readiness do not prove that a model response can traverse the proxy.

## Offline verification

`node --test test/service-codex-proxy.test.mjs` runs the real service environment projection and Codex adapter against a temporary Node stdio fixture. It verifies that selected uppercase/lowercase variables reach the actual child, custom mappings override direct selection, unselected environment and bridge credentials are absent, missing sources fail before component creation, and the default selection does not add a proxy. The bridge process environment is unchanged. SDK/Store/Feishu startup are simulated; no proxy, database, real model, bot or HTTP server is contacted. Actual network connectivity and provider retry behavior require separate local validation.
