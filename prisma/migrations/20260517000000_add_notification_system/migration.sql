-- Notification inbox, preferences, web push subscriptions, and async deliveries

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL,
  "workshop_id" BIGINT,
  "appointment_id" BIGINT,
  "category" VARCHAR(64) NOT NULL,
  "type" VARCHAR(128) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT NOT NULL,
  "action_url" VARCHAR(500),
  "dedupe_key" VARCHAR(255),
  "metadata" JSONB,
  "read_at" TIMESTAMP(0),
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");
CREATE INDEX IF NOT EXISTS "notifications_workshop_id_category_created_at_idx" ON "notifications"("workshop_id", "category", "created_at");
CREATE INDEX IF NOT EXISTS "notifications_appointment_id_idx" ON "notifications"("appointment_id");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL,
  "workshop_id" BIGINT,
  "category" VARCHAR(64) NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_id_workshop_id_category_channel_key" ON "notification_preferences"("user_id", "workshop_id", "category", "channel");
CREATE INDEX IF NOT EXISTS "notification_preferences_user_id_workshop_id_idx" ON "notification_preferences"("user_id", "workshop_id");

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" BIGINT NOT NULL,
  "workshop_id" BIGINT,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "user_agent" TEXT,
  "revoked_at" TIMESTAMP(0),
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_revoked_at_idx" ON "push_subscriptions"("user_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "push_subscriptions_workshop_id_idx" ON "push_subscriptions"("workshop_id");

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "notification_id" BIGINT,
  "user_id" BIGINT NOT NULL,
  "workshop_id" BIGINT,
  "appointment_id" BIGINT,
  "channel" VARCHAR(32) NOT NULL,
  "category" VARCHAR(64) NOT NULL,
  "type" VARCHAR(128) NOT NULL,
  "recipient" VARCHAR(500),
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT NOT NULL,
  "action_url" VARCHAR(500),
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(0),
  "last_error" TEXT,
  "metadata" JSONB,
  "sent_at" TIMESTAMP(0),
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "notification_deliveries_status_next_attempt_at_created_at_idx" ON "notification_deliveries"("status", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "notification_deliveries_user_id_channel_status_idx" ON "notification_deliveries"("user_id", "channel", "status");
CREATE INDEX IF NOT EXISTS "notification_deliveries_workshop_id_category_idx" ON "notification_deliveries"("workshop_id", "category");
CREATE INDEX IF NOT EXISTS "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");
