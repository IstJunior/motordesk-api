-- Sistema de módulos por taller + WhatsApp propio del taller. Aditivo, no borra nada.

ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "enabled_modules" JSONB;
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "whatsapp_session" VARCHAR(64);
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "whatsapp_status" VARCHAR(32);
