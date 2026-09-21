import nodemailer from "nodemailer";
import { configEfectiva, configGuardada, faltantes, type ConfigCorreo, type OrigenCorreo } from "./correo-config.js";

// Correo saliente de la API del proveedor.
//
// Las credenciales ya no se leen del entorno: las configura el superadmin por
// interfaz y viven en `system_settings`, en la misma clave que lee el monolito
// (ver correo-config.ts). El entorno queda como respaldo.

export type { ConfigCorreo, OrigenCorreo };

export async function correoDisponible(): Promise<boolean> {
  return (await configEfectiva()) !== null;
}

/** Qué falta, para poder decirlo en el panel en vez de fallar mudo. */
export async function faltantesCorreo(): Promise<string[]> {
  if (await correoDisponible()) return [];
  return faltantes(await configGuardada());
}

export function transporteDe(config: ConfigCorreo) {
  return nodemailer.createTransport({
    host: config.smtpHost ?? undefined,
    port: config.smtpPort ?? undefined,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? "" } : undefined,
  });
}

export async function enviarCorreo(input: { to: string; subject: string; html: string }): Promise<OrigenCorreo> {
  const resuelto = await configEfectiva();
  if (!resuelto) {
    throw new Error(`Falta configurar el correo saliente: ${(await faltantesCorreo()).join(", ")}.`);
  }

  const { config, origen } = resuelto;
  await transporteDe(config).sendMail({
    from: `${config.fromName} <${config.fromEmail}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });

  return origen;
}
