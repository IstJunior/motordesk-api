// Correo sin formato para los dominios que retienen el diseño.
//
// COPIA de motordesk/src/lib/correo/texto-simple.ts: si cambia uno, cambia el otro.
//
// El filtro de cun.edu.co (Google Workspace) retenía sin avisar —ni a Spam—
// todo correo con tablas o estilos, aunque no trajera código ni enlaces; el
// texto simple sí llegaba, también con un PDF adjunto (22 variantes probadas
// el 2026-11-04). Zoho responde 250 igual, así que "enviado" no prueba que
// llegó. Con Gmail, Hotmail/Outlook y dominios de empresa la plantilla llega
// bien, así que la regla es solo para los educativos: es política de esas
// instituciones, no del correo en general.

/** cun.edu.co, unal.edu.co, mit.edu, unam.edu.mx… */
const DOMINIOS_SOLO_TEXTO: RegExp[] = [/(^|\.)edu(\.[a-z]{2})?$/i];

export function recibeSoloTextoSimple(correo: string): boolean {
  const dominio = correo.trim().toLowerCase().split("@")[1] ?? "";
  return DOMINIOS_SOLO_TEXTO.some((r) => r.test(dominio));
}

const ENTIDADES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/**
 * La plantilla de lib/email/template pasada a texto, para cuando el que llama
 * no trae su propia versión en texto. No pretende ser bonito: que se lea en
 * orden, con los enlaces escritos.
 */
export function htmlATexto(html: string): string {
  return (
    html
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      // El resumen oculto de la bandeja: en texto saldría repetido.
      .replace(/<div style="display:none;[\s\S]*?<\/div>/gi, "")
      .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url: string, texto: string) => {
        const t = texto.replace(/<[^>]+>/g, "").trim();
        if (url.startsWith("tel:") || url.startsWith("mailto:") || !t || t === url) return t || url;
        return `${t} (${url})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(td|th)>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#?\w+);/g, (m, e: string) => ENTIDADES[e] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m))
      .replace(/[ \t ]+/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
