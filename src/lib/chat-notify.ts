// Aviso al proveedor (nosotros) cuando entra un lead por el widget. Throttle 90s.
import { enviarTexto, openwaHabilitado, SESION_LEADS } from "./openwa.js";

const PROVEEDOR_WA = (process.env.PROVEEDOR_WA ?? "").replace(/\D/g, "");
const CHAT_AVISO = process.env.CHAT_AVISO !== "0";
const PANEL_URL = (process.env.PANEL_URL ?? process.env.BACKEND_URL ?? "").replace(/\/+$/, "");
const avisoUltimo = new Map<string, number>();

export function avisarLead(sessionId: string, nombre: string | null | undefined, texto: string): void {
  if (!CHAT_AVISO || !PROVEEDOR_WA || !openwaHabilitado()) return;
  const ahora = Date.now();
  if (ahora - (avisoUltimo.get(sessionId) ?? 0) < 90_000) return;
  avisoUltimo.set(sessionId, ahora);
  const quien = nombre ? ` de ${nombre}` : "";
  const corto = texto.length > 140 ? texto.slice(0, 137) + "…" : texto;
  const bandeja = PANEL_URL ? `\n\nRespóndelo en tu bandeja: ${PANEL_URL}` : "";
  enviarTexto(SESION_LEADS, PROVEEDOR_WA, `🔔 Nuevo lead MotorDesk${quien}:\n"${corto}"${bandeja}`).catch((e) =>
    console.error("avisarLead:", e instanceof Error ? e.message : e),
  );
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
