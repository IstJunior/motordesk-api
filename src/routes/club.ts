// El Club del Taller (superadmin): quién se unió desde /club del monolito.
//
// El formulario vive en el monolito, que es el que sirve las páginas públicas;
// aquí solo se leen los registros y se marca en qué va cada uno. Nada de esto
// le manda mensajes a nadie: escribirle a un inscrito es a mano, desde el
// enlace de WhatsApp que arma el panel.
import { Hono } from "hono";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { auditar } from "../lib/auditoria.js";

export const clubRoutes = new Hono();
clubRoutes.use("*", superadminGuard);

const ESTADOS = ["nuevo", "contactado", "cliente", "descartado"] as const;
const ROLES = ["mecanico", "dueno"] as const;
const LIMITE_MAX = 200;

function filtros(c: { req: { query: (k: string) => string | undefined } }): Prisma.ClubRegistroWhereInput {
  const where: Prisma.ClubRegistroWhereInput = {};
  const rol = c.req.query("rol");
  if (rol && (ROLES as readonly string[]).includes(rol)) where.rol = rol;
  const estado = c.req.query("estado");
  if (estado && (ESTADOS as readonly string[]).includes(estado)) where.estado = estado;
  const origen = c.req.query("origen");
  if (origen) where.origen = origen;
  const q = c.req.query("q")?.trim();
  if (q) {
    const digitos = q.replace(/\D/g, "");
    where.OR = [
      { nombre: { contains: q, mode: "insensitive" } },
      { ciudad: { contains: q, mode: "insensitive" } },
      ...(digitos.length >= 3 ? [{ telefono: { contains: digitos } }] : []),
    ];
  }
  return where;
}

// GET /club — registros paginados y el resumen para medir qué contenido trae gente.
//   ?rol=mecanico &estado=nuevo &origen=reel-aceite &q=carlos &pagina=0 &limite=50
clubRoutes.get("/", async (c) => {
  const where = filtros(c);
  const limite = Math.min(Math.max(Number(c.req.query("limite") ?? 50) || 50, 1), LIMITE_MAX);
  const pagina = Math.max(Number(c.req.query("pagina") ?? 0) || 0, 0);
  const haceUnaSemana = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  const [total, filas, porRol, porEstado, porOrigen, semana] = await Promise.all([
    prisma.clubRegistro.count({ where }),
    prisma.clubRegistro.findMany({ where, orderBy: { creadoEn: "desc" }, skip: pagina * limite, take: limite }),
    prisma.clubRegistro.groupBy({ by: ["rol"], _count: { _all: true } }),
    prisma.clubRegistro.groupBy({ by: ["estado"], _count: { _all: true } }),
    prisma.clubRegistro.groupBy({ by: ["origen"], _count: { _all: true }, orderBy: { _count: { origen: "desc" } }, take: 10 }),
    prisma.clubRegistro.count({ where: { creadoEn: { gte: haceUnaSemana } } }),
  ]);

  // Quién ya escribió al WhatsApp de MotorDesk: tiene conversación en la bandeja.
  // En la bandeja el teléfono va igual, solo dígitos con indicativo.
  const telefonos = filas.map((f) => f.telefono);
  const conChat = telefonos.length
    ? await prisma.chatSession.findMany({
        where: {
          canal: "whatsapp",
          OR: [{ phone: { in: telefonos } }, ...telefonos.map((t) => ({ whatsappChatId: { startsWith: `${t}@` } }))],
        },
        select: { phone: true, whatsappChatId: true },
      })
    : [];
  const escribieron = new Set(
    conChat.flatMap((s) => [s.phone, s.whatsappChatId?.split("@")[0]].filter((v): v is string => !!v)),
  );

  const cuenta = (lista: { _count: { _all: number } }[], clave: string, valor: string) =>
    lista.find((x) => (x as Record<string, unknown>)[clave] === valor)?._count._all ?? 0;

  return c.json({
    total,
    registros: filas.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      telefono: f.telefono,
      rol: f.rol,
      marcas: f.marcas,
      ciudad: f.ciudad,
      origen: f.origen,
      ficha: f.ficha,
      estado: f.estado,
      envios: f.envios,
      creadoEn: f.creadoEn,
      actualizadoEn: f.actualizadoEn,
      contactadoEn: f.contactadoEn,
      escribio: escribieron.has(f.telefono),
    })),
    resumen: {
      total: porRol.reduce((n, r) => n + r._count._all, 0),
      mecanicos: cuenta(porRol, "rol", "mecanico"),
      duenos: cuenta(porRol, "rol", "dueno"),
      ultimaSemana: semana,
      porEstado: Object.fromEntries(ESTADOS.map((e) => [e, cuenta(porEstado, "estado", e)])),
      porOrigen: porOrigen.map((o) => ({ origen: o.origen, total: o._count._all })),
    },
  });
});

// PATCH /club/:id — en qué va: nuevo, contactado, cliente o descartado.
clubRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: "Registro inválido" }, 400);
  const parsed = z.object({ estado: z.enum(ESTADOS) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Estado inválido" }, 400);

  const actual = await prisma.clubRegistro.findUnique({
    where: { id: BigInt(id) },
    select: { contactadoEn: true, estado: true, nombre: true },
  });
  if (!actual) return c.json({ error: "No encontrado" }, 404);

  const { estado } = parsed.data;
  // La primera vez que se le escribió queda: volver a "nuevo" no la borra.
  const contactadoEn = actual.contactadoEn ?? (estado === "nuevo" ? null : new Date());
  const fila = await prisma.clubRegistro.update({
    where: { id: BigInt(id) },
    data: { estado, contactadoEn },
    select: { id: true, estado: true, contactadoEn: true },
  });
  await auditar({
    actor: c.get("superadmin"),
    accion: "PATCH /club/:id",
    descripcion: `Club del Taller: ${actual.nombre} pasó de «${actual.estado}» a «${estado}»`,
    detalle: { registro: id, antes: actual.estado, despues: estado },
  });
  c.set("auditado", true);
  return c.json(fila);
});
