-- Código de taller (formato T-0001). Aditivo, no borra nada.

ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "code" VARCHAR(16);

-- Secuencia para el correlativo del código.
CREATE SEQUENCE IF NOT EXISTS "workshop_code_seq";

-- Backfill: asigna código a los talleres existentes por orden de id.
DO $$
DECLARE
  r RECORD;
  n BIGINT;
BEGIN
  FOR r IN SELECT id FROM "workshops" WHERE code IS NULL ORDER BY id LOOP
    n := nextval('workshop_code_seq');
    UPDATE "workshops" SET "code" = 'T-' || lpad(n::text, 4, '0') WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "workshops_code_key" ON "workshops"("code");
