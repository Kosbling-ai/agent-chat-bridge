CREATE TABLE IF NOT EXISTS assistant_codex_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  feishu_open_id VARCHAR(191) NOT NULL,
  chat_id VARCHAR(191) NOT NULL,
  chat_type VARCHAR(64) NOT NULL DEFAULT '',
  codex_session_id VARCHAR(191) NOT NULL,
  thread_name VARCHAR(191) NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_message_id VARCHAR(191) NOT NULL DEFAULT '',
  last_message_at BIGINT NULL,
  last_error TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_assistant_codex_sessions_actor (feishu_open_id, chat_id),
  KEY idx_assistant_codex_sessions_codex (codex_session_id),
  KEY idx_assistant_codex_sessions_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assistant_codex_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  codex_session_id VARCHAR(191) NOT NULL,
  feishu_open_id VARCHAR(191) NOT NULL DEFAULT '',
  chat_id VARCHAR(191) NOT NULL DEFAULT '',
  message_id VARCHAR(191) NOT NULL DEFAULT '',
  event_key VARCHAR(191) NOT NULL,
  event_type VARCHAR(64) NOT NULL DEFAULT '',
  role VARCHAR(32) NOT NULL DEFAULT '',
  title VARCHAR(191) NOT NULL DEFAULT '',
  text MEDIUMTEXT NOT NULL,
  detail_json MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_assistant_codex_events_key (codex_session_id, event_key),
  KEY idx_assistant_codex_events_session (codex_session_id, created_at, id),
  KEY idx_assistant_codex_events_chat (chat_id, created_at),
  KEY idx_assistant_codex_events_public (feishu_open_id, chat_id, codex_session_id, message_id, id),
  KEY idx_assistant_codex_events_progress (feishu_open_id, chat_id, codex_session_id, message_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
