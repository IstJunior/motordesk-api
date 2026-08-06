-- Catálogo de respaldos lógicos de MotorDesk. Los objetos viven en R2.
CREATE TABLE IF NOT EXISTS "backup_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope" VARCHAR(32) NOT NULL DEFAULT 'full',
  "status" VARCHAR(32) NOT NULL DEFAULT 'running',
  "object_key" VARCHAR(500) NOT NULL,
  "size_bytes" BIGINT,
  "created_by_id" BIGINT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backup_records_object_key_key" UNIQUE ("object_key")
);

CREATE INDEX IF NOT EXISTS "backup_records_scope_created_at_idx"
  ON "backup_records"("scope", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "backup_records_status_created_at_idx"
  ON "backup_records"("status", "created_at" DESC);
