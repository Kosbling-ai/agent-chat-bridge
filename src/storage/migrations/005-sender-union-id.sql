ALTER TABLE assistant_codex_forward_jobs ADD COLUMN sender_union_id VARCHAR(191) NULL AFTER sender_open_id;
ALTER TABLE assistant_inbound_messages ADD COLUMN sender_union_id VARCHAR(191) NULL AFTER sender_open_id;
