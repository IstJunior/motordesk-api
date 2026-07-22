-- Classify workshops by business type, independently from supported vehicle types.

ALTER TABLE workshops
  ADD COLUMN IF NOT EXISTS workshop_type VARCHAR(64) NOT NULL DEFAULT 'mixed_vehicle';

UPDATE workshops
SET workshop_type = CASE
  WHEN vehicle_types ? 'motorcycle'
    AND NOT (vehicle_types ?| ARRAY['car', 'suv', 'pickup', 'truck', 'van'])
    THEN 'motorcycle'
  WHEN vehicle_types ?| ARRAY['electric', 'emoto', 'escooter']
    AND NOT (vehicle_types ?| ARRAY['car', 'motorcycle'])
    THEN 'electric'
  WHEN vehicle_types ?| ARRAY['car', 'suv', 'pickup', 'truck', 'van', 'electric']
    AND NOT (vehicle_types ? 'motorcycle')
    THEN 'vehicle'
  ELSE 'mixed_vehicle'
END
WHERE vehicle_types IS NOT NULL;

CREATE INDEX IF NOT EXISTS workshops_workshop_type_idx
  ON workshops (workshop_type);
