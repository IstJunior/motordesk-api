import nodemailer from "nodemailer";

// Correo saliente de la API del proveedor.
//
// Usa las mismas variables que el panel del taller (SMTP_HOST, SMTP_USER,
// SMTP_PASSWORD) para que no haya dos configuraciones que mantener: si el
// correo sale desde MotorDesk, sale desde la misma casilla.
//
// El puerto decide el cifrado: 465 abre en SSL desde el saludo, 587 sube a TLS
// con STARTTLS, que es lo que hace nodemailer cuando `secure` es false.

function clean(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
};

export function emailConfig(): EmailConfig | null {
  const host = clean(process.env.SMTP_HOST);
  const user = clean(process.env.SMTP_USER);
  const pass = clean(process.env.SMTP_PASSWORD) ?? clean(process.env.SMTP_PASS);
  // Sin credenciales la conexión se abre y el envío se rechaza, así que no
  // sirve de nada: es preferible decir que no hay correo configurado.
  if (!host || !user || !pass) return null;

  const port = Number.parseInt(process.env.SMTP_PORT ?? "465", 10) || 465;
  const secureEnv = clean(process.env.SMTP_SECURE);
  return {
    host,
    port,
    secure: secureEnv !== null ? secureEnv === "true" : port === 465,
    user,
    pass,
    fromName: clean(process.env.EMAIL_FROM_NAME) ?? "MotorDesk",
    fromEmail: clean(process.env.EMAIL_FROM_ADDRESS) ?? user,
  };
}

export function correoDisponible(): boolean {
  return emailConfig() !== null;
}

/** Variables que faltan, para poder decirlo en el panel en vez de fallar mudo. */
export function faltantesCorreo(): string[] {
  const faltan: string[] = [];
  if (!clean(process.env.SMTP_HOST)) faltan.push("SMTP_HOST");
  if (!clean(process.env.SMTP_USER)) faltan.push("SMTP_USER");
  if (!clean(process.env.SMTP_PASSWORD) && !clean(process.env.SMTP_PASS)) faltan.push("SMTP_PASSWORD");
  return faltan;
}

export async function enviarCorreo(input: { to: string; subject: string; html: string }): Promise<void> {
  const config = emailConfig();
  if (!config) {
    throw new Error(`Falta configurar el correo saliente en la API: ${faltantesCorreo().join(", ")}.`);
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transport.sendMail({
    from: `${config.fromName} <${config.fromEmail}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
  });
}
