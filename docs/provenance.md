# Source provenance

This bridge was extracted and adapted from Kosbling's `kosbling-automation` project. The source repository is not a runtime dependency. Business code, credentials, production records, Agent business instructions and lark-cli tools were not brought into this repository.

The extraction used the frozen `kosbling-automation` source commit `f77d976355e790ac812d5590dd5ed9f2132cf6f8`, rather than that repository's moving head. Production behavior and selected transformations came from `kosbling-agent/scripts/agent-server.mjs`, `kosbling-agent/feishu-transport/scripts/feishu-transport.mjs`, `execution-card.mjs`, and `feishu-media.mjs`:

- Codex child/session/turn admission and observation became the modules under `src/agents/codex/`.
- Forward claim, lease, reply-pending and recovery became `src/core/forward-runtime.mjs` and `src/storage/forward-jobs.mjs`.
- Group prompt/context and recall filtering became `src/channels/feishu/input.mjs` and `src/storage/inbound-messages.mjs`.
- The execution card, Typing and stop behavior became `execution-card.mjs` and `execution-feedback.mjs`; answer and attachment delivery became `replies.mjs` plus the controlled outbound module.

The independent versions replace the old in-process HTTP hop with an injected executor, add caller/namespace isolation, explicit delivery modes, fenced unknown-outcome recovery, durable effect receipts, safe public projections, total attachment budget, source-version claims and controlled resource reads. They should not be described as unchanged copies or as already production-validated after modification. The public 28 MiB attachment budget is total across a run; the frozen source used a per-file upload cap.

Feishu and Codex protocol clients use the declared pinned dependencies and Codex app-server protocol. Dependencies are installed through npm rather than vendored into this repository and retain their own licenses/notices.

No project license has been selected yet. Making this repository public does not by itself grant permission under an open-source license, and this provenance statement does not substitute for one. License selection remains a separate owner decision.

The final-only renderer in `src/channels/feishu/reply-card.mjs` and the live
renderer in `execution-card.mjs` adapt the schema-2.0 header, Markdown body,
summary and status presentation from the frozen production execution card.
The live card consumes only the shared safe public progress projection and its
stop callback is fenced to the persisted run, card and exact native turn.
Business-specific daily-card parsing and branding remain outside the bridge.
This source attribution does not resolve the repository's pending license
decision.
