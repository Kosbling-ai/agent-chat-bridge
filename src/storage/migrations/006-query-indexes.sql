ALTER TABLE assistant_codex_events ADD INDEX idx_assistant_codex_events_message (connection_id,codex_session_id,message_id,id), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE assistant_codex_forward_jobs ADD INDEX idx_forward_status_finished (connection_id,status,finished_at,id), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE bridge_jobs ADD INDEX jobs_conversation_open (connection_id,conversation_id,hook_id,kind,status,sequence), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE bridge_outbox ADD INDEX outbox_unknown_recent (connection_id,status,first_attempt_at,next_attempt_at), ALGORITHM=INPLACE, LOCK=NONE;
