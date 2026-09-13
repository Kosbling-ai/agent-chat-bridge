# Source provenance

This bridge was extracted and adapted from Kosbling's `kosbling-automation` project. The source repository is not a runtime dependency. Business code, credentials, production records, Agent business instructions and lark-cli tools were not brought into this repository.

Production behavior and selected pure transformation logic were carried forward from `kosbling-agent/scripts/agent-server.mjs` and `kosbling-agent/feishu-transport/scripts/feishu-media.mjs`: message/post text extraction and image-key selection, textual local-image path prompts, and outbound extension/type selection with the existing one-second file selection allowance. The independent versions add explicit limits, durable snapshots, source-version claims, thread fencing and controlled lifecycle handling; they should not be described as unchanged copies or as already production-validated after modification.

Feishu and Codex protocol clients use the declared pinned dependencies and Codex app-server protocol. Dependencies are installed through npm rather than vendored into this repository and retain their own licenses/notices.

No project license has been selected yet. Making this repository public does not by itself grant permission under an open-source license, and this provenance statement does not substitute for one. License selection remains a separate owner decision.
