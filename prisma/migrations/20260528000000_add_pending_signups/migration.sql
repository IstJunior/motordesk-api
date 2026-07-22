CREATE TABLE IF NOT EXISTS "pending_signups" (
  "id" BIGSERIAL NOT NULL,
  "reference" VARCHAR(120) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "plan_code" VARCHAR(64) NOT NULL,
  "provider" VARCHAR(32) NOT NULL DEFAULT 'epayco',
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'COP',
  "token" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "workshop_id" BIGINT,
  "consumed_at" TIMESTAMP(0),
  "expires_at" TIMESTAMP(0) NOT NULL,
  "created_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pending_signups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pending_signups_reference_key" ON "pending_signups"("reference");
CREATE INDEX IF NOT EXISTS "pending_signups_status_idx" ON "pending_signups"("status");
CREATE INDEX IF NOT EXISTS "pending_signups_expires_at_idx" ON "pending_signups"("expires_at");
