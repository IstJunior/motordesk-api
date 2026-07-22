-- Billing plans and workshop subscriptions
CREATE TABLE IF NOT EXISTS billing_plans (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  amount NUMERIC(12, 2) NOT NULL,
  interval_months INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS billing_plans_is_active_sort_order_idx
  ON billing_plans (is_active, sort_order);

CREATE TABLE IF NOT EXISTS workshop_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  billing_plan_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'trial',
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
  current_period_start TIMESTAMP(0),
  current_period_end TIMESTAMP(0),
  grace_ends_at TIMESTAMP(0),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMP(0),
  wompi_payment_source_id VARCHAR(255),
  wompi_payment_source_type VARCHAR(64),
  wompi_customer_email VARCHAR(255),
  last_payment_at TIMESTAMP(0),
  last_payment_failure_at TIMESTAMP(0),
  metadata JSONB,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS workshop_subscriptions_workshop_id_status_idx
  ON workshop_subscriptions (workshop_id, status);
CREATE INDEX IF NOT EXISTS workshop_subscriptions_billing_plan_id_idx
  ON workshop_subscriptions (billing_plan_id);
CREATE INDEX IF NOT EXISTS workshop_subscriptions_current_period_end_idx
  ON workshop_subscriptions (current_period_end);

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT NOT NULL,
  workshop_id BIGINT NOT NULL,
  billing_plan_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  period_start TIMESTAMP(0) NOT NULL,
  period_end TIMESTAMP(0) NOT NULL,
  due_at TIMESTAMP(0) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  reference_code VARCHAR(120) NOT NULL UNIQUE,
  paid_at TIMESTAMP(0),
  attempted_at TIMESTAMP(0),
  next_retry_at TIMESTAMP(0),
  attempts_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscription_invoices_subscription_id_status_idx
  ON subscription_invoices (subscription_id, status);
CREATE INDEX IF NOT EXISTS subscription_invoices_workshop_id_status_idx
  ON subscription_invoices (workshop_id, status);
CREATE INDEX IF NOT EXISTS subscription_invoices_due_at_idx
  ON subscription_invoices (due_at);

CREATE TABLE IF NOT EXISTS subscription_payment_attempts (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL,
  subscription_id BIGINT NOT NULL,
  workshop_id BIGINT NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'wompi',
  status VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'COP',
  reference_code VARCHAR(120) NOT NULL,
  provider_transaction_id VARCHAR(255) UNIQUE,
  request_payload JSONB,
  response_payload JSONB,
  error_message TEXT,
  attempted_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscription_payment_attempts_invoice_id_idx
  ON subscription_payment_attempts (invoice_id);
CREATE INDEX IF NOT EXISTS subscription_payment_attempts_subscription_id_idx
  ON subscription_payment_attempts (subscription_id);
CREATE INDEX IF NOT EXISTS subscription_payment_attempts_workshop_id_idx
  ON subscription_payment_attempts (workshop_id);
CREATE INDEX IF NOT EXISTS subscription_payment_attempts_status_idx
  ON subscription_payment_attempts (status);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(32) NOT NULL DEFAULT 'wompi',
  event_id VARCHAR(255),
  event_type VARCHAR(255) NOT NULL,
  signature VARCHAR(255),
  payload JSONB NOT NULL,
  processing_status VARCHAR(32) NOT NULL DEFAULT 'received',
  processed_at TIMESTAMP(0),
  error_message TEXT,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_webhook_events_provider_event_id_key UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_provider_event_type_idx
  ON billing_webhook_events (provider, event_type);
CREATE INDEX IF NOT EXISTS billing_webhook_events_processing_status_idx
  ON billing_webhook_events (processing_status);

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;

INSERT INTO billing_plans (code, name, description, currency, amount, interval_months, is_active, sort_order) VALUES
  ('motordesk-quarterly', 'MotorDesk Completo - Trimestral', 'Acceso completo con renovación cada 3 meses.', 'COP', 179700.00, 3, TRUE, 10),
  ('motordesk-semiannual', 'MotorDesk Completo - Semestral', 'Acceso completo con renovación cada 6 meses.', 'COP', 329400.00, 6, TRUE, 20),
  ('motordesk-annual', 'MotorDesk Completo - Anual', 'Acceso completo con renovación cada 12 meses.', 'COP', 598800.00, 12, TRUE, 30)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  currency = EXCLUDED.currency,
  amount = EXCLUDED.amount,
  interval_months = EXCLUDED.interval_months,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  updated_at = CURRENT_TIMESTAMP;


-- Backfill legacy workshops as active subscriptions to avoid service impact
WITH annual_plan AS (
  SELECT id, interval_months
  FROM billing_plans
  WHERE code = 'motordesk-annual'
  LIMIT 1
), inserted_subscriptions AS (
  INSERT INTO workshop_subscriptions (
    workshop_id,
    billing_plan_id,
    status,
    auto_renew,
    current_period_start,
    current_period_end,
    wompi_customer_email,
    metadata,
    created_at,
    updated_at
  )
  SELECT
    w.id,
    p.id,
    'active',
    FALSE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + make_interval(months => p.interval_months),
    w.email,
    jsonb_build_object('source', 'migration_backfill_legacy_active', 'previous_subscription_status', w.subscription_status),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM workshops w
  CROSS JOIN annual_plan p
  WHERE w.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM workshop_subscriptions ws
      WHERE ws.workshop_id = w.id
    )
  RETURNING workshop_id
)
UPDATE workshops w
SET subscription_status = 'active',
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE w.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM inserted_subscriptions i
    WHERE i.workshop_id = w.id
  );
