-- Inventory module tables for workshop admins.

CREATE TABLE IF NOT EXISTS inventory_items (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  sku VARCHAR(80),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(120),
  unit VARCHAR(50) NOT NULL DEFAULT 'unidad',
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
  min_stock_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP(0)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_workshop_id_sku_key
  ON inventory_items (workshop_id, sku);

CREATE INDEX IF NOT EXISTS inventory_items_workshop_active_name_idx
  ON inventory_items (workshop_id, is_active, name);

CREATE INDEX IF NOT EXISTS inventory_items_workshop_category_idx
  ON inventory_items (workshop_id, category);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  workshop_id BIGINT NOT NULL,
  item_id BIGINT NOT NULL,
  created_by_id BIGINT,
  type VARCHAR(32) NOT NULL,
  quantity NUMERIC(12,3) NOT NULL,
  unit_cost NUMERIC(12,2),
  note TEXT,
  stock_before NUMERIC(12,3) NOT NULL,
  stock_after NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS inventory_movements_workshop_created_idx
  ON inventory_movements (workshop_id, created_at);

CREATE INDEX IF NOT EXISTS inventory_movements_item_created_idx
  ON inventory_movements (item_id, created_at);

CREATE INDEX IF NOT EXISTS inventory_movements_created_by_idx
  ON inventory_movements (created_by_id);
