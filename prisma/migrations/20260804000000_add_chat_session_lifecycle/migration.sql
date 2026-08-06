-- Conversation lifecycle for the SuperAdmin inbox. This is additive: all
-- existing chat sessions remain active and their full history is preserved.
ALTER TABLE "chat_sessions"
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD COLUMN "closed_at" TIMESTAMPTZ(6);

CREATE INDEX "chat_sessions_status_last_at_idx"
  ON "chat_sessions"("status", "last_at");
