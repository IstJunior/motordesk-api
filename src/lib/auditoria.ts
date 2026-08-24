// Rastro de acciones sensibles del control-plane (suspender un taller, cambiar
// módulos, restaurar un respaldo…). Escribe en `activity_log`.
//
// Nunca lanza: auditar es un efecto secundario, no puede tumbar la acción real.
import type { Context, Next } from "hono";
import { prisma } from "./db.js";

export const LOG_NAME = "control-plane";

// Nombre legible de cada acción, por método + ruta normalizada. Lo que no esté
// aquí se audita igual, con el método y la ruta como descripción: preferimos un
// registro pobre a ningún registro.
const ACCIONES: Record<string, string> = {
  "POST /talleres": "Alta de taller",
  "PUT /talleres/:id/modules": "Cambio de módulos del taller",
  "PUT /talleres/:id/status": "Cambio de estado del taller",
  "POST /talleres/:id/suscripcion": "Acción sobre la suscripción",
  "POST /talleres/:id/users": "Alta de usuario del taller",
  "PATCH /talleres/:id/users/:id": "Edición de usuario del taller",
  "PATCH /talleres/:id/users/:id/password": "Cambio de contraseña de un usuario",
  "DELETE /talleres/:id/users/:id": "Baja de usuario del taller",
  "POST /talleres/:id/whatsapp/connect": "Conexión de WhatsApp del taller",
  "PUT /talleres/:id/dian": "Cambio de configuración DIAN",
  "PUT /config": "Cambio de ajustes del sistema",
  "POST /config/ai-providers": "Alta de proveedor de IA",
  "PUT /config/ai-providers/:id": "Edición de proveedor de IA",
  "DELETE /config/ai-providers/:id": "Baja de proveedor de IA",
  "POST /vehiculos": "Alta de modelo de vehículo",
  "PUT /vehiculos/:id": "Edición de modelo de vehículo",
  "DELETE /vehiculos/:id": "Baja de modelo de vehículo",
  "POST /manuales": "Subida de manual técnico",
  "DELETE /manuales": "Borrado de manual técnico",
  "POST /backups/full": "Respaldo completo de la base",
  "DELETE /backups/:id": "Borrado de un respaldo",
  "POST /backups/taller/:id": "Respaldo de un taller",
  "POST /backups/taller/:id/restaurar": "Restauración de un taller",
  "POST /whatsapp/conectar": "Conexión del WhatsApp de leads",
};

export async function auditar(entrada: {
  // Usuario del superadmin (el del token propio o el email de Supabase).
  actor: string | undefined;
  accion: string;
  // Descripción legible; si falta se usa `accion`.
  descripcion?: string;
  tallerId?: bigint;
  detalle?: unknown;
}): Promise<void> {
  try {
    const ahora = new Date();
    await prisma.activityLog.create({
      data: {
        logName: LOG_NAME,
        description: entrada.descripcion ?? entrada.accion,
        event: entrada.accion,
        subjectType: entrada.tallerId ? "Workshop" : null,
        subjectId: entrada.tallerId ?? null,
        causerType: "superadmin",
        properties: {
          actor: entrada.actor ?? "desconocido",
          ...(entrada.detalle && typeof entrada.detalle === "object"
            ? (entrada.detalle as Record<string, unknown>)
            : entrada.detalle !== undefined
              ? { detalle: entrada.detalle }
              : {}),
        },
        createdAt: ahora,
        updatedAt: ahora,
      },
    });
  } catch (e) {
    console.error("No se pudo auditar:", e instanceof Error ? e.message : e);
  }
}

// Sustituye por `:id` los tramos que son identificadores, para agrupar rutas.
function normalizarRuta(ruta: string): string {
  return ruta
    .replace(/^\/api/, "")
    .split("/")
    .map((tramo) =>
      /^\d+$/.test(tramo) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tramo) ? ":id" : tramo,
    )
    .join("/");
}

// Primer tramo numérico de la ruta: en el control-plane siempre es el taller
// (`/talleres/57/...`, `/backups/taller/57`).
function tallerDeRuta(ruta: string): bigint | undefined {
  const m = ruta.match(/\/(?:talleres|taller)\/(\d+)/);
  if (!m) return undefined;
  try {
    return BigInt(m[1]!);
  } catch {
    return undefined;
  }
}

// Middleware: audita toda mutación del control-plane que termine bien.
//
// Va por middleware y no por llamadas sueltas en cada handler porque así ningún
// endpoint nuevo se queda sin rastro por olvido. Los handlers que quieren
// guardar detalle rico (respaldos, alta de taller) llaman además a `auditar()`;
// el middleware detecta esa llamada previa y no duplica.
export async function auditarMutaciones(c: Context, next: Next) {
  const metodo = c.req.method;
  await next();

  if (metodo === "GET" || metodo === "OPTIONS" || metodo === "HEAD") return;
  if (c.res.status >= 400) return;
  // Un handler ya dejó el registro detallado.
  if (c.get("auditado")) return;

  const ruta = normalizarRuta(new URL(c.req.url).pathname);
  const clave = `${metodo} ${ruta}`;
  await auditar({
    actor: c.get("superadmin"),
    accion: clave,
    descripcion: ACCIONES[clave] ?? `${metodo} ${ruta}`,
    tallerId: tallerDeRuta(new URL(c.req.url).pathname),
  });
}

declare module "hono" {
  interface ContextVariableMap {
    // Lo marca un handler que ya auditó con detalle, para no duplicar.
    auditado: boolean;
  }
}
