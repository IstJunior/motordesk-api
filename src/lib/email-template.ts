// Plantilla del correo que sale de MotorDesk hacia el taller.
//
// Es la misma estética del panel del taller (src/lib/email/template.ts en el
// repo de la app), replicada aquí porque esta API es un servicio aparte y no
// comparte código con él. Si una cambia, conviene mover la otra.
//
// HTML de correo: tablas, estilos inline, nada de clases ni <style>.

const ORANGE = "#E8572A";
const INK = "#0F172A";
const BODY_TEXT = "#334155";
const MUTED = "#64748B";
const BORDER = "#E2E8F0";
const CANVAS = "#F1F5F9";
const SURFACE = "#FFFFFF";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function appOrigin(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://motordesk.nexcoreia.com";
  return raw.replace(/\/+$/, "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY_TEXT};">${escapeHtml(text)}</p>`;
}

export function dataTable(rows: Array<[string, string]>): string {
  if (rows.length === 0) return "";
  const body = rows
    .map(
      ([label, value], index) => `<tr>
        <td style="padding:11px 16px;font-family:${FONT};font-size:13px;color:${MUTED};${index > 0 ? `border-top:1px solid ${BORDER};` : ""}white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:11px 16px;font-family:${FONT};font-size:14px;color:${INK};font-weight:600;${index > 0 ? `border-top:1px solid ${BORDER};` : ""}text-align:right;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0;width:100%;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;margin:0 0 18px;">${body}</table>`;
}

export function codeBox(label: string, code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 18px;">
    <tr><td align="center" style="padding:20px 16px;background:${CANVAS};border-radius:12px;">
      <div style="font-family:${FONT};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin-bottom:8px;">${escapeHtml(label)}</div>
      <div style="font-family:${FONT};font-size:28px;font-weight:700;letter-spacing:0.12em;color:${INK};">${escapeHtml(code)}</div>
    </td></tr>
  </table>`;
}

export function note(text: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 18px;">
    <tr><td style="padding:14px 16px;background:rgba(232,87,42,0.07);border-left:3px solid ${ORANGE};border-radius:0 8px 8px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${BODY_TEXT};">${escapeHtml(text)}</td></tr>
  </table>`;
}

export function bulletList(items: string[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (item) => `<tr>
        <td valign="top" style="padding:0 10px 8px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${ORANGE};">&bull;</td>
        <td valign="top" style="padding:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY_TEXT};">${escapeHtml(item)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 18px;">${rows}</table>`;
}

export function renderEmail(input: {
  preheader: string;
  heading: string;
  blocks: string[];
  cta?: { label: string; url: string };
  footerNote?: string;
}): string {
  const logo = `${appOrigin()}/api/icons?size=128`;
  const cta = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:4px 0 18px;">
        <tr><td style="background:${ORANGE};border-radius:10px;">
          <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">${escapeHtml(input.cta.label)}</a>
        </td></tr>
      </table>`
    : "";

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${CANVAS};">${escapeHtml(input.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${CANVAS};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;width:100%;max-width:600px;background:${SURFACE};border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
      <tr><td style="padding:24px 32px;background:${INK};border-radius:14px 14px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding-right:10px;" valign="middle"><img src="${logo}" width="30" height="30" alt="" style="display:block;width:30px;height:30px;border:0;border-radius:7px;" /></td>
          <td valign="middle" style="font-family:${FONT};font-size:19px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">Motor<span style="color:${ORANGE};">Desk</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:30px 32px 6px;">
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:800;color:${INK};letter-spacing:-0.02em;">${escapeHtml(input.heading)}</h1>
        ${input.blocks.filter(Boolean).join("\n")}
        ${cta}
      </td></tr>
      <tr><td style="padding:22px 32px 26px;border-top:1px solid ${BORDER};">
        ${input.footerNote ? `<div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};margin-bottom:10px;">${escapeHtml(input.footerNote)}</div>` : ""}
        <div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};"><strong style="color:${INK};">MotorDesk</strong> &middot; software de gesti&oacute;n para talleres</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
