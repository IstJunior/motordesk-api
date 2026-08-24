// Respaldo programado, dentro del mismo proceso (sin cron externo, como en
// SmartPOS). Revisa cada 10 min y dispara una vez al día, marcando el día ya
// ejecutado para ser idempotente aunque el contenedor reinicie.
//
// Envs:
//   BACKUP_HORA        hora local Bogotá del respaldo full (default 3)
//   BACKUP_RETENER     cuántos full se conservan (default 14)
//   BACKUP_TALLERES    "1" para respaldar además cada taller activo
//   BACKUP_TALLERES_RETENER  cuántos por taller (default 7)
import { prisma } from "./db.js";
import { r2Configured } from "./r2.js";
import { ejecutarBackupFull, ejecutarBackupTaller, pgDumpDisponible, purgar } from "./backup.js";

const HORA = Number(process.env.BACKUP_HORA ?? 3);
const RETENER = Number(process.env.BACKUP_RETENER ?? 14);
const CON_TALLERES = process.env.BACKUP_TALLERES === "1";
const RETENER_TALLER = Number(process.env.BACKUP_TALLERES_RETENER ?? 7);
const CHEQUEO_MS = 10 * 60_000;

// Día y hora en America/Bogota (el servidor corre en UTC).
function bogota(): { dia: string; hora: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return { dia: `${g("year")}-${g("month")}-${g("day")}`, hora: Number(g("hour")) };
}

// Respalda cada taller vivo, uno a uno. Un fallo no aborta a los demás.
async function respaldarTalleres(): Promise<void> {
  const talleres = await prisma.workshop.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  for (const t of talleres) {
    try {
      const r = await ejecutarBackupTaller(t.id, "programado");
      await purgar(`workshop:${t.id}`, RETENER_TALLER);
      console.log(`Respaldo del taller ${t.name}: ${r.objectKey} (${r.filas} filas)`);
    } catch (e) {
      console.error(`Respaldo del taller ${t.name} falló:`, e instanceof Error ? e.message : e);
    }
  }
}

export async function iniciarBackupProgramado(): Promise<void> {
  if (!r2Configured()) {
    console.warn("R2 sin configurar: respaldo programado deshabilitado.");
    return;
  }
  if (!(await pgDumpDisponible())) {
    console.warn("pg_dump no está en la imagen: el respaldo full programado queda deshabilitado.");
    if (!CON_TALLERES) return;
  }

  // Arranca desde el último día ya respaldado para no repetir tras un reinicio.
  const ultimo = await prisma.backupRecord.findFirst({
    where: { scope: "full", status: "done" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  let ultimoDia = ultimo
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(ultimo.createdAt)
    : "";

  const tick = async () => {
    try {
      const { dia, hora } = bogota();
      if (hora !== HORA || dia === ultimoDia) return;
      ultimoDia = dia;

      if (await pgDumpDisponible()) {
        const r = await ejecutarBackupFull("programado");
        await purgar("full", RETENER);
        console.log(`Respaldo full programado OK: ${r.objectKey} (${r.sizeBytes} bytes)`);
      }
      if (CON_TALLERES) await respaldarTalleres();
    } catch (e) {
      console.error("Respaldo programado falló:", e instanceof Error ? e.message : e);
    }
  };

  setInterval(tick, CHEQUEO_MS).unref();
  void tick();
  console.log(
    `Respaldo programado activo (diario ${HORA}:00 America/Bogota, retiene ${RETENER}` +
      `${CON_TALLERES ? `, talleres incluidos retiene ${RETENER_TALLER}` : ""}).`,
  );
}
