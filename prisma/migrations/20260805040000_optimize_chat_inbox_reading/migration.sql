-- Índices de lectura para la bandeja del superadministrador. No modifican ni
-- eliminan información; aceleran la agrupación de sesiones y el historial.
CREATE INDEX IF NOT EXISTS chat_sessions_phone_workshop_created_idx
  ON chat_sessions (phone, workshop_id, created_at DESC, id DESC)
  WHERE phone IS NOT NULL AND BTRIM(phone) <> '';

CREATE INDEX IF NOT EXISTS chat_messages_session_created_id_idx
  ON chat_messages (session_id, created_at ASC, id ASC);
