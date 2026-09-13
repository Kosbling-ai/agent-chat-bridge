# Codex executor

The current service uses `createCodexExecutor` and one forward worker. The older generation worker and its attempt/recovery/reset management API described by the 0.1.1 design are no longer active service paths.

The executor owns one Codex app-server child, a scoped session store, and the fixed workspace. Before native admission it calls the forward runtime's start-intent callback; after receiving a turn ID it calls the bound callback. A recovered job with persisted thread, turn, and start time uses the executor's read-only resume path. It does not send `turn/start` again.

The executor returns a display answer, untruncated `rawAnswer`, native identifiers, and controlled output attachments. Native start or observation uncertainty carries an unknown outcome; the forward runtime holds that job. Explicit busy/closing failures may return an unadmitted job to the bounded retry path.

The process launches only the configured executable and cwd. Approval policy is `never`, sandbox is `workspace-write`, and callers cannot override either setting. Only explicitly selected environment names and configured proxy mappings enter the child. Structured logs and public progress use sanitized facts and never expose raw tool parameters or outputs.

See [Forward runtime and API](runtime.md) for routing, delivery modes, public status, and recovery behavior.
