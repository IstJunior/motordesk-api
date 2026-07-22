-- Extend inventory items for internal workshop assets (tools/equipment)
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS item_type VARCHAR(32) NOT NULL DEFAULT 'consumable',
  ADD COLUMN IF NOT EXISTS tracks_stock BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS serial_number VARCHAR(120),
  ADD COLUMN IF NOT EXISTS storage_location VARCHAR(180),
  ADD COLUMN IF NOT EXISTS asset_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(180),
  ADD COLUMN IF NOT EXISTS acquired_at DATE;

CREATE INDEX IF NOT EXISTS inventory_items_workshop_item_type_idx
  ON inventory_items (workshop_id, item_type);
