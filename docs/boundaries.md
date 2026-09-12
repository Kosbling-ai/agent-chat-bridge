# Integration boundaries after B0

B0 implements only CLI/configuration and HTTP lifecycle. This document describes
responsibilities for subsequent implementation; it does not define working APIs.

- **Feishu client**: one WebSocket owner, durable receipt before acknowledgement,
  existing chat send/read/reply/reaction/media operations. Document/table APIs
  remain in the business application.
- **Core**: chat/session routing and recovery. The same message can trigger an
  application hook and an @Agent conversation. Hook receipt is independent of
  business completion. Reliable queues are internal machinery, not a public
  event-bus or workflow framework.
- **Codex client**: stdio RPC, thread/turn lifecycle and provider-specific recovery.
  An explicit workspace and credential/environment policy are required when
  implemented. Unknown server requests must not be silently approved.
- **Store**: independent schema/migrations, session/inbox/job/outbox state.
  Business applications do not directly access these tables. Initial backend
  planned: MySQL, with environment references for connection credentials.
- **Static HTTP hooks**: configured ID, URL, credential environment reference,
  chat/event scope and passive-context policy. No dynamic subscriber registry.
  Consumers persist their own receipt before acknowledgement; business execution
  and its retries remain theirs.
- **Service API**: authenticated, scoped operations for chat and Agent use.
  Attachments use controlled resources; arbitrary filesystem paths, actor IDs or
  workspace paths must not let a caller exceed its configured access.

Future config fields must be implemented and validated with their runtime
consumer. Feishu secrets, database secrets and hook credentials must use
environment references rather than JSON plaintext. No production credentials,
business rules or existing native Agent state should be copied into this repo.

Do not add fake adapters or a fake Store to make readiness green. Integration
readiness must be derived from the actual assembled components and their status.
