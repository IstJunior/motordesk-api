-- Add workshop branches as locations inside each workshop.

CREATE TABLE IF NOT EXISTS workshop_branches (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(255),
  city VARCHAR(255),
  country VARCHAR(2) NOT NULL DEFAULT 'CO',
  phone VARCHAR(255),
  maps_url VARCHAR(500),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP(0)
);

ALTER TABLE workshop_branches
  ADD CONSTRAINT workshop_branches_workshop_id_fkey
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS workshop_branches_workshop_active_sort_idx
  ON workshop_branches (workshop_id, is_active, sort_order);

CREATE INDEX IF NOT EXISTS workshop_branches_workshop_primary_idx
  ON workshop_branches (workshop_id, is_primary);

CREATE UNIQUE INDEX IF NOT EXISTS workshop_branches_one_primary_active_idx
  ON workshop_branches (workshop_id)
  WHERE is_primary = TRUE AND deleted_at IS NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS branch_id BIGINT;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES workshop_branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS appointments_branch_id_idx
  ON appointments (branch_id);

INSERT INTO workshop_branches (workshop_id, name, address, city, country, phone, is_primary, is_active, sort_order, created_at, updated_at)
SELECT
  w.id,
  'Sede principal',
  w.address,
  w.city,
  COALESCE(NULLIF(w.country, ''), 'CO'),
  w.phone,
  TRUE,
  TRUE,
  0,
  COALESCE(w.created_at, CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM workshops w
WHERE w.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM workshop_branches wb WHERE wb.workshop_id = w.id AND wb.deleted_at IS NULL
  );

UPDATE appointments a
SET branch_id = wb.id
FROM workshop_branches wb
WHERE a.branch_id IS NULL
  AND wb.workshop_id = a.workshop_id
  AND wb.is_primary = TRUE
  AND wb.deleted_at IS NULL;
