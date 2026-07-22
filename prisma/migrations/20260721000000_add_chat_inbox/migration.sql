-- Bandeja / chat de leads y talleres (portado de SmartPOS). Aditivo, no borra nada.

CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "name"        VARCHAR(120),
  "phone"       VARCHAR(40),
  "workshop_id" BIGINT,
  "last_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "seen_at"     TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_sessions_last_at_idx" ON "chat_sessions"("last_at");
CREATE INDEX IF NOT EXISTS "chat_sessions_workshop_id_idx" ON "chat_sessions"("workshop_id");

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id"         BIGSERIAL NOT NULL,
  "session_id" UUID NOT NULL,
  "sender"     VARCHAR(16) NOT NULL,
  "text"       TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_messages_session_id_id_idx" ON "chat_messages"("session_id", "id");
