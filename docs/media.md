# Feishu media

The bridge restores the frozen production media boundary. Only authorized P2P Agent messages download images. Standalone images and every `img` in a rich-text post are written below the configured inbox and their paths are appended to the text prompt. Group posts keep their caption and ignore images; other group media is ignored. Private file, video, audio and sticker messages receive the configured unsupported reply. Shared chat and user cards add only the original descriptive text.

`feishu.mediaEnabled` defaults to `true`. `feishu.mediaInboxDir` defaults to `data/feishu-inbox` below the Codex workspace. `feishu.mediaMaxBytes` defaults to 20 MiB and preserves the source behavior: it logs a safe advisory code after download and does not reject the image. No image-count, aggregate-byte, batch-deadline, manifest, or automatic release policy is added to this production path.

Bridge-mode output consumes the executor's attachment path list. P2P delivery is allowed, while groups must be in the existing bridge or authenticated API conversation allowlist. Each file is capped at 28 MiB. Images use Feishu image upload; other extensions use file upload. Successful sends delete the local source. A failed file remains and does not stop the text reply or another attachment.

Caller-mode runs retain the controlled outbox snapshot and resource API. Bridge-mode files that were successfully sent and deleted are not guaranteed to remain downloadable. Tests use synthetic SDK clients and local temporary files; they do not establish real Feishu or model acceptance.
