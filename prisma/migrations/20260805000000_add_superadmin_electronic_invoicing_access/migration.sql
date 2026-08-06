-- The workshop can configure and test its own Factus account, but issuing
-- electronic invoices is an explicit per-workshop entitlement of SuperAdmin.
-- Preserve the effective state of already configured workshops on upgrade.
ALTER TABLE workshop_factus_configs
  ADD COLUMN IF NOT EXISTS super_admin_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE workshop_factus_configs
SET super_admin_enabled = enabled
WHERE super_admin_enabled = FALSE
  AND enabled = TRUE;

CREATE INDEX IF NOT EXISTS workshop_factus_configs_super_admin_enabled_idx
  ON workshop_factus_configs(super_admin_enabled);
