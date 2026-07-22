ALTER TABLE "workshop_subscriptions"
  ADD COLUMN IF NOT EXISTS "payment_provider" VARCHAR(32) NOT NULL DEFAULT 'epayco',
  ADD COLUMN IF NOT EXISTS "provider_subscription_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "provider_plan_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "provider_status" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "provider_customer_email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "provider_payer_id" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "workshop_subscriptions_payment_provider_provider_status_idx"
  ON "workshop_subscriptions"("payment_provider", "provider_status");

CREATE INDEX IF NOT EXISTS "workshop_subscriptions_provider_subscription_id_idx"
  ON "workshop_subscriptions"("provider_subscription_id");
