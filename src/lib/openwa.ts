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

// Nombre de sesión de un taller a partir de su código (T-0001 → taller-t-0001).
export function sesionTaller(code: string): string {
  return `taller-${code.toLowerCase()}`;
}
