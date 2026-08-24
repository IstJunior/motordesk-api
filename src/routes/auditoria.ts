// Visor de auditoría (superadmin): lee `activity_log`.
//
// Convive con dos formatos de fila. Las que escribe este control-plane guardan
// el actor en `properties.actor` (el superadmin no es una fila de `users`), y
// las del superadmin viejo del monolito lo guardan en `causer_id` apuntando a
// `users`. El visor resuelve ambos para que el historial se lea entero.
import { Hono } from "hono";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

export const auditoriaRoutes = new Hono();
auditoriaRoutes.use("*", superadminGuard);

const LIMITE_MAX = 200;

function fecha(valor: string | undefined): Date | undefined {
  if (!valor) return undefined;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function filtros(c: {
  req: { query: (k: string) => string | undefined };
}): Prisma.ActivityLogWhereInput {
  const where: Prisma.ActivityLogWhereInput = {};

  const taller = c.req.query("taller");
  if (taller && /^\d+$/.test(taller)) {
    where.subjectType = "Workshop";
    where.subjectId = BigInt(taller);
  }

  const accion = c.req.query("accion");
  if (accion) where.event = accion;

  const desde = fecha(c.req.query("desde"));
  const hasta = fecha(c.req.query("hasta"));
  if (desde || hasta) {
    where.createdAt = {
      ...(desde ? { gte: desde } : {}),
      // `hasta` se interpreta como el día completo.
      ...(hasta ? { lte: new Date(hasta.getTime() + 24 * 60 * 60_000 - 1) } : {}),
    };
  }

  const texto = c.req.query("q");
  if (texto) where.description = { contains: texto, mode: "insensitive" };

  return where;
}

// GET /auditoria — historial paginado.
//   ?taller=57 &accion=backup.taller &desde=2026-08-01 &hasta=2026-08-24
//   ?q=respaldo &limite=50 &pagina=0
auditoriaRoutes.get("/", async (c) => {
  const where = filtros(c);
  const limite = Math.min(Math.max(Number(c.req.query("limite") ?? 50), 1), LIMITE_MAX);
  const pagina = Math.max(Number(c.req.query("pagina") ?? 0), 0);

  const [total, filas] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: { id: "desc" },
      skip: pagina * limite,
      take: limite,
    }),
  ]);

  // Resuelve nombres en lote: un findMany por tabla, no uno por fila.
  const tallerIds = [
    ...new Set(
      filas
        .filter((f) => f.subjectType === "Workshop" && f.subjectId !== null)
        .map((f) => f.subjectId!),
    ),
  ];
  const causerIds = [...new Set(filas.filter((f) => f.causerId !== null).map((f) => f.causerId!))];

  const [talleres, usuarios] = await Promise.all([
    tallerIds.length
      ? prisma.workshop.findMany({
          where: { id: { in: tallerIds } },
          select: { id: true, name: true, code: true },
        })
      : [],
    causerIds.length
      ? prisma.user.findMany({
          where: { id: { in: causerIds } },
          select: { id: true, name: true, email: true },
        })
      : [],
  ]);
  const porTaller = new Map(talleres.map((t) => [t.id.toString(), t]));
  const porUsuario = new Map(usuarios.map((u) => [u.id.toString(), u]));

  const entradas = filas.map((f) => {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const usuario = f.causerId ? porUsuario.get(f.causerId.toString()) : undefined;
    const taller =
      f.subjectType === "Workshop" && f.subjectId
        ? porTaller.get(f.subjectId.toString())
        : undefined;

    // `actor` de las filas nuevas; el correo del causer en las viejas.
    const actor =
      (typeof props.actor === "string" && props.actor) ||
      usuario?.email ||
      (f.causerType === "System" ? "sistema" : null);

    // El resto de `properties` es el detalle propio de cada acción.
    const { actor: _descartado, ...detalle } = props;

    return {
      id: f.id.toString(),
      origen: f.logName,
      accion: f.event,
      descripcion: f.description,
      actor,
      taller: taller ? { id: taller.id.toString(), name: taller.name, code: taller.code } : null,
      sujeto: f.subjectType,
      detalle: Object.keys(detalle).length > 0 ? detalle : null,
      createdAt: f.createdAt,
    };
  });

  return c.json({ total, pagina, limite, entradas });
});

// GET /auditoria/meta — valores para poblar los filtros.
auditoriaRoutes.get("/meta", async (c) => {
  const acciones = await prisma.activityLog.groupBy({
    by: ["event", "description"],
    _count: { _all: true },
  });

  // Agrupa por acción quedándose con la primera descripción legible que aparezca.
  const porAccion = new Map<string, { accion: string; descripcion: string; total: number }>();
  for (const a of acciones) {
    if (!a.event) continue;
    const previo = porAccion.get(a.event);
    porAccion.set(a.event, {
      accion: a.event,
      descripcion: previo?.descripcion ?? a.description,
      total: (previo?.total ?? 0) + a._count._all,
    });
  }

  return c.json({
    acciones: [...porAccion.values()].sort((a, b) => b.total - a.total),
  });
});
