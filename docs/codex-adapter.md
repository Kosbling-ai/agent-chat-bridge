# Codex executor

The current service uses `createCodexExecutor` and one forward worker. The older generation worker and its attempt/recovery/reset management API described by the 0.1.1 design are no longer active service paths.

The executor owns one Codex app-server child, a scoped session store, and the fixed workspace. Its normal path preserves the production session binding, orphan-turn cleanup, archived-session replacement, steering and final-answer ownership rules. The temporary known-turn observer remains only for isolating trial rows during the unreleased transition; live and API ingress do not use it to start work.

Each `execute` call owns an in-process response waiter. Stopping that waiter does not interrupt the native turn. A repeated root message defers while an earlier waiter is alive and takes over the final result after it disconnects. Accepted steering follows the same ownership rule. The result includes the display answer, untruncated `rawAnswer`, native identifiers (`threadId` and its `sessionId` compatibility alias), and controlled output attachments.

The process launches only the configured executable and cwd. Production defaults are a three-hour turn timeout, two-minute RPC timeout, `on-request` approval policy, `auto_review` reviewer, `workspace-write` sandbox, enabled workspace network access, and the 60-second/1536 MiB RSS/1024 MiB heap memory guard. Only explicitly selected environment names and configured proxy mappings enter the child. Structured logs and public progress use sanitized facts and never expose provider error text, raw tool parameters or outputs. Internal RPC errors retain the provider classification needed for busy, archived-session, mismatch and turn-failure handling.

See [Forward runtime and API](runtime.md) for routing, delivery modes, public status, and recovery behavior.
