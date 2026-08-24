// Respaldos (superadmin). Full de la base y export/restauración por taller.
import { Hono } from "hono";
import { z } from "zod";
import { Readable } from "node:stream";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { r2Configured, getR2Stream, deleteR2Object } from "../lib/r2.js";
import {
  ejecutarBackupFull,
  ejecutarBackupTaller,
  leerExportTaller,
  pgDumpDisponible,
  purgar,
  restaurarTaller,
} from "../lib/backup.js";
import { TABLAS_TALLER } from "../lib/backup-scope.js";
import { auditar } from "../lib/auditoria.js";

export const backupsRoutes = new Hono();
backupsRoutes.use("*", superadminGuard);

const RETENER = Number(process.env.BACKUP_RETENER ?? 14);
const RETENER_TALLER = Number(process.env.BACKUP_TALLERES_RETENER ?? 7);

type Registro = {
  id: string;
  scope: string;
  status: string;
  objectKey: string;
  sizeBytes: bigint | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

function serializar(r: Registro) {
  return {
    id: r.id,
    scope: r.scope,
    workshopId: r.scope.startsWith("workshop:") ? r.scope.slice("workshop:".length) : null,
    status: r.status,
    objectKey: r.objectKey,
    sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
    failureReason: r.failureReason,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

// GET /backups/estado — qué se puede hacer hoy en este entorno.
backupsRoutes.get("/estado", async (c) =>
  c.json({
    r2: r2Configured(),
    pgDump: await pgDumpDisponible(),
    programado: {
      hora: Number(process.env.BACKUP_HORA ?? 3),
      zona: "America/Bogota",
      retener: RETENER,
      talleres: process.env.BACKUP_TALLERES === "1",
      retenerTaller: RETENER_TALLER,
    },
    tablasPorTaller: TABLAS_TALLER.length,
  }),
);

// GET /backups — historial. `?scope=full` o `?scope=workshop:12`.
backupsRoutes.get("/", async (c) => {
  const scope = c.req.query("scope");
  const limite = Math.min(Number(c.req.query("limite") ?? 50), 200);
  const registros = await prisma.backupRecord.findMany({
    where: scope ? { scope } : undefined,
    orderBy: { createdAt: "desc" },
    take: limite,
  });
  return c.json(registros.map(serializar));
});

// POST /backups/full — dump completo ahora mismo.
backupsRoutes.post("/full", async (c) => {
  if (!r2Configured()) return c.json({ error: "R2 no está configurado" }, 400);
  if (!(await pgDumpDisponible())) {
    return c.json({ error: "pg_dump no está disponible en el servidor" }, 400);
  }
  try {
    const r = await ejecutarBackupFull("manual");
    const purgados = await purgar("full", RETENER);
    await auditar({ actor: c.get("superadmin"), accion: "backup.full", detalle: { key: r.objectKey } });
    return c.json({ ...r, purgados });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "El respaldo falló" }, 500);
  }
});

// GET /backups/:id/descargar — reenvía el objeto de R2 al navegador.
backupsRoutes.get("/:id/descargar", async (c) => {
  const registro = await prisma.backupRecord.findUnique({ where: { id: c.req.param("id") } });
  if (!registro) return c.json({ error: "Respaldo no encontrado" }, 404);
  if (registro.status !== "done") return c.json({ error: "El respaldo no se completó" }, 400);

  try {
    const { body, size } = await getR2Stream(registro.objectKey);
    const nombre = registro.objectKey.split("/").pop() ?? "backup";
    return new Response(Readable.toWeb(body) as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${nombre}"`,
        ...(size ? { "Content-Length": String(size) } : {}),
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo descargar" }, 500);
  }
});

// DELETE /backups/:id — borra el objeto en R2 y su registro.
backupsRoutes.delete("/:id", async (c) => {
  const registro = await prisma.backupRecord.findUnique({ where: { id: c.req.param("id") } });
  if (!registro) return c.json({ error: "Respaldo no encontrado" }, 404);
  await deleteR2Object(registro.objectKey).catch(() => {});
  await prisma.backupRecord.delete({ where: { id: registro.id } });
  await auditar({
    actor: c.get("superadmin"),
    accion: "backup.eliminar",
    detalle: { key: registro.objectKey },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Por taller
// ---------------------------------------------------------------------------

async function tallerDe(idTexto: string) {
  const id = Number.isFinite(Number(idTexto)) ? BigInt(idTexto) : null;
  if (id === null) return null;
  return prisma.workshop.findUnique({ where: { id }, select: { id: true, code: true, name: true } });
}

// GET /backups/taller/:id — historial de ese taller.
backupsRoutes.get("/taller/:id", async (c) => {
  const taller = await tallerDe(c.req.param("id"));
  if (!taller) return c.json({ error: "Taller no encontrado" }, 404);
  const registros = await prisma.backupRecord.findMany({
    where: { scope: `workshop:${taller.id}` },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return c.json(registros.map(serializar));
});

// POST /backups/taller/:id — export lógico del taller.
backupsRoutes.post("/taller/:id", async (c) => {
  if (!r2Configured()) return c.json({ error: "R2 no está configurado" }, 400);
  const taller = await tallerDe(c.req.param("id"));
  if (!taller) return c.json({ error: "Taller no encontrado" }, 404);
  try {
    const r = await ejecutarBackupTaller(taller.id, "manual");
    const purgados = await purgar(`workshop:${taller.id}`, RETENER_TALLER);
    await auditar({
      actor: c.get("superadmin"),
      accion: "backup.taller",
      tallerId: taller.id,
      detalle: { key: r.objectKey, filas: r.filas },
    });
    return c.json({ ...r, purgados });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "El respaldo falló" }, 500);
  }
});

const cuerpoRestore = z.object({
  backupId: z.string().uuid(),
  // Debe coincidir con el código del taller (o su id si no tiene código).
  // No se pide en el ensayo, que no escribe nada.
  confirmar: z.string().optional(),
  ensayo: z.boolean().optional(),
});

// POST /backups/taller/:id/restaurar — reemplaza todos los datos del taller por
// los del respaldo indicado.
//   { ensayo: true }  simula la restauración y deshace la transacción.
//   { confirmar: "<código del taller>" }  la ejecuta de verdad (DESTRUCTIVO).
backupsRoutes.post("/taller/:id/restaurar", async (c) => {
  const taller = await tallerDe(c.req.param("id"));
  if (!taller) return c.json({ error: "Taller no encontrado" }, 404);

  const parseo = cuerpoRestore.safeParse(await c.req.json().catch(() => ({})));
  if (!parseo.success) return c.json({ error: "Datos inválidos" }, 400);
  const ensayo = parseo.data.ensayo === true;

  const esperado = taller.code ?? String(taller.id);
  if (!ensayo && parseo.data.confirmar?.trim() !== esperado) {
    return c.json({ error: `Para confirmar, escribe el código del taller: ${esperado}` }, 400);
  }

  const registro = await prisma.backupRecord.findUnique({ where: { id: parseo.data.backupId } });
  if (!registro) return c.json({ error: "Respaldo no encontrado" }, 404);
  if (registro.scope !== `workshop:${taller.id}`) {
    return c.json({ error: "Ese respaldo no pertenece a este taller" }, 400);
  }
  if (registro.status !== "done") return c.json({ error: "El respaldo no se completó" }, 400);

  try {
    const datos = await leerExportTaller(registro.objectKey);
    const resultado = await restaurarTaller(taller.id, datos, { ensayo });
    if (!ensayo) {
      await auditar({
        actor: c.get("superadmin"),
        accion: "backup.restaurar",
        tallerId: taller.id,
        detalle: { key: registro.objectKey, generadoEn: datos.generadoEn },
      });
    }
    const insertadas = resultado.tablas.reduce((n, t) => n + t.insertadas, 0);
    const borradas = resultado.tablas.reduce((n, t) => n + t.borradas, 0);
    return c.json({ ok: true, ensayo, insertadas, borradas, detalle: resultado });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "La restauración falló" }, 500);
  }
});
