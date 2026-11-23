import nodemailer from "nodemailer";
import { configEfectiva, configGuardada, faltantes, type ConfigCorreo, type OrigenCorreo } from "./correo-config.js";
import { htmlATexto, recibeSoloTextoSimple } from "./texto-simple.js";
import { enviarPorSmtp2go } from "./smtp2go.js";

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

/** Manda con una config concreta, por SMTP o por la API de SMTP2GO según el
 *  proveedor elegido en el panel. */
export async function enviarConConfig(
  config: ConfigCorreo,
  input: { to: string; subject: string; html: string },
): Promise<void> {
  // Los dominios educativos retienen sin avisar el correo con diseño: a ellos
  // va solo el texto (ver texto-simple.ts).
  const soloTexto = recibeSoloTextoSimple(input.to);
  const from = `${config.fromName} <${config.fromEmail}>`;
  const replyTo = config.replyTo ?? undefined;

  if (config.provider === "smtp2go") {
    await enviarPorSmtp2go({
      apiKey: config.smtp2goApiKey ?? "",
      from,
      to: input.to,
      replyTo,
      subject: input.subject,
      ...(soloTexto ? { text: htmlATexto(input.html) } : { html: input.html }),
    });
    return;
  }

  await transporteDe(config).sendMail({
    from,
    to: input.to,
    ...(replyTo ? { replyTo } : {}),
    subject: input.subject,
    ...(soloTexto ? { text: htmlATexto(input.html) } : { html: input.html }),
  });
}

export async function enviarCorreo(input: { to: string; subject: string; html: string }): Promise<OrigenCorreo> {
  const resuelto = await configEfectiva();
  if (!resuelto) {
    throw new Error(`Falta configurar el correo saliente: ${(await faltantesCorreo()).join(", ")}.`);
  }

  await enviarConConfig(resuelto.config, input);
  return resuelto.origen;
}
