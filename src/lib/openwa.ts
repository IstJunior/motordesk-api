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
export async function reiniciarSesion(nombre: string): Promise<void> {
  const id = await sesionId(nombre);

  // `logout` borra el perfil de navegador de la sesión; es lo que antes había
  // que hacer entrando al servidor con un `rm -rf`. Solo existe desde 0.23 y
  // exige la sesión iniciada: sobre una caída responde 400 y no cambia nada,
  // por eso va primero y su fallo no interrumpe.
  await api(`/api/sessions/${id}/logout`, { method: "POST" }).catch(() => {});
  await api(`/api/sessions/${id}/force-kill`, { method: "POST" }).catch(() => {});
  await api(`/api/sessions/${id}/start`, { method: "POST" }).catch(() => {});
}

/** Estados en los que la sesión está viva y no hay que tocarla. */
const SANOS = new Set(["ready", "authenticating", "qr_ready"]);

/**
 * Arranca la sesión, reiniciándola de raíz si viene atascada.
 *
 * Pulsar "conectar" sobre una sesión en bucle no hacía nada visible, que es
 * justo cuando uno pulsa conectar. Si está sana no se toca: un `force-kill`
 * sobre una sesión conectada la desconectaría y tocaría volver a escanear.
 */
export async function conectarSesion(nombre: string): Promise<void> {
  const { status } = await estadoSesion(nombre).catch(() => ({ status: "desconocido", qr: null }));
  if (SANOS.has(status)) {
    await iniciarSesion(nombre);
    return;
  }
  await reiniciarSesion(nombre);
}

export async function estadoSesion(nombre: string): Promise<{ status: string; qr: string | null }> {
  const id = await sesionId(nombre);
  const s = await api<Sesion>(`/api/sessions/${id}`).catch(() => null);
  const status = s?.status ?? "desconocido";
  let qr: string | null = null;
  if (status === "qr_ready") {
    const q = await api<{ qrCode?: string; qr?: string }>(`/api/sessions/${id}/qr`).catch(() => null);
    qr = q?.qrCode ?? q?.qr ?? null;
  }
  return { status, qr };
}

export async function registrarWebhook(nombre: string, url: string, secret: string): Promise<void> {
  const id = await sesionId(nombre);
  const existentes = await api<Array<{ url: string }>>(`/api/sessions/${id}/webhooks`).catch(() => []);
  const lista = Array.isArray(existentes) ? existentes : [];
  if (lista.some((w) => w.url === url)) return;
  await api(`/api/sessions/${id}/webhooks`, {
    method: "POST",
    body: { url, events: ["message.received"], secret },
  });
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
