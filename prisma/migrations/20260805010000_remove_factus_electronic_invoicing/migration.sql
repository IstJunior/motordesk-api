-- Factus and its electronic-invoicing module are retired from MotorDesk.
-- Production was audited before this migration: all four tables were empty,
-- except for one Factus row without credentials or issuance data.
DROP TABLE IF EXISTS electronic_invoices;
DROP TABLE IF EXISTS workshop_factus_configs;
DROP TABLE IF EXISTS workshop_fiscal_profiles;
DROP TABLE IF EXISTS customer_billing_profiles;
