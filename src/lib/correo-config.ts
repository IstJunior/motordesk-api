import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { decryptJson, encryptJson } from "./crypto.js";

// Configuración del correo saliente de la plataforma.
//
// Vive en `system_settings` bajo la misma clave y con la misma forma que ya lee
// el panel del taller (`GLOBAL_NOTIFICATION_EMAIL_SETTING_KEY` en
// src/lib/notifications.ts del monolito). Es a propósito: los dos servicios
// comparten la base, así que guardar aquí significa que el monolito lo toma sin
// cambiar nada y no hay dos configuraciones que mantener.
//
// El orden de resolución del monolito es taller → global → entorno. Esto es el
// nivel "global": lo que el superadmin configura por interfaz. El entorno queda
// como respaldo, para que el correo siga saliendo si la fila no existe todavía.

export const CLAVE_CORREO_GLOBAL = "notifications_email_global";

export type OrigenCorreo = "panel" | "entorno";

export type ConfigCorreo = {
  enabled: boolean;
  provider: "smtp";
  fromName: string;
  fromEmail: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPass: string | null;
};

function texto(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  return limpio.length > 0 ? limpio : null;
}

function booleano(valor: unknown): boolean {
  return valor === true || valor === "true" || valor === "on" || valor === 1 || valor === "1";
}

function numero(valor: unknown): number | null {
  const crudo = typeof valor === "string" ? valor.trim() : valor;
  if (crudo === "" || crudo === null || crudo === undefined) return null;
  const n = Number(crudo);
  return Number.isFinite(n) ? n : null;
}

// La contraseña se guarda cifrada en `smtpPassEnc` (aes-256-gcm, la misma clave
// que las credenciales de pasarela). `smtpPass` en claro se sigue leyendo porque
// es la forma que escribía el monolito antes de que esto existiera.
function passwordDe(fila: Record<string, unknown>): string | null {
  const cifrada = texto(fila.smtpPassEnc);
  if (cifrada) {
    try {
      return decryptJson<string>(cifrada);
    } catch (error) {
      console.error("[correo] no se pudo descifrar la contraseña SMTP guardada", error);
      return null;
    }
  }
  return texto(fila.smtpPass);
}

function comoRegistro(valor: unknown): Record<string, unknown> | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

/** Lo guardado por el superadmin, sin mirar el entorno. */
export async function configGuardada(): Promise<ConfigCorreo | null> {
  const fila = await prisma.systemSetting.findUnique({
    where: { key: CLAVE_CORREO_GLOBAL },
    select: { value: true },
  });
  const datos = comoRegistro(fila?.value);
  if (!datos) return null;

  const puerto = numero(datos.smtpPort);
  return {
    enabled: booleano(datos.enabled),
    provider: "smtp",
    fromName: texto(datos.fromName) ?? "MotorDesk",
    fromEmail: texto(datos.fromEmail) ?? texto(datos.smtpUser) ?? "",
    smtpHost: texto(datos.smtpHost),
    smtpPort: puerto,
    // El 465 abre en SSL desde el saludo; el 587 sube a TLS con STARTTLS, que es
    // lo que hace nodemailer cuando `secure` es false.
    smtpSecure: datos.smtpSecure !== undefined ? booleano(datos.smtpSecure) : puerto === 465,
    smtpUser: texto(datos.smtpUser),
    smtpPass: passwordDe(datos),
  };
}

/** Respaldo por entorno, para cuando la fila todavía no existe. */
export function configEntorno(): ConfigCorreo | null {
  const host = texto(process.env.SMTP_HOST);
  const user = texto(process.env.SMTP_USER);
  const pass = texto(process.env.SMTP_PASSWORD) ?? texto(process.env.SMTP_PASS);
  if (!host || !user || !pass) return null;

  const puerto = numero(process.env.SMTP_PORT) ?? 465;
  const secure = texto(process.env.SMTP_SECURE);
  return {
    enabled: true,
    provider: "smtp",
    fromName: texto(process.env.EMAIL_FROM_NAME) ?? "MotorDesk",
    fromEmail: texto(process.env.EMAIL_FROM_ADDRESS) ?? user,
    smtpHost: host,
    smtpPort: puerto,
    smtpSecure: secure !== null ? booleano(secure) : puerto === 465,
    smtpUser: user,
    smtpPass: pass,
  };
}

/** Sin estos datos la conexión se abre y el envío se rechaza: no sirve. */
export function sirve(config: ConfigCorreo | null): config is ConfigCorreo {
  if (!config || !config.enabled) return false;
  return Boolean(config.smtpHost && config.smtpPort && config.fromEmail && config.smtpUser && config.smtpPass);
}

/** Lo que se va a usar de verdad para enviar, y de dónde salió. */
export async function configEfectiva(): Promise<{ config: ConfigCorreo; origen: OrigenCorreo } | null> {
  const guardada = await configGuardada();
  if (sirve(guardada)) return { config: guardada, origen: "panel" };

  const entorno = configEntorno();
  if (sirve(entorno)) return { config: entorno, origen: "entorno" };

  return null;
}

/** Campos que faltan, para decirlo en el panel en vez de fallar mudo. */
export function faltantes(config: ConfigCorreo | null): string[] {
  if (!config) return ["Servidor", "Puerto", "Usuario", "Contraseña", "Remitente"];
  const faltan: string[] = [];
  if (!config.smtpHost) faltan.push("Servidor");
  if (!config.smtpPort) faltan.push("Puerto");
  if (!config.smtpUser) faltan.push("Usuario");
  if (!config.smtpPass) faltan.push("Contraseña");
  if (!config.fromEmail) faltan.push("Remitente");
  return faltan;
}

export type EntradaConfigCorreo = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  fromName: string;
  fromEmail: string;
  /** Vacío = conservar la que ya está guardada. */
  smtpPass?: string | null;
};

export async function guardarConfigCorreo(entrada: EntradaConfigCorreo): Promise<ConfigCorreo> {
  const nueva = texto(entrada.smtpPass);
  const anterior = nueva ? null : (await configGuardada())?.smtpPass ?? null;
  const password = nueva ?? anterior;

  const valor = {
    enabled: entrada.enabled,
    provider: "smtp",
    fromName: entrada.fromName.trim() || "MotorDesk",
    fromEmail: entrada.fromEmail.trim(),
    smtpHost: entrada.smtpHost.trim(),
    smtpPort: entrada.smtpPort,
    smtpSecure: entrada.smtpSecure,
    smtpUser: entrada.smtpUser.trim(),
    // `smtpPass` queda en null y el secreto va cifrado: si alguien abre la
    // tabla, no se lleva la contraseña del correo.
    smtpPass: null,
    smtpPassEnc: password ? encryptJson(password) : null,
  } satisfies Prisma.InputJsonObject;

  const ahora = new Date();
  await prisma.systemSetting.upsert({
    where: { key: CLAVE_CORREO_GLOBAL },
    create: { key: CLAVE_CORREO_GLOBAL, value: valor, type: "json", group: "notifications", createdAt: ahora, updatedAt: ahora },
    update: { value: valor, type: "json", group: "notifications", updatedAt: ahora },
  });

  return (await configGuardada())!;
}
