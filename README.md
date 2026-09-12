# agent-chat-bridge

Independent Chat + Agent client. **This repository currently contains only
the B0 runtime foundation. It does not connect to Feishu, start Codex, access
MySQL, receive hooks, execute tasks, or send messages.**

The intended first integration is Feishu + Codex. Business code, rules,
Skills/MCP and document/table APIs belong to the Agent workspace or the
application consuming message hooks. The client is not a business workflow engine.

## Requirements

Node.js 24.x and npm. Tested locally with Node 24.16.0 / npm 11.13.0.
The engine range intentionally targets the tested major; other majors have
not been validated. There are no runtime or development package dependencies.

## Run the foundation

```sh
npm ci
node bin/agent-chat-bridge.mjs --help
node bin/agent-chat-bridge.mjs check-config --config ./config.example.json
npm start -- --config ./config.example.json
```

Configuration paths are explicit, relative to the calling directory or absolute.
No workspace, home-directory config, `.env`, credentials or business files are
auto-discovered. `check-config` only validates the JSON structure; success does
not mean credentials, integration connectivity or readiness have been checked.

- `GET /health/live`: 200 with `{"live":true}` while the HTTP process runs.
- `GET /health/ready`: always 503 with `ready:false` and missing integrations.
- Other paths: 404; non-GET requests: 405. There are no task/message APIs yet.
- SIGINT/SIGTERM stop listening, close idle connections and allow up to two
  seconds before closing remaining connections. Repeated signals are idempotent.

Do not use liveness as bridge readiness. No provider or Store stubs report success.

## Foundation configuration

Only `schemaVersion`, `listen`, and optional `auth` are accepted. Unknown fields,
including inline secrets, are rejected without echoing their names or values.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Required integer `1`; future incompatible config changes require a new version |
| `listen.host` | IP literal; defaults to `127.0.0.1` (no DNS resolution) |
| `listen.port` | Integer 0–65535; defaults to 18830, 0 selects an ephemeral port |
| `listen.allowRemote` | Boolean, defaults false; explicit true required outside loopback |
| `auth.tokenEnv` | Optional environment variable name, e.g. `BRIDGE_SERVICE_TOKEN` |

`auth.tokenEnv` declares the environment reference for future control APIs;
the foundation validates only its name and never reads the environment value.
Health endpoints expose fixed status only and require no token. No authenticated
control APIs exist yet; declaring `auth` does not protect health endpoints.
Token values never belong in JSON, `.env`, source control, logs or command
arguments. Future deployments will inject them through the deployment environment
or system credential manager.

Non-loopback listening requires explicit `allowRemote: true`. HTTP has no TLS;
the foundation does not configure secure transport. Keep the default loopback
listener unless an operator explicitly needs to expose these fixed health responses.

Feishu credential references, explicit Agent workspace, independent storage,
static hook endpoints/scopes and access rules will be introduced with the
components that actually use them. These are **not accepted configuration yet**;
see [boundaries](docs/boundaries.md). This avoids accepting silently ignored settings.

## Validation and diagnostics

```sh
npm test
npm run check
```

Tests start only local HTTP processes using synthetic configuration and tokens;
they do not contact an Agent, chat platform or database. Logs are JSON lifecycle
records with fixed fields. Configuration, request headers, body, URLs and raw
exception messages are not logged. Health polling emits no per-request logs.
Startup/config errors use stable codes and exit 1. No external error-reporting
service is connected in this foundation.

## Delivery status

Local foundation only; package publishing is disabled (`private: true`).
No remote repository or release has been configured. Licensing and public
release review are pending. No existing runtime has been migrated or replaced.
