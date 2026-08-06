-- La sesión pública usa un secreto opaco, guardado únicamente como hash.
-- Esto evita que un UUID conocido permita leer mensajes de otro visitante.
ALTER TABLE "chat_sessions"
  ADD COLUMN "access_token_hash" VARCHAR(64);
