import crypto from "node:crypto";

// Mismo cifrado que el monolito (src/lib/workshop-payments/crypto.ts) para que
// ambos lean los secretos guardados: aes-256-gcm con la clave de entorno.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getEncryptionKey() {
  const raw = process.env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || raw.trim().length < 24) {
    throw new Error("PAYMENT_CREDENTIALS_ENCRYPTION_KEY debe estar configurada con un secreto largo.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptJson<T>(encrypted: string | null | undefined): T | null {
  if (!encrypted) return null;
  const [ivRaw, tagRaw, payloadRaw] = encrypted.split(":");
  if (!ivRaw || !tagRaw || !payloadRaw) throw new Error("Credenciales cifradas inválidas.");
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payloadRaw, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
