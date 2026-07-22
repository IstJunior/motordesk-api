-- Workshop payment module is intentionally isolated from MotorDesk billing tables and credentials.

CREATE TABLE IF NOT EXISTS "workshop_payment_gateway_configs" (
  "id" BIGSERIAL PRIMARY KEY,
  "workshop_id" BIGINT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "environment" VARCHAR(32) NOT NULL DEFAULT 'sandbox',
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "display_name" VARCHAR(120),
  "credentials_encrypted" TEXT,
  "public_config" JSONB,
  "webhook_secret_encrypted" TEXT,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_payment_gateway_configs_workshop_provider_key"
  ON "workshop_payment_gateway_configs" ("workshop_id", "provider");

CREATE INDEX IF NOT EXISTS "workshop_payment_gateway_configs_workshop_enabled_idx"
  ON "workshop_payment_gateway_configs" ("workshop_id", "enabled");

CREATE TABLE IF NOT EXISTS "payment_requests" (
  "id" BIGSERIAL PRIMARY KEY,
  "workshop_id" BIGINT NOT NULL,
  "appointment_id" BIGINT,
  "user_id" BIGINT,
  "payment_id" BIGINT,
  "provider" VARCHAR(32) NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "reference_code" VARCHAR(255) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
  "amount" NUMERIC(12,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'COP',
  "description" TEXT,
  "payment_url" TEXT,
  "qr_image_base64" TEXT,
  "provider_payment_id" VARCHAR(255),
  "provider_transaction_id" VARCHAR(255),
  "expires_at" TIMESTAMP(0),
  "sent_at" TIMESTAMP(0),
  "paid_at" TIMESTAMP(0),
  "metadata" JSONB,
  "provider_response" JSONB,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_requests_workshop_reference_key"
  ON "payment_requests" ("workshop_id", "reference_code");

CREATE INDEX IF NOT EXISTS "payment_requests_workshop_status_idx"
  ON "payment_requests" ("workshop_id", "status");

CREATE INDEX IF NOT EXISTS "payment_requests_provider_reference_idx"
  ON "payment_requests" ("provider", "reference_code");

CREATE INDEX IF NOT EXISTS "payment_requests_appointment_id_idx"
  ON "payment_requests" ("appointment_id");

CREATE INDEX IF NOT EXISTS "payment_requests_user_id_idx"
  ON "payment_requests" ("user_id");

CREATE TABLE IF NOT EXISTS "workshop_payment_webhook_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" VARCHAR(32) NOT NULL,
  "event_id" VARCHAR(255) NOT NULL,
  "workshop_id" BIGINT,
  "reference_code" VARCHAR(255),
  "provider_transaction_id" VARCHAR(255),
  "signature_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "processed_at" TIMESTAMP(0),
  "raw_payload" JSONB NOT NULL,
  "error_message" TEXT,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_payment_webhook_events_provider_event_key"
  ON "workshop_payment_webhook_events" ("provider", "event_id");

CREATE INDEX IF NOT EXISTS "workshop_payment_webhook_events_provider_reference_idx"
  ON "workshop_payment_webhook_events" ("provider", "reference_code");

CREATE INDEX IF NOT EXISTS "workshop_payment_webhook_events_workshop_id_idx"
  ON "workshop_payment_webhook_events" ("workshop_id");

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "provider" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "payment_request_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "created_by_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE INDEX IF NOT EXISTS "payments_payment_request_id_idx"
  ON "payments" ("payment_request_id");

CREATE INDEX IF NOT EXISTS "payments_created_by_id_idx"
  ON "payments" ("created_by_id");

CREATE INDEX IF NOT EXISTS "payments_provider_status_idx"
  ON "payments" ("provider", "status");
