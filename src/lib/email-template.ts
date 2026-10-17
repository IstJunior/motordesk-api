// Plantilla del correo que sale de MotorDesk desde esta API (invitaciones,
// pruebas de SMTP).
//
// Es copia de src/lib/email/template.ts del repo de la app: esta API es un
// servicio aparte y no comparte código con él. Si una cambia, se copia la otra
// entera; así nunca quedan dos estéticas para el mismo producto.
//
// ── Lo que sigue es el texto de la app ──
// Plantilla única para todo el correo que sale de MotorDesk.
//
// Antes cada emisor armaba su propio HTML: `shell()` en billing/emails.ts (botón
// azul), `renderAppointmentStatusEmail()` en notifications/events.ts (botón
// naranja) y tres `<p>` sueltos en appointment-report.ts. Tres estéticas para el
// mismo producto. Este módulo es el único sitio donde vive el diseño.
//
// Dos marcas, porque son dos audiencias:
//   - `motordesk`: le escribimos al taller (facturación, acceso, suscripción).
//   - `workshop`:  el taller le escribe a SU cliente (turnos, informes). Manda
//                  el nombre del taller; MotorDesk queda como firma al pie.
//
// HTML de correo, no de web: tablas, estilos en línea y nada de flex ni grid.
// Outlook y Gmail descartan casi todo lo demás. Las pocas clases que hay solo
// sirven para afinar donde se puede (modo oscuro en Apple Mail, márgenes en el
// celular); si un cliente las ignora, el correo se ve igual de bien en claro.
//
// La identidad es la de la portada de MotorDesk: tinta casi negra, naranja de
// marca y Bricolage Grotesque en los títulos (con caída a la letra del sistema,
// que es lo que muestra Gmail). La regla de diseño es la contención: el color
// de acento se usa para lo que hay que hacer (el botón) y para el estado, no
// para decorar.

const ORANGE = "#E8572A";
const INK = "#0B1220";
const BODY_TEXT = "#3A4556";
const MUTED = "#667085";
const BORDER = "#E6E8EC";
const CANVAS = "#F3F4F6";
const SURFACE = "#FFFFFF";
const SOFT = "#F8F9FB";

const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = "'Bricolage Grotesque','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace";

function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null;
}

