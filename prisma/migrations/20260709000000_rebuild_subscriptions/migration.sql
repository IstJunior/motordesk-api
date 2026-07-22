-- Rebuild subscription module (taller → MotorDesk SaaS billing).
-- Greenfield: no production billing data to preserve. Drop the old billing
-- tables and create the new schema. See src/lib/billing/ for the engine.

-- ─── Drop old billing tables ───
DROP TABLE IF EXISTS "subscription_payment_attempts";
DROP TABLE IF EXISTS "subscription_invoices";
DROP TABLE IF EXISTS "workshop_subscriptions";
DROP TABLE IF EXISTS "billing_webhook_events";
DROP TABLE IF EXISTS "billing_plans";

-- ─── Plans (1 tier "MotorDesk Completo" × N intervalos) ───
CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" BIGSERIAL NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'COP',
  "amount" DECIMAL(12,2) NOT NULL,
  "interval_months" INTEGER NOT NULL,
  "trial_days" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_plans_code_key" ON "subscription_plans"("code");
CREATE INDEX IF NOT EXISTS "subscription_plans_is_active_sort_order_idx" ON "subscription_plans"("is_active", "sort_order");

-- ─── Subscription (1 per workshop) ───
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" BIGSERIAL NOT NULL,
  "workshop_id" BIGINT NOT NULL,
  "plan_id" BIGINT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "collection_mode" VARCHAR(16) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'trialing',
  "trial_ends_at" TIMESTAMP(0),
  "current_period_start" TIMESTAMP(0),
  "current_period_end" TIMESTAMP(0),
  "grace_ends_at" TIMESTAMP(0),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "canceled_at" TIMESTAMP(0),
  "mp_preapproval_id" VARCHAR(255),
  "mp_payer_email" VARCHAR(255),
  "card_brand" VARCHAR(32),
  "card_last4" VARCHAR(4),
  "last_payment_at" TIMESTAMP(0),
  "last_failure_at" TIMESTAMP(0),
  "metadata" JSONB,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_workshop_id_key" ON "subscriptions"("workshop_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions"("status");
CREATE INDEX IF NOT EXISTS "subscriptions_provider_status_idx" ON "subscriptions"("provider", "status");
CREATE INDEX IF NOT EXISTS "subscriptions_mp_preapproval_id_idx" ON "subscriptions"("mp_preapproval_id");
CREATE INDEX IF NOT EXISTS "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- ─── Invoices ───
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" BIGSERIAL NOT NULL,
  "subscription_id" BIGINT NOT NULL,
  "workshop_id" BIGINT NOT NULL,
  "plan_id" BIGINT NOT NULL,
  "reference" VARCHAR(120) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'open',
  "period_start" TIMESTAMP(0) NOT NULL,
  "period_end" TIMESTAMP(0) NOT NULL,
  "due_at" TIMESTAMP(0) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'COP',
  "hosted_payment_url" TEXT,
  "paid_at" TIMESTAMP(0),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMP(0),
  "metadata" JSONB,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_reference_key" ON "invoices"("reference");
CREATE INDEX IF NOT EXISTS "invoices_subscription_id_status_idx" ON "invoices"("subscription_id", "status");
CREATE INDEX IF NOT EXISTS "invoices_workshop_id_status_idx" ON "invoices"("workshop_id", "status");
CREATE INDEX IF NOT EXISTS "invoices_status_due_at_idx" ON "invoices"("status", "due_at");

-- ─── Payment transactions (audit of every charge attempt) ───
CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id" BIGSERIAL NOT NULL,
  "invoice_id" BIGINT,
  "subscription_id" BIGINT NOT NULL,
  "workshop_id" BIGINT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'COP',
  "provider_tx_id" VARCHAR(255),
  "reference" VARCHAR(120),
  "raw_payload" JSONB,
  "error_message" TEXT,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_tx_id_key" ON "payment_transactions"("provider_tx_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_invoice_id_idx" ON "payment_transactions"("invoice_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_subscription_id_idx" ON "payment_transactions"("subscription_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_status_idx" ON "payment_transactions"("status");

-- ─── Webhook events (idempotency ledger) ───
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" BIGSERIAL NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "event_id" VARCHAR(255),
  "event_type" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL,
  "processing_status" VARCHAR(32) NOT NULL DEFAULT 'received',
  "processed_at" TIMESTAMP(0),
  "error_message" TEXT,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");
CREATE INDEX IF NOT EXISTS "webhook_events_provider_event_type_idx" ON "webhook_events"("provider", "event_type");
CREATE INDEX IF NOT EXISTS "webhook_events_processing_status_idx" ON "webhook_events"("processing_status");

-- ─── pending_signups: add provider_ref to correlate webhook → signup ───
ALTER TABLE "pending_signups" ADD COLUMN IF NOT EXISTS "provider_ref" VARCHAR(255);

-- ─── Seed plan catalog (1 tier × 4 intervalos). trial_days aplica solo a MP. ───
INSERT INTO "subscription_plans" ("code", "name", "description", "currency", "amount", "interval_months", "trial_days", "sort_order")
VALUES
  ('motordesk-monthly',    'MotorDesk Completo - Mensual',    'Acceso completo, renovación mensual.',        'COP', 39900,  1,  14, 10),
  ('motordesk-quarterly',  'MotorDesk Completo - Trimestral', 'Acceso completo, renovación cada 3 meses.',   'COP', 179700, 3,  14, 20),
  ('motordesk-semiannual', 'MotorDesk Completo - Semestral',  'Acceso completo, renovación cada 6 meses.',   'COP', 329400, 6,  14, 30),
  ('motordesk-annual',     'MotorDesk Completo - Anual',      'Acceso completo, renovación cada 12 meses.',  'COP', 598800, 12, 14, 40)
ON CONFLICT ("code") DO NOTHING;
