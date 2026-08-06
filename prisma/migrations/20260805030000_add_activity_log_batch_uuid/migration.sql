-- La columna está declarada en Prisma pero faltaba en instalaciones existentes.
-- Es aditiva y permite que los eventos administrativos se auditen sin errores.
ALTER TABLE activity_log
  ADD COLUMN IF NOT EXISTS batch_uuid VARCHAR(255);