function luminance(hex: string): number {
  const channel = (start: number) => {
    const v = parseInt(hex.slice(start, start + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

function darken(hex: string, factor: number): string {
  const c = (start: number) =>
    Math.max(0, Math.round(parseInt(hex.slice(start, start + 2), 16) * factor))
      .toString(16)
      .padStart(2, "0");
  return `#${c(1)}${c(3)}${c(5)}`;
}

// El botón lleva el color de la marca, pero su texto tiene que leerse (AA,
// 4,5:1). El naranja de MotorDesk con letra blanca da 3,3:1: se lee mal al sol
// y en un celular con el brillo bajo. Si con blanco no alcanza y con tinta
// tampoco, el fondo se oscurece de a poco hasta que el blanco sí alcance; el
// tono sigue siendo el del taller, solo más profundo.
function buttonColors(accent: string): { background: string; text: string } {
  if (contrast(accent, "#FFFFFF") >= 4.5) return { background: accent, text: "#FFFFFF" };
  // Se prefiere letra blanca con el tono un poco más profundo: así se ve el
  // botón de una marca. Solo si hay que oscurecerlo tanto que deja de parecerse
  // (un amarillo que se vuelve marrón) se pasa a letra oscura.
  let fondo = accent;
  let pasos = 0;
  while (pasos < 12 && contrast(fondo, "#FFFFFF") < 4.5) {
    fondo = darken(fondo, 0.92);
    pasos++;
  }
  if (pasos <= 4) return { background: fondo, text: "#FFFFFF" };
  return { background: accent, text: INK };
}

// Un color de acento que también se lea como texto sobre blanco (las etiquetas
// de arriba, el paso actual del turno).
function readableAccent(accent: string): string {
  let color = accent;
  for (let i = 0; i < 12 && contrast(color, SURFACE) < 4.5; i++) color = darken(color, 0.9);
  return color;
}

// El fondo del aviso es el mismo color de acento, muy diluido.
function tint(hex: string, alpha = 0.07): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function accentOf(brand: EmailBrand): string {
  if (brand.kind === "workshop") return normalizeHex(brand.accentColor) ?? ORANGE;
  return ORANGE;
}

function motorDeskMark(size: number): string {
  return `${appOrigin()}/api/icons?size=${size}`;
}

export type EmailBrand =
  | { kind: "motordesk" }
  // El taller escribiéndole a su cliente. Manda su identidad: su logo y su
  // color si los configuró en Personalización. Lo que no configuró cae al
  // default de MotorDesk, nunca a un hueco.
  | {
      kind: "workshop";
      workshopName: string;
      /** URL pública del logo del taller (WorkshopTheme.logoPath). */
      logoUrl?: string | null;
      /** Color primario del taller (WorkshopTheme.primaryColor), #rrggbb. */
      accentColor?: string | null;
      /** Teléfono del taller: va al pie, para que el cliente sepa a quién llamar. */
      phone?: string | null;
    };

export type EmailCta = { label: string; url: string };

/** Color con el que se pintan botón, viñetas y avisos de esta marca. */
export function brandAccent(brand: EmailBrand): string {
  return accentOf(brand);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appOrigin(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://motordesk.nexcoreia.com";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${appOrigin()}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

// ── Bloques de contenido ───────────────────────────────────────────────────
// Cada uno devuelve HTML listo para meter en `blocks`. Reciben texto plano y
// escapan ellos mismos, salvo `rawHtml`, que existe para los casos donde el
// emisor necesita negritas dentro de una frase.

const P = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BODY_TEXT};`;

export function paragraph(text: string): string {
  return `<p class="md-text" style="${P}">${escapeHtml(text)}</p>`;
}

export function rawHtml(html: string): string {
  return `<p class="md-text" style="${P}">${html}</p>`;
}

/** El primer párrafo, un punto más grande: es lo que se lee antes de decidir si seguir. */
export function lead(text: string): string {
  return `<p class="md-text" style="margin:0 0 20px;font-family:${FONT};font-size:16px;line-height:1.6;color:${BODY_TEXT};">${escapeHtml(text)}</p>`;
}

// Tabla etiqueta/valor. Es el bloque que más se usa: datos del turno, del pago,
// del taller. Se apila bien en móvil porque cada fila es una fila de tabla, y
// los números van en cifras tabulares para que los montos queden alineados.
export function dataTable(rows: Array<[string, string]>): string {
  if (rows.length === 0) return "";
  const body = rows
    .map(
      ([label, value], index) => `<tr>
        <td class="md-muted" valign="top" style="padding:12px 16px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};${index > 0 ? `border-top:1px solid ${BORDER};` : ""}width:38%;">${escapeHtml(label)}</td>
        <td class="md-strong" valign="top" style="padding:12px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};font-weight:600;font-variant-numeric:tabular-nums;${index > 0 ? `border-top:1px solid ${BORDER};` : ""}text-align:right;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="md-box" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;border-spacing:0;width:100%;border:1px solid ${BORDER};border-radius:12px;margin:0 0 20px;">${body}</table>`;
}

// La placa como se ve en la calle: fondo amarillo, letra negra, borde. Es lo
// primero que el cliente reconoce de su vehículo, antes que la marca o el modelo.
function placa(texto: string): string {
  return `<span style="display:inline-block;padding:3px 9px;background:#FFD320;border:1.5px solid #1F2937;border-radius:5px;font-family:${MONO};font-size:13px;font-weight:700;letter-spacing:0.08em;color:#111827;white-space:nowrap;">${escapeHtml(texto.toUpperCase())}</span>`;
}

/** El vehículo del turno: marca y modelo grandes, la placa como placa, y el detalle debajo. */
export function vehicleCard(input: { titulo: string; placa?: string | null; detalle?: string | null }): string {
  return `<table class="md-soft" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;width:100%;background:${SOFT};border:1px solid ${BORDER};border-radius:12px;margin:0 0 20px;">
    <tr><td style="padding:16px 18px;">
      <div class="md-muted" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:0 0 6px;">Vehículo</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td valign="middle" class="md-strong" style="font-family:${DISPLAY};font-size:19px;line-height:1.3;font-weight:700;color:${INK};letter-spacing:-0.01em;">${escapeHtml(input.titulo)}</td>
        ${input.placa ? `<td valign="middle" align="right" style="padding-left:12px;white-space:nowrap;">${placa(input.placa)}</td>` : ""}
      </tr></table>
      ${input.detalle ? `<div class="md-muted" style="font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};margin-top:4px;">${escapeHtml(input.detalle)}</div>` : ""}
    </td></tr>
  </table>`;
}

/**
 * En qué va el turno, como una barra por tramos: lo hecho en el color del
 * taller, lo que falta en gris, y el paso actual con su nombre en negrita.
 * Responde la única pregunta que trae al cliente al correo: "¿ya está?".
 */
export function statusSteps(pasos: string[], actual: number, accent: string = ORANGE): string {
  const texto = readableAccent(accent);
  const celdas = pasos
    .map((paso, i) => {
      const hecho = i <= actual;
      return `<td valign="top" width="${Math.floor(100 / pasos.length)}%" style="padding:0 ${i < pasos.length - 1 ? "4px" : "0"} 0 0;">
        <div style="height:6px;line-height:6px;font-size:0;border-radius:3px;background:${hecho ? accent : BORDER};">&nbsp;</div>
        <div class="${i === actual ? "" : "md-muted"}" style="padding-top:8px;font-family:${FONT};font-size:12px;line-height:1.35;${
          i === actual ? `font-weight:700;color:${texto};` : `color:${hecho ? BODY_TEXT : MUTED};`
        }">${escapeHtml(paso)}</div>
      </td>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;width:100%;margin:0 0 22px;"><tr>${celdas}</tr></table>`;
}

// Caja para un dato que hay que copiar o recordar: el código del taller.
export function codeBox(label: string, code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin:0 0 20px;">
    <tr><td class="md-soft" align="center" style="padding:20px 16px;background:${SOFT};border:1px solid ${BORDER};border-radius:12px;">
      <div class="md-muted" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin-bottom:8px;">${escapeHtml(label)}</div>
      <div class="md-strong" style="font-family:${MONO};font-size:28px;font-weight:700;letter-spacing:0.14em;color:${INK};">${escapeHtml(code)}</div>
    </td></tr>
  </table>`;
}

// Aviso con borde de color. Para condiciones que el lector no debe pasar por alto.
export function note(text: string, accent: string = ORANGE): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 20px;">
    <tr><td class="md-text" style="padding:14px 16px;background:${tint(accent)};border-left:3px solid ${accent};border-radius:0 10px 10px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${BODY_TEXT};">${escapeHtml(text)}</td></tr>
  </table>`;
}

export function bulletList(items: string[], accent: string = ORANGE): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (item) => `<tr>
        <td valign="top" style="padding:0 10px 8px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${accent};">&bull;</td>
        <td class="md-text" valign="top" style="padding:0 0 8px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY_TEXT};">${escapeHtml(item)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 20px;">${rows}</table>`;
}

// ── Cabecera y pie ─────────────────────────────────────────────────────────

function header(brand: EmailBrand): string {
  if (brand.kind === "workshop") {
    // Cabecera del taller: su logo si lo configuró, y su nombre. MotorDesk no
    // compite aquí: firma al pie. El fondo es claro porque el logo que sube un
    // taller casi siempre está hecho para papel blanco; sobre tinta oscura un
    // logotipo negro desaparece.
    const logo = brand.logoUrl?.trim()
      ? `<td valign="middle" style="padding-right:12px;width:1px;white-space:nowrap;">
           <img src="${escapeHtml(brand.logoUrl.trim())}" height="40" alt="${escapeHtml(brand.workshopName)}" style="display:block;max-height:40px;max-width:150px;width:auto;border:0;" />
         </td>`
      : "";
    return `<tr><td class="md-pad" style="padding:24px 32px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        ${logo}
        <td valign="middle" class="md-strong" style="font-family:${DISPLAY};font-size:18px;font-weight:700;color:${INK};letter-spacing:-0.01em;">${escapeHtml(brand.workshopName)}</td>
      </tr></table>
    </td></tr>`;
  }
  return `<tr><td class="md-pad" style="padding:24px 32px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:10px;" valign="middle"><img src="${motorDeskMark(128)}" width="30" height="30" alt="" style="display:block;width:30px;height:30px;border:0;border-radius:8px;" /></td>
      <td valign="middle" class="md-strong" style="font-family:${DISPLAY};font-size:19px;font-weight:700;color:${INK};letter-spacing:-0.02em;">Motor<span style="color:${ORANGE};">Desk</span></td>
    </tr></table>
  </td></tr>`;
}

function footer(brand: EmailBrand, footerNote?: string): string {
  const extra = footerNote
    ? `<div class="md-muted" style="font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};margin-bottom:10px;">${escapeHtml(footerNote)}</div>`
    : "";
  const contacto =
    brand.kind === "workshop" && brand.phone?.trim()
      ? `<div class="md-muted" style="font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">¿Preguntas? Llame o escriba a ${escapeHtml(brand.workshopName)} al <a class="md-strong" href="tel:${escapeHtml(brand.phone.replace(/[^\d+]/g, ""))}" style="color:${INK};font-weight:600;text-decoration:none;white-space:nowrap;">${escapeHtml(brand.phone.trim())}</a>.</div>`
      : "";
  if (!extra && !contacto) return "";
  return `<tr><td class="md-pad md-sep" style="padding:20px 32px 26px;border-top:1px solid ${BORDER};">${extra}${contacto}</td></tr>`;
}

// Debajo de la tarjeta, sobre el fondo: quién lo manda y por qué le llegó.
function colophon(brand: EmailBrand): string {
  const quien =
    brand.kind === "workshop"
      ? `Este correo lo envió ${escapeHtml(brand.workshopName)} con MotorDesk, el sistema con el que lleva sus turnos.`
      : "MotorDesk · Software para talleres de motos y carros en Colombia.";
  return `<tr><td align="center" style="padding:20px 24px 4px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="padding-right:8px;"><img src="${motorDeskMark(64)}" width="16" height="16" alt="" style="display:block;width:16px;height:16px;border:0;border-radius:4px;opacity:0.9;" /></td>
      <td valign="middle" class="md-muted" style="font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">${quien}</td>
    </tr></table>
  </td></tr>`;
}

function ctaButton(cta: EmailCta, accent: string): string {
  const url = absoluteUrl(cta.url);
  const { background, text } = buttonColors(accent);
  // Botón "a prueba de clientes": la celda lleva el color (Outlook ignora el
  // padding de los enlaces) y el enlace ocupa toda el área tocable, 48 px de alto.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="md-btn" style="border-collapse:separate;margin:4px 0 12px;">
    <tr><td align="center" bgcolor="${background}" style="background:${background};border-radius:12px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${text};text-decoration:none;border-radius:12px;">${escapeHtml(cta.label)}</a>
    </td></tr>
  </table>
  <p class="md-muted" style="margin:0 0 4px;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">¿El botón no abre? Copie este enlace en el navegador:<br /><a href="${escapeHtml(url)}" style="color:${MUTED};word-break:break-all;">${escapeHtml(url)}</a></p>`;
}

// ── Layout ─────────────────────────────────────────────────────────────────

export type EmailLayoutInput = {
  /** Desde la API siempre escribe MotorDesk; se deja por si algún día no. */
  brand?: EmailBrand;
  /** Resumen que el cliente de correo muestra junto al asunto en la bandeja. */
  preheader: string;
  /** Rótulo corto sobre el título: "Turno #2027", "Factura". Opcional. */
  eyebrow?: string;
  heading: string;
  /** Bloques ya renderizados: paragraph(), dataTable(), note()… */
  blocks: string[];
  cta?: EmailCta;
  footerNote?: string;
};

// Afinaciones donde el cliente de correo las respeta. Todo lo esencial va en
// línea; esto solo mejora: celular (márgenes y botón a lo ancho) y modo oscuro
// (Apple Mail y iOS; Gmail y Outlook invierten por su cuenta).
const ESTILOS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media only screen and (max-width: 620px) {
    .md-pad { padding-left: 20px !important; padding-right: 20px !important; }
    .md-btn { width: 100% !important; }
    .md-btn a { display: block !important; }
    .md-h1 { font-size: 22px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .md-canvas { background: #0B1220 !important; }
    .md-card { background: #121A2B !important; }
    .md-soft { background: #18223A !important; border-color: #263147 !important; }
    .md-box { border-color: #263147 !important; }
    .md-box td, .md-sep { border-color: #263147 !important; }
    .md-strong, .md-h1 { color: #F3F5F8 !important; }
    .md-text { color: #C9D1DE !important; }
    .md-muted { color: #93A0B5 !important; }
  }
`;

export function renderEmail(entrada: EmailLayoutInput): string {
  const input = { ...entrada, brand: entrada.brand ?? ({ kind: "motordesk" } as EmailBrand) };
  const accent = accentOf(input.brand);
  const cta = input.cta ? ctaButton(input.cta, accent) : "";
  const content = input.blocks.filter(Boolean).join("\n");
  const eyebrow = input.eyebrow
    ? `<div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${readableAccent(accent)};margin:0 0 8px;">${escapeHtml(input.eyebrow)}</div>`
    : "";

  return `<!doctype html>
<html lang="es" dir="ltr"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(input.heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Plus+Jakarta+Sans:wght@400;600;700&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet" />
<style>${ESTILOS}</style>
</head>
<body class="md-canvas" style="margin:0;padding:0;background:${CANVAS};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${CANVAS};">${escapeHtml(input.preheader)}${"&#8199;&#65279;&#847; ".repeat(60)}</div>
<table class="md-canvas" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${CANVAS};">
  <tr><td align="center" style="padding:28px 12px 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:collapse;width:100%;max-width:600px;">
      <tr><td>
        <table class="md-card" role="article" aria-roledescription="email" aria-label="${escapeHtml(input.heading)}" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;width:100%;background:${SURFACE};border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(11,18,32,0.06),0 8px 24px -12px rgba(11,18,32,0.12);">
          <tr><td style="height:4px;line-height:4px;font-size:0;background:${accent};">&nbsp;</td></tr>
          ${header(input.brand)}
          <tr><td class="md-pad" style="padding:22px 32px 26px;">
            ${eyebrow}
            <h1 class="md-h1" style="margin:0 0 16px;font-family:${DISPLAY};font-size:26px;line-height:1.2;font-weight:700;color:${INK};letter-spacing:-0.02em;">${escapeHtml(input.heading)}</h1>
            ${content}
            ${cta}
          </td></tr>
          ${footer(input.brand, input.footerNote)}
        </table>
      </td></tr>
      ${colophon(input.brand)}
    </table>
  </td></tr>
</table>
</body></html>`;
}
