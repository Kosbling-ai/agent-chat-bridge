CREATE TABLE IF NOT EXISTS bridge_inbox (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) CHARACTER SET ascii NOT NULL,
  connection_id VARCHAR(128) NOT NULL,
  event_key VARCHAR(255) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  message_id VARCHAR(255) NOT NULL,
  revision VARCHAR(128) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  occurred_at BIGINT UNSIGNED NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  payload JSON NOT NULL,
  policy_version VARCHAR(128) NOT NULL,
  passive_context BOOLEAN NOT NULL DEFAULT FALSE,
  context_run_id CHAR(36) CHARACTER SET ascii NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY inbox_id (id),
  UNIQUE KEY inbox_event (connection_id, event_key),
  KEY inbox_context (connection_id, conversation_id, passive_context, context_run_id, sequence),
  KEY inbox_message (connection_id, message_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_jobs (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  connection_id VARCHAR(128) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  hook_id VARCHAR(128) NOT NULL DEFAULT '',
  idempotency_key VARCHAR(255) NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii NULL,
  source_sequence BIGINT UNSIGNED NULL,
  payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  payload JSON NOT NULL,
  result JSON NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at BIGINT UNSIGNED NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_token CHAR(36) CHARACTER SET ascii NULL,
  lease_expires_at BIGINT UNSIGNED NULL,
  error_code VARCHAR(64) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY jobs_key (connection_id, kind, hook_id, idempotency_key),
  KEY jobs_claim (kind, status, next_attempt_at, created_at),
  KEY jobs_lease (status, lease_expires_at),
  KEY jobs_conversation (connection_id, conversation_id, hook_id, kind, sequence, status),
  KEY jobs_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_outbox (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  connection_id VARCHAR(128) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  payload JSON NOT NULL,
  job_id CHAR(36) CHARACTER SET ascii NULL,
  predecessor_id CHAR(36) CHARACTER SET ascii NULL,
  platform_uuid CHAR(36) CHARACTER SET ascii NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  first_attempt_at BIGINT UNSIGNED NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at BIGINT UNSIGNED NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_token CHAR(36) CHARACTER SET ascii NULL,
  lease_expires_at BIGINT UNSIGNED NULL,
  result JSON NULL,
  error_code VARCHAR(64) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY outbox_key (connection_id, idempotency_key),
  KEY outbox_job (job_id, status),
  KEY outbox_claim (status, next_attempt_at, created_at),
  KEY outbox_lease (status, lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_sessions (
  connection_id VARCHAR(128) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  generation BIGINT UNSIGNED NOT NULL DEFAULT 1,
  native_thread_id VARCHAR(255) NULL,
  active_run_id CHAR(36) CHARACTER SET ascii NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (connection_id, conversation_id, agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_run_events (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii NOT NULL,
  event_key VARCHAR(255) NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  payload JSON NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY run_event_key (run_id, event_key),
  KEY run_event_page (run_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_cursors (
  connection_id VARCHAR(128) NOT NULL,
  cursor_key VARCHAR(255) NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  value JSON NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (connection_id, cursor_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS bridge_attempts (
 job_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
 connection_id VARCHAR(128) NOT NULL,
 conversation_id VARCHAR(255) NOT NULL,
 agent_id VARCHAR(128) NOT NULL,
 generation BIGINT UNSIGNED NOT NULL,
 native_thread_id VARCHAR(255) NULL,
 native_turn_id VARCHAR(255) NULL,
 created_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS bridge_native_events (
 sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 connection_id VARCHAR(128) NOT NULL,
 event_key VARCHAR(255) NOT NULL,
 native_thread_id VARCHAR(255) NULL,
 native_turn_id VARCHAR(255) NULL,
 payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 payload JSON NOT NULL,
 created_at BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY native_event_key (connection_id,event_key),
 KEY native_event_page (connection_id,native_thread_id,sequence),
 KEY native_turn_event_page (connection_id,native_thread_id,native_turn_id,sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS bridge_message_tombstones (
 connection_id VARCHAR(128) NOT NULL,
 message_id VARCHAR(255) NOT NULL,
 created_at BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY (connection_id,message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS bridge_registration_scopes (
 connection_id VARCHAR(128) NOT NULL,
 conversation_id VARCHAR(255) NOT NULL,
 PRIMARY KEY (connection_id,conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS bridge_message_receipts (
 connection_id VARCHAR(128) NOT NULL,
 conversation_id VARCHAR(255) NOT NULL,
 message_id VARCHAR(255) NOT NULL,
 first_event_id CHAR(36) CHARACTER SET ascii NOT NULL,
 PRIMARY KEY (connection_id,conversation_id,message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS bridge_conversations (
 connection_id VARCHAR(128) NOT NULL,
 conversation_id VARCHAR(255) NOT NULL,
 conversation_type VARCHAR(16) NOT NULL,
 PRIMARY KEY (connection_id,conversation_id),
 KEY conversation_type_page (connection_id,conversation_type,conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
