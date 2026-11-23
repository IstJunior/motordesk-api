// Envío por la API HTTP de SMTP2GO (POST /v3/email/send).
//
// Es la alternativa al SMTP del mismo SMTP2GO: mismo remitente, mismo dominio
// verificado, pero por HTTPS. No depende de que el puerto 587/465 esté abierto y
// devuelve un `email_id` que se busca en Reports → Activity.
//
// La API responde 200 aunque el correo haya fallado: hay que leer
// `data.failed` y `data.failures`, no solo el código HTTP.
//
// Copia de src/lib/correo/smtp2go.ts del monolito: si cambia uno, cambia el otro.

import { htmlATexto } from "./texto-simple.js";

const ENDPOINT = "https://api.smtp2go.com/v3/email/send";
// Un correo con PDF adjunto tarda; sin tope, una caída de SMTP2GO colgaría la
// acción que lo manda.
const TIEMPO_MAXIMO_MS = 30_000;

export type AdjuntoSmtp2go = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

type RespuestaSmtp2go = {
  request_id?: string;
  data?: {
    succeeded?: number;
    failed?: number;
    failures?: unknown[];
    email_id?: string;
    error?: string;
    error_code?: string;
  };
};

export async function enviarPorSmtp2go(input: {
  apiKey: string;
  from: string;
  to: string;
  /** A dónde van las respuestas. El remitente puede no ser un buzón. */
  replyTo?: string | null;
  subject: string;
  html?: string;
  text?: string;
  attachments?: AdjuntoSmtp2go[];
}): Promise<{ emailId: string | null }> {
  const adjuntos = input.attachments ?? [];
  // Sin text_body, SMTP2GO arma el multipart/alternative con la parte de texto
  // VACÍA (visto en las cabeceras de la primera prueba). Una alterna vacía es
  // señal de spam para los filtros: se manda siempre el texto del HTML.
  const texto = input.text ?? (input.html ? htmlATexto(input.html) : undefined);

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Smtp2go-Api-Key": input.apiKey,
      },
      body: JSON.stringify({
        sender: input.from,
        to: [input.to],
        subject: input.subject,
        ...(input.html ? { html_body: input.html } : {}),
        ...(texto ? { text_body: texto } : {}),
        ...(input.replyTo ? { custom_headers: [{ header: "Reply-To", value: input.replyTo }] } : {}),
        ...(adjuntos.length > 0
          ? {
              attachments: adjuntos.map((a) => ({
                filename: a.filename,
                fileblob: a.content.toString("base64"),
                mimetype: a.contentType ?? "application/octet-stream",
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });
  } catch (error) {
    throw new Error(`No se pudo conectar con SMTP2GO: ${error instanceof Error ? error.message : String(error)}`);
  }

  const crudo = await response.text().catch(() => "");
  let cuerpo: RespuestaSmtp2go | null = null;
  try {
    cuerpo = JSON.parse(crudo) as RespuestaSmtp2go;
  } catch {
    cuerpo = null;
  }
  const data = cuerpo?.data;

  if (!response.ok) {
    const detalle = data?.error ?? crudo.slice(0, 300);
    throw new Error(`SMTP2GO rechazó el envío (${response.status}${data?.error_code ? ` ${data.error_code}` : ""}): ${detalle}`);
  }
  if ((data?.failed ?? 0) > 0 || (data?.succeeded ?? 1) === 0) {
    const fallas = (data?.failures ?? []).map(String).join("; ") || "sin detalle";
    throw new Error(`SMTP2GO no entregó el correo: ${fallas}`);
  }

  return { emailId: data?.email_id ?? null };
}
