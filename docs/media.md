# Feishu Agent image input

This module ports the old transport's text/post extraction, image-key traversal, unsupported type labels and image-path wording. It does not add native Codex image blocks, lark-cli, document APIs or a generic media gateway. The original agent received a text prompt containing downloaded paths and chose its own file-reading tools; no real model tool call was tested here.

`await createFeishuMedia({chat,workspace,inboxDir,maxBytes?,maxImages?,maxTotalBytes?,timeoutMs?,log?})` returns `prepare(event,{runId,signal?})` and `release(runId)`. Workspace and inboxDir must be explicit absolute paths, with inboxDir strictly inside workspace. The injected chat client's SDK resource stream is used internally. Call prepare only for an already authorized durable Agent job, before registering a native attempt; never download inside a database transaction or before inbound ACK.

Prepare returns a plain `{status,text,addendum,localPaths,reason?,replyText?}`. Status is ready, ignored, unsupported or failed. Only ready results with actual validated paths can be injected into the model. The caller joins its identity/context prefix, text and addendum using blank lines, preserving the old text-input format.

- Private standalone images and `img` elements in post are downloaded. Duplicate post keys are removed in source order. All images must succeed before returning any paths.
- Group post captions remain text; group images are ignored. Group Agent media is not newly enabled.
- Private file/video/audio/sticker/unknown structured messages remain unsupported, as in the original bridge. Shared chat/user cards produce only the old descriptive text, with no identity lookup.
- `extractMessageText(event)` preserves original post row/newline/link/title behavior; it does not invent locale formats unsupported by the source helper.

## Deliberate reliability changes

The old 20 MiB setting only warned after writing an oversized image. The new module enforces a per-file streaming cap (default/max 20 MiB), at most 9 images, a total retained-resource budget (default 128 MiB, configurable to 1 GiB), and at most 2048 scanned directory/file entries. Budget exhaustion returns failed; it does not delete another thread's resources. Each prepare has a default 15-second budget (at most 30 seconds), and abort/late download results never produce a false path.

The old MIME map selected an extension and defaulted unknown responses to .jpg. The new module accepts only that map's image MIME values: PNG, JPEG/JPG, GIF, WebP, BMP, HEIC and HEIF. Unknown/non-image MIME is explicitly rejected. This is a documented safety narrowing, not a claim that the old code validated MIME or that every listed format was live-tested. It is MIME validation, not full image decoding.

Run IDs and image keys are hashed into stable paths. Directories are 0700 and files 0600; existing symlinks, writable-by-others directories, unsafe files and paths outside the workspace are rejected. Completed manifests contain bounded names, byte counts and SHA-256 hashes; restart verifies/reuses the same files without redownloading. Failed attempts remove only files created by that attempt, never a prior completed manifest. A process crash that leaves complete files without a manifest is reported as media_incomplete_recovery; it is not silently overwritten or falsely returned as complete. The caller can use explicit release only after ruling out a native reader, then retry the still-unadmitted job.

Resources survive turn completion and service restart because a native thread or recovering run may read them again. There is no mtime/TTL garbage collector. `release(runId)` is idempotent and must only be called when core has established that the corresponding native thread is retired and no pending/unknown run can still reference its files. It never accepts a caller-provided file path. The implementation guards stored paths, but a different process running with the same UID is not a security isolation boundary.

Structured lifecycle logs include fixed operation/status/code/duration only, not paths, user text, keys or raw SDK errors. Failed preparation is a recoverable warning; the owning worker decides retry exhaustion and terminal error reporting.

## Verification and staging

`node --test test/feishu-media.test.mjs` exercises real local bytes/permissions/cleanup with an offline resource client. Source-parity fixtures compare old/new text and post image extraction during migration; the published tests have no old-repository dependency. No real bot, model, download or file delivery was used.

This ticket implements inbound preparation only. Core/config/service wiring is a separate coordinated change. Old Agent-generated outbox scanning, automatic upload/send and post-send cleanup still require a separate durable integration; existing explicit bridge upload/send operations remain available. Do not call the complete old media migration finished based on this module alone.
