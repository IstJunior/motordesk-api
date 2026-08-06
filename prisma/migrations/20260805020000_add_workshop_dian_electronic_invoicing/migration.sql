-- Modelo A DIAN: cada taller factura con su propia configuración y resolución.
CREATE TABLE IF NOT EXISTS workshop_dian_configs (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  environment VARCHAR(32) NOT NULL DEFAULT 'habilitacion',
  person_type VARCHAR(32) NOT NULL DEFAULT 'juridica',
  document_type VARCHAR(16) NOT NULL DEFAULT '31',
  document_number VARCHAR(64), dv VARCHAR(2), legal_name VARCHAR(255),
  address VARCHAR(255), city VARCHAR(120), municipality_code VARCHAR(16),
  department VARCHAR(120), email VARCHAR(255), phone VARCHAR(80),
  tax_regime VARCHAR(80), responsibilities VARCHAR(255), software_id VARCHAR(255),
  resolution_prefix VARCHAR(32), resolution_number VARCHAR(120),
  technical_key_encrypted TEXT, range_from INTEGER, range_to INTEGER,
  next_invoice_number INTEGER,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS workshop_dian_configs_enabled_idx ON workshop_dian_configs(enabled);

CREATE TABLE IF NOT EXISTS dian_electronic_documents (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  sale_id BIGINT NOT NULL UNIQUE,
  prefix VARCHAR(32), number INTEGER NOT NULL, consecutive VARCHAR(80) NOT NULL,
  environment VARCHAR(32) NOT NULL,
  customer_document_type VARCHAR(16) NOT NULL DEFAULT '13',
  customer_document VARCHAR(64) NOT NULL DEFAULT '222222222222',
  customer_name VARCHAR(255) NOT NULL DEFAULT 'Consumidor final',
  customer_email VARCHAR(255), cufe VARCHAR(128) NOT NULL, xml TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'generated',
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workshop_id, consecutive)
);
CREATE INDEX IF NOT EXISTS dian_electronic_documents_workshop_status_created_idx
  ON dian_electronic_documents(workshop_id, status, created_at);
