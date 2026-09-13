# Deferred local validation

The latest resource-retirement worker, split input/output SQL cursors and error-only native recovery were checked through source review, syntax checks and fast dependency-injected tests. Their new integrated paths have not been exercised against MySQL, a real bot or a real model after the request to pause real/end-to-end testing. Earlier isolated-MySQL/synthetic-provider evidence covers the previously frozen units; it does not certify these later changes.

When local testing resumes, use an isolated database and synthetic providers first. The harness accepts exactly one test path per invocation and cleans its temporary container; do not run multiple suites against one schema.

```sh
node scripts/test-storage.mjs test/storage-resources.integration.test.mjs
node scripts/test-storage.mjs test/core-resource-retirement.integration.test.mjs
node scripts/test-storage.mjs test/core.integration.test.mjs
```

Check the new input/output indexes and query plans with historical completed output plus current-thread input backlog. Verify that empty output is reclaimed promptly, native/adopt activity excludes deletion, an interrupted seal/delete/ack resumes, and a resource-retired native thread cannot be rebound or adopted. Verify input-directory deletion durability and output source-version claim retention across restart.

Then check the explicit local runtime configuration, readiness and orderly shutdown. Any later real Feishu/Codex exercise should use a designated test application, workspace and conversations. Test private image/post input, group authorization, catchup/live first-receipt deduplication, hook durable acknowledgement, file upload/send ordering, and a non-retrying error with no terminal notification. Unknown admission/upload must remain observable without automatic replay. Do not point this checklist at the existing business bot or production database implicitly.

Compatibility differences remain deliberate: predecessor/orphan automatic interruption is not reproduced. Native IDs, durable admission and audited reconciliation preserve uncertain work. Error-only observation now reads known native state instead of repeating the former local-promise rejection/transport retry sequence. Resource retirement permanently prevents later adoption of threads whose input resources have been sealed for deletion.

No deployment, migration of existing business state, remote repository creation or publication is part of these checks.
