// Rastro de acciones sensibles del control-plane (suspender un taller, cambiar
// módulos, restaurar un respaldo…). Escribe en `activity_log`, la misma tabla
// que ya usa el monolito, para que el historial quede en un solo sitio.
//
// Nunca lanza: auditar es un efecto secundario, no puede tumbar la acción real.
import { prisma } from "./db.js";

const LOG_NAME = "control-plane";

export async function auditar(entrada: {
  // Usuario del superadmin (el del token propio o el email de Supabase).
  actor: string | undefined;
  accion: string;
  tallerId?: bigint;
  detalle?: unknown;
}): Promise<void> {
  try {
    const ahora = new Date();
    await prisma.activityLog.create({
      data: {
        logName: LOG_NAME,
        description: entrada.accion,
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
