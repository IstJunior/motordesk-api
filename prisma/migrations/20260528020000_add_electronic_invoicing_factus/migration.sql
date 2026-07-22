-- Electronic invoicing with Factus multi-tenant sandbox support.

CREATE TABLE IF NOT EXISTS workshop_fiscal_profiles (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL UNIQUE,
  person_type VARCHAR(32) NOT NULL DEFAULT 'natural',
  document_type VARCHAR(32),
  document_number VARCHAR(64),
  dv VARCHAR(2),
  legal_name VARCHAR(255),
  trade_name VARCHAR(255),
  address VARCHAR(255),
  city VARCHAR(120),
  municipality_code VARCHAR(16),
  email VARCHAR(255),
  phone VARCHAR(80),
  tax_regime VARCHAR(80),
  tax_responsibilities JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'incomplete',
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS workshop_fiscal_profiles_status_idx ON workshop_fiscal_profiles(status);

CREATE TABLE IF NOT EXISTS workshop_factus_configs (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL UNIQUE,
  environment VARCHAR(32) NOT NULL DEFAULT 'sandbox',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  base_url VARCHAR(255),
  credentials_encrypted TEXT,
  company_data JSONB,
  numbering_ranges JSONB,
  active_numbering_range_id INTEGER,
  active_numbering_range_data JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'disabled',
  last_test_at TIMESTAMP(0),
  last_error TEXT,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS workshop_factus_configs_status_idx ON workshop_factus_configs(status);
CREATE INDEX IF NOT EXISTS workshop_factus_configs_environment_enabled_idx ON workshop_factus_configs(environment, enabled);

CREATE TABLE IF NOT EXISTS customer_billing_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  person_type VARCHAR(32) NOT NULL DEFAULT 'natural',
  identification_document_code VARCHAR(16),
  identification VARCHAR(64),
  dv VARCHAR(2),
  legal_organization_code VARCHAR(8) NOT NULL DEFAULT '2',
  tribute_code VARCHAR(8) NOT NULL DEFAULT 'ZZ',
  company VARCHAR(255),
  trade_name VARCHAR(255),
  names VARCHAR(255),
  address VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(80),
  municipality_code VARCHAR(16),
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  customer_id BIGINT,
  created_by_id BIGINT,
  reference_code VARCHAR(255) NOT NULL,
  customer_mode VARCHAR(32) NOT NULL DEFAULT 'final_consumer',
  final_consumer_reason VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'paid',
  payment_status VARCHAR(32) NOT NULL DEFAULT 'paid',
  payment_method VARCHAR(64) NOT NULL DEFAULT 'manual',
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  paid_at TIMESTAMP(0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_workshop_reference_code_key ON sales(workshop_id, reference_code);
CREATE INDEX IF NOT EXISTS sales_workshop_created_idx ON sales(workshop_id, created_at);
CREATE INDEX IF NOT EXISTS sales_customer_id_idx ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL,
  inventory_item_id BIGINT,
  code_reference VARCHAR(120) NOT NULL,
  name VARCHAR(255) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL,
  discount_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 19,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_measure_code VARCHAR(16) NOT NULL DEFAULT '94',
  standard_code VARCHAR(16) NOT NULL DEFAULT '999',
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS sale_items_inventory_item_id_idx ON sale_items(inventory_item_id);

CREATE TABLE IF NOT EXISTS electronic_invoices (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  appointment_id BIGINT,
  payment_id BIGINT,
  sale_id BIGINT,
  customer_id BIGINT,
  provider VARCHAR(32) NOT NULL DEFAULT 'factus',
  environment VARCHAR(32) NOT NULL DEFAULT 'sandbox',
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(80) NOT NULL,
  reference_code VARCHAR(255) NOT NULL,
  customer_mode VARCHAR(32) NOT NULL DEFAULT 'final_consumer',
  final_consumer_reason VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  factus_number VARCHAR(120),
  prefix VARCHAR(32),
  cufe VARCHAR(255),
  qr TEXT,
  pdf_base64 TEXT,
  pdf_filename VARCHAR(255),
  xml_base64 TEXT,
  xml_filename VARCHAR(255),
  payload JSONB,
  provider_response JSONB,
  error_message TEXT,
  validated_at TIMESTAMP(0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS electronic_invoices_workshop_provider_reference_key ON electronic_invoices(workshop_id, provider, reference_code);
CREATE UNIQUE INDEX IF NOT EXISTS electronic_invoices_workshop_source_key ON electronic_invoices(workshop_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS electronic_invoices_workshop_status_created_idx ON electronic_invoices(workshop_id, status, created_at);
CREATE INDEX IF NOT EXISTS electronic_invoices_appointment_id_idx ON electronic_invoices(appointment_id);
CREATE INDEX IF NOT EXISTS electronic_invoices_payment_id_idx ON electronic_invoices(payment_id);
CREATE INDEX IF NOT EXISTS electronic_invoices_sale_id_idx ON electronic_invoices(sale_id);
