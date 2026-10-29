// Cliente del gateway OpenWA (multi-sesión). Portado del monolito y generalizado
// para operar varias sesiones: `motordesk` (leads) + `taller-<code>` por taller.
//
// Envs: OPENWA_URL, OPENWA_API_KEY, OPENWA_WEBHOOK_TOKEN.
const URL_BASE = process.env.OPENWA_URL;
const KEY = process.env.OPENWA_API_KEY;
export const WEBHOOK_TOKEN = process.env.OPENWA_WEBHOOK_TOKEN ?? "";
export const SESION_LEADS = process.env.OPENWA_SESSION ?? "motordesk";

export function openwaHabilitado(): boolean {
  return Boolean(URL_BASE && KEY);
}

async function api<T = unknown>(ruta: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!openwaHabilitado()) throw new Error("OpenWA no está configurado.");
  const res = await fetch(`${URL_BASE!.replace(/\/+$/, "")}${ruta}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-API-Key": KEY! },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const txt = await res.text();
  const data = txt ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : null;
  if (!res.ok) {
    const msg = data && typeof data === "object" && "message" in data ? (data as { message: string }).message : `Error ${res.status}`;
    throw new Error(`OpenWA ${ruta}: ${msg}`);
  }
  return data as T;
}

interface Sesion {
  id: string;
  name: string;
  status: string;
  phone: string | null;
}

// UUID de la sesión por nombre (crea si no existe). Cacheado por nombre.
const idCache = new Map<string, string>();
async function sesionId(nombre: string): Promise<string> {
  const cached = idCache.get(nombre);
  if (cached) return cached;
  const lista = await api<Sesion[] | { data?: Sesion[]; sessions?: Sesion[] }>("/api/sessions");
  const arr = Array.isArray(lista) ? lista : (lista.data ?? lista.sessions ?? []);
  const found = arr.find((s) => s.name === nombre);
  if (found) {
    idCache.set(nombre, found.id);
    return found.id;
  }
  const creada = await api<Sesion>("/api/sessions", { method: "POST", body: { name: nombre } });
  idCache.set(nombre, creada.id);
  return creada.id;
}

/**
 * Nombre de la sesión por su UUID.
 *
 * Los webhooks de OpenWA traen `sessionId` (el UUID) y no el nombre. Sin esto,
 * el webhook de chat no podía saber si un mensaje era de la línea de leads o
 * de la sesión de un taller, y trataba todo como lead.
 */
const nombrePorId = new Map<string, string>();
export async function nombreDeSesionPorId(id: string): Promise<string | null> {
  if (!id) return null;
  const guardado = nombrePorId.get(id);
  if (guardado) return guardado;
  const s = await api<Sesion>(`/api/sessions/${encodeURIComponent(id)}`).catch(() => null);
  if (!s?.name) return null;
  nombrePorId.set(id, s.name);
  return s.name;
}

export async function crearSesion(nombre: string): Promise<void> {
  await sesionId(nombre);
}

export async function iniciarSesion(nombre: string): Promise<void> {
  const id = await sesionId(nombre);
  await api(`/api/sessions/${id}/start`, { method: "POST" }).catch(() => {});
}

/**
 * Saca a una sesión de un bucle de caídas y la vuelve a arrancar.
 *
 * Cuando el navegador de una sesión se cae al inicializar, el gateway programa
 * reconexiones **sin límite** (`Scheduling reconnect attempt N/∞`). A partir de
 * ahí un `start` no sirve de nada: compite con la reconexión pendiente y vuelve
 * a caer, así que el QR nunca llega a mostrarse. Le pasó a la sesión de leads y
 * desde el panel no había forma de salir de eso.
 *
 * `force-kill` es lo que rompe el ciclo: cancela las reconexiones programadas,
 * mata el Chromium atascado y deja la sesión en `disconnected`. Solo entonces
 * un `start` arranca limpio.
 */
export async function reiniciarSesion(nombre: string, opciones: { desvincular?: boolean } = {}): Promise<void> {
  const id = await sesionId(nombre);
  olvidarEstado(nombre);

  // `logout` borra el perfil de navegador de la sesión: desvincula el número y
  // obliga a escanear otra vez. Solo cuando se pide expresamente ("Desvincular
  // número"). Antes iba siempre, y "Reiniciar" sobre una sesión sana la dejaba
  // pidiendo QR (le pasó al número de MotorDesk el 2026-10-23).
  if (opciones.desvincular) await api(`/api/sessions/${id}/logout`, { method: "POST" }).catch(() => {});
  await api(`/api/sessions/${id}/force-kill`, { method: "POST" }).catch(() => {});
  await api(`/api/sessions/${id}/start`, { method: "POST" }).catch(() => {});
}

/** Estados en los que la sesión está viva o arrancando: no hay que tocarla. */
const SANOS = new Set(["ready", "connected", "authenticated", "authenticating", "qr_ready", "initializing", "connecting", "starting"]);

/** OpenWA no respondió: no se sabe en qué estado está la sesión. */
export class EstadoDesconocido extends Error {}

/**
 * Arranca la sesión, reiniciándola si viene atascada.
 *
 * Si no se sabe en qué estado está (OpenWA ocupado, `429`), no se toca nada:
 * antes eso se tomaba como "atascada" y se reiniciaba de raíz, y un número
 * conectado quedaba desvinculado. Reiniciar no desvincula: conserva el perfil.
 */
export async function conectarSesion(nombre: string): Promise<void> {
  olvidarEstado(nombre);
  const { status } = await estadoSesion(nombre);
  if (status === "desconocido") {
    throw new EstadoDesconocido("WhatsApp no respondió. Espere unos segundos y vuelva a intentar; la sesión no se tocó.");
  }
  if (status === "ready" || status === "connected" || status === "authenticated") return;
  if (SANOS.has(status)) {
    await iniciarSesion(nombre);
    return;
  }
  await reiniciarSesion(nombre);
}

// El estado se guarda unos segundos. El panel lo consulta cada pocos segundos
// mientras espera el QR, y con dos pestañas abiertas eran ~2.100 consultas por
// hora, cada una con 1-2 llamadas a OpenWA: su límite (1.000 por hora por
// cliente) respondía `429` y el panel mostraba "desconocido" con el número
// conectado.
//
// El estado y la imagen del QR se guardan por separado: el estado poco (4 s),
// para notar enseguida que alguien escaneó; el QR más (15 s), porque WhatsApp
// lo renueva cada ~20 s y pedirlo en cada consulta duplicaba las llamadas.
const ESTADO_TTL_MS = 4000;
const QR_TTL_MS = 15000;
const estadoCache = new Map<string, { hasta: number; status: string }>();
const qrCache = new Map<string, { hasta: number; qr: string | null }>();

function olvidarEstado(nombre: string) {
  estadoCache.delete(nombre);
  qrCache.delete(nombre);
}

export async function estadoSesion(nombre: string): Promise<{ status: string; qr: string | null }> {
  let status: string;
  const guardado = estadoCache.get(nombre);
  const id = await sesionId(nombre).catch(() => null);
  if (guardado && guardado.hasta > Date.now()) {
    status = guardado.status;
  } else {
    const s = id ? await api<Sesion>(`/api/sessions/${id}`).catch(() => null) : null;
    status = s?.status ?? "desconocido";
    // Un fallo también se guarda: si OpenWA está saturado, insistir lo empeora.
    estadoCache.set(nombre, { hasta: Date.now() + ESTADO_TTL_MS, status });
  }

  let qr: string | null = null;
  if (status === "qr_ready" && id) {
    const qrGuardado = qrCache.get(nombre);
    if (qrGuardado && qrGuardado.hasta > Date.now()) {
      qr = qrGuardado.qr;
    } else {
      const q = await api<{ qrCode?: string; qr?: string }>(`/api/sessions/${id}/qr`).catch(() => null);
      qr = q?.qrCode ?? q?.qr ?? null;
      qrCache.set(nombre, { hasta: Date.now() + QR_TTL_MS, qr });
    }
  } else {
    qrCache.delete(nombre);
  }
  return { status, qr };
}

/**
 * Deja el webhook de la sesión apuntando a `url` con exactamente esos eventos.
 * Si ya existe con otros eventos, los actualiza: así un despliegue que agrega
 * un evento no exige borrar y volver a crear el webhook a mano.
 */
export async function registrarWebhook(
  nombre: string,
  url: string,
  secret: string,
  events: string[] = ["message.received"],
): Promise<void> {
  const id = await sesionId(nombre);
  const existentes = await api<Array<{ id: string; url: string; events?: string[] }>>(`/api/sessions/${id}/webhooks`).catch(() => []);
  const lista = Array.isArray(existentes) ? existentes : [];
  const actual = lista.find((w) => w.url === url);
  if (actual) {
    const iguales = [...(actual.events ?? [])].sort().join() === [...events].sort().join();
    if (!iguales) await api(`/api/sessions/${id}/webhooks/${actual.id}`, { method: "PUT", body: { events } });
    return;
  }
  await api(`/api/sessions/${id}/webhooks`, {
    method: "POST",
    body: { url, events, secret },
  });
}

/**
 * Responde en un chat que ya existe, con su id tal cual (`…@c.us` o `…@lid`).
 *
 * Hace falta además de `enviarTexto`: quien escribe desde un anuncio suele llegar
 * con un identificador privado (`@lid`) en vez de su número, y ese id no se puede
 * reconstruir a partir de un teléfono.
 */
export async function enviarTextoAChat(nombre: string, chatId: string, text: string): Promise<void> {
  const id = await sesionId(nombre);
  await api(`/api/sessions/${id}/messages/send-text`, { method: "POST", body: { chatId, text } });
}

export async function enviarTexto(nombre: string, numero: string, text: string): Promise<void> {
  const id = await sesionId(nombre);
  const chatId = `${numero.replace(/\D/g, "")}@c.us`;
  await api(`/api/sessions/${id}/messages/send-text`, { method: "POST", body: { chatId, text } });
}

/**
 * Manda una imagen con su texto debajo, en un solo mensaje.
 *
 * La imagen viaja por URL, no en base64: el gateway la descarga. Es lo que
 * quiere WhatsApp para que salga como foto con pie y no como archivo adjunto.
 */
export async function enviarImagen(
  nombre: string,
  numero: string,
  imagenUrl: string,
  caption: string,
): Promise<void> {
  const id = await sesionId(nombre);
  const chatId = `${numero.replace(/\D/g, "")}@c.us`;
  await api(`/api/sessions/${id}/messages/send-image`, {
    method: "POST",
    body: { chatId, url: imagenUrl, caption, filename: "motordesk.png" },
  });
}

// Nombre de sesión de un taller a partir de su código (T-0001 → taller-t-0001).
export function sesionTaller(code: string): string {
  return `taller-${code.toLowerCase()}`;
}
