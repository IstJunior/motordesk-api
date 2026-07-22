-- Remove ServiceCategory and related columns
DROP TABLE IF EXISTS service_categories;

ALTER TABLE services DROP COLUMN IF EXISTS category_id;

ALTER TABLE vehicles DROP COLUMN IF EXISTS workshop_id;