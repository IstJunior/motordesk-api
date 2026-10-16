// Cupo de facturación electrónica: bolsas, modo de cada taller y los años que
// pagan (paquetes).
//
// Cada taller gasta sus documentos de un sitio, y el proveedor lo elige con un
// interruptor por taller:
//
//   individual  paquete anual propio en el proveedor (lo que se compra hoy)
//   bolsa       documentos repartidos de una bolsa multifacturador
//
// En los dos modos el taller tiene un paquete en MotorDesk —lo que pagó: tantos
// documentos durante doce meses— y el monolito corta la emisión cuando se
// acaba. Cambiar de modo no toca credenciales: en el proveedor cada NIT tiene
// las suyas en los dos casos.

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { activableDesde, deIso, hoyEnBogota, iso } from "../lib/dias-habiles.js";
import { cupoDeTaller, estadoDePaquete, MODALIDADES, resumenDeBolsas, sumarMeses } from "../lib/cupo-facturacion.js";

export const facturacionRoutes = new Hono<{ Variables: { superadmin: string } }>();
facturacionRoutes.use("*", superadminGuard);

/** Los niveles que se publican en la landing. Igual que PLANES_FACTURACION del monolito. */
export const NIVELES = [
  { code: "fe-basico", nombre: "Básico", documentos: 400, precioAnual: 290_000 },
  { code: "fe-estandar", nombre: "Estándar", documentos: 2_500, precioAnual: 390_000 },
  { code: "fe-alto", nombre: "Alto", documentos: 5_000, precioAnual: 450_000 },
] as const;

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");

function primerError(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return "Datos inválidos";
  return i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message;
}

function idDe(texto: string | undefined): bigint | null {
  try {
    return texto && /^\d+$/.test(texto) ? BigInt(texto) : null;
  } catch {
    return null;
  }
}

const fechaLegible = (d: Date) =>
  d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Una línea más al final de las notas, con fecha: el historial del paquete. */
function anotar(previas: string | null, linea: string): string {
  const hoy = iso(hoyEnBogota());
  return [previas, `${hoy}: ${linea}`].filter(Boolean).join("\n");
}

// GET /facturacion — niveles, bolsas y el cupo de cada taller con el módulo.
facturacionRoutes.get("/", async (c) => {
  const ahora = new Date();
  const talleres = await prisma.workshop.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, enabledModules: true },
    orderBy: { name: "asc" },
  });
  const conModulo = talleres.filter((t) => {
    const m = t.enabledModules as Record<string, unknown> | null;
    return Boolean(m && m.facturacion_electronica);
  });

  const bolsas = resumenDeBolsas(ahora);
  const filas = await Promise.all(
    conModulo.map(async (t) => {
      const cupo = await cupoDeTaller(t.id, ahora);
      const vigente = cupo.paquetes.find((p) => p.id === cupo.vigente) ?? null;
      const porActivar = cupo.paquetes.find((p) => p.estado === "por_activar") ?? null;
      return {
        id: String(t.id),
        nombre: t.name,
        modalidad: cupo.modalidad,
        bolsaId: cupo.bolsaId,
        produccion: cupo.produccion,
        documentos: vigente?.documentos ?? null,
        usados: cupo.usados.total,
        venceEl: vigente?.venceEl ?? null,
        porActivarDesde: porActivar?.activableDesde ?? null,
      };
    }),
  );

  return c.json({ niveles: NIVELES, bolsas: await bolsas, talleres: filas });
});

// ─── Bolsas ───

const bolsaSchema = z.object({
  nombre: z.string().trim().min(1, "Ponle un nombre a la bolsa").max(120),
  documentos: z.number().int().positive("Los documentos tienen que ser más de cero"),
  precio: z.number().nonnegative().nullable().optional(),
  compradaEl: fechaIso,
  /** Si no llega, un año desde la compra menos un día. */
  venceEl: fechaIso.optional(),
  notas: z.string().trim().max(2000).nullable().optional(),
});

facturacionRoutes.post("/bolsas", async (c) => {
  const parsed = bolsaSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;
  const comprada = deIso(d.compradaEl);
  // "Cada bolsa dura 1 año a partir de la fecha de compra."
  const vence = d.venceEl ? deIso(d.venceEl) : new Date(sumarMeses(comprada, 12).getTime() - 24 * 60 * 60 * 1000);
  if (vence <= comprada) return c.json({ error: "La bolsa tiene que vencer después de la compra." }, 400);

  const bolsa = await prisma.bolsaDeFacturacion.create({
    data: {
      nombre: d.nombre,
      documentos: d.documentos,
      precio: d.precio ?? null,
      compradaEl: comprada,
      venceEl: vence,
      notas: d.notas ?? null,
    },
  });
  return c.json({ id: String(bolsa.id) }, 201);
});

facturacionRoutes.patch("/bolsas/:bolsaId", async (c) => {
  const id = idDe(c.req.param("bolsaId"));
  if (!id) return c.json({ error: "Bolsa inválida" }, 400);
  const parsed = bolsaSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;
  const actual = await prisma.bolsaDeFacturacion.findUnique({ where: { id } });
  if (!actual) return c.json({ error: "Bolsa no encontrada" }, 404);

  const comprada = d.compradaEl ? deIso(d.compradaEl) : actual.compradaEl;
  const vence = d.venceEl ? deIso(d.venceEl) : actual.venceEl;
  if (vence <= comprada) return c.json({ error: "La bolsa tiene que vencer después de la compra." }, 400);

  await prisma.bolsaDeFacturacion.update({
    where: { id },
    data: {
      ...(d.nombre !== undefined ? { nombre: d.nombre } : {}),
      ...(d.documentos !== undefined ? { documentos: d.documentos } : {}),
      ...(d.precio !== undefined ? { precio: d.precio } : {}),
      ...(d.notas !== undefined ? { notas: d.notas } : {}),
      compradaEl: comprada,
      venceEl: vence,
    },
  });
  return c.json({ ok: true });
});

// ─── Cupo de un taller ───

async function tallerExiste(id: bigint) {
  return prisma.workshop.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } });
}

facturacionRoutes.get("/talleres/:id", async (c) => {
  const id = idDe(c.req.param("id"));
  if (!id || !(await tallerExiste(id))) return c.json({ error: "Taller no encontrado" }, 404);
  const [cupo, bolsas] = await Promise.all([cupoDeTaller(id), resumenDeBolsas()]);
  return c.json({ ...cupo, niveles: NIVELES, bolsas });
});

const modalidadSchema = z.discriminatedUnion("modalidad", [
  z.object({ modalidad: z.literal("individual") }),
  z.object({ modalidad: z.literal("bolsa"), bolsaId: z.string().regex(/^\d+$/, "Elige la bolsa") }),
]);

// PUT /facturacion/talleres/:id/modalidad — el interruptor.
facturacionRoutes.put("/talleres/:id/modalidad", async (c) => {
  const id = idDe(c.req.param("id"));
  if (!id || !(await tallerExiste(id))) return c.json({ error: "Taller no encontrado" }, 404);
  const cuerpo = await c.req.json().catch(() => null);
  const parsed = modalidadSchema.safeParse(cuerpo);
  if (!parsed.success) {
    return c.json(
      { error: MODALIDADES.includes(cuerpo?.modalidad) ? primerError(parsed.error) : "Modalidad inválida" },
      400,
    );
  }
  const d = parsed.data;

  let aviso: string | null = null;
  let bolsaId: bigint | null = null;
  if (d.modalidad === "bolsa") {
    bolsaId = BigInt(d.bolsaId);
    const bolsa = (await resumenDeBolsas()).find((b) => b.id === d.bolsaId);
    if (!bolsa) return c.json({ error: "Bolsa no encontrada" }, 404);
    if (bolsa.vencida) return c.json({ error: `La bolsa «${bolsa.nombre}» ya venció.` }, 400);

    // Lo que este taller va a sumar a lo repartido, si no estaba ya en ella.
    const cupo = await cupoDeTaller(id);
    const yaEnEsta = cupo.modalidad === "bolsa" && cupo.bolsaId === d.bolsaId;
    const suyo = cupo.paquetes
      .filter((p) => p.estado === "activo" || p.estado === "por_activar")
      .reduce((s, p) => s + p.documentos, 0);
    const repartido = bolsa.repartido + (yaEnEsta ? 0 : suyo);
    if (repartido > bolsa.documentos) {
      // No se bloquea: el proveedor no corta por taller y no todos gastan su
      // paquete completo. Pero se dice, porque es prometer más de lo comprado.
      aviso =
        `Con este taller, la bolsa «${bolsa.nombre}» tiene repartidos ${repartido.toLocaleString("es-CO")} ` +
        `documentos de ${bolsa.documentos.toLocaleString("es-CO")}.`;
    }
    const venceBolsa = deIso(bolsa.venceEl);
    const vigente = cupo.paquetes.find((p) => p.id === cupo.vigente);
    if (vigente?.venceEl && new Date(vigente.venceEl) > new Date(venceBolsa.getTime() + 24 * 60 * 60 * 1000)) {
      aviso = [
        aviso,
        `El año del taller vence después que la bolsa (${fechaLegible(venceBolsa)}): antes de esa fecha hay que pasarlo a otra.`,
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  // El taller puede no tener todavía configuración DIAN: se crea con los
  // valores por defecto, que no habilitan nada.
  await prisma.workshopDianConfig.upsert({
    where: { workshopId: id },
    create: { workshopId: id, cupoModalidad: d.modalidad, cupoBolsaId: bolsaId },
    update: { cupoModalidad: d.modalidad, cupoBolsaId: bolsaId },
  });
  return c.json({ ok: true, aviso });
});

const paqueteSchema = z
  .object({
    nivel: z.string().trim().max(32).nullable().optional(),
    documentos: z.number().int().positive().optional(),
    precio: z.number().nonnegative().nullable().optional(),
    pagadoEl: fechaIso,
    notas: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((d) => d.nivel || d.documentos, { message: "Elige un nivel o escribe los documentos" });

// POST /facturacion/talleres/:id/paquetes — registra un año pagado.
facturacionRoutes.post("/talleres/:id/paquetes", async (c) => {
  const id = idDe(c.req.param("id"));
  if (!id || !(await tallerExiste(id))) return c.json({ error: "Taller no encontrado" }, 404);
  const parsed = paqueteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;

  const nivel = d.nivel ? NIVELES.find((n) => n.code === d.nivel) : null;
  if (d.nivel && !nivel) return c.json({ error: "Nivel desconocido" }, 400);
  const documentos = d.documentos ?? nivel!.documentos;
  const pagado = deIso(d.pagadoEl);
  if (pagado > hoyEnBogota()) return c.json({ error: "La fecha de pago no puede ser futura." }, 400);

  // Uno por activar a la vez: dos pagos sin activar son casi siempre un doble
  // registro del mismo pago.
  const pendiente = await prisma.paqueteDeFacturacion.findFirst({
    where: { workshopId: id, anuladoEl: null, activadoEl: null },
    select: { id: true },
  });
  if (pendiente) {
    return c.json({ error: "Este taller ya tiene un paquete pagado sin activar. Actívalo o anúlalo primero." }, 409);
  }

  const desde = activableDesde(pagado);
  const paquete = await prisma.paqueteDeFacturacion.create({
    data: {
      workshopId: id,
      nivel: nivel?.code ?? null,
      documentos,
      precio: d.precio ?? nivel?.precioAnual ?? null,
      pagadoEl: pagado,
      activableDesde: desde,
      notas: d.notas ?? null,
    },
  });
  return c.json({ id: String(paquete.id), activableDesde: iso(desde) }, 201);
});

async function paqueteDe(c: { req: { param: (k: string) => string | undefined } }) {
  const id = idDe(c.req.param("id"));
  const pid = idDe(c.req.param("paqueteId"));
  if (!id || !pid) return null;
  return prisma.paqueteDeFacturacion.findFirst({ where: { id: pid, workshopId: id } });
}

// POST /facturacion/talleres/:id/paquetes/:paqueteId/activar
//
// Arranca los doce meses. Si el taller tiene un año en curso, este empieza
// cuando aquel termina: renovar antes de tiempo no le quita días.
facturacionRoutes.post("/talleres/:id/paquetes/:paqueteId/activar", async (c) => {
  const p = await paqueteDe(c);
  if (!p) return c.json({ error: "Paquete no encontrado" }, 404);
  if (p.anuladoEl) return c.json({ error: "El paquete está anulado." }, 409);
  if (p.activadoEl) return c.json({ error: "El paquete ya está activado." }, 409);

  const hoy = hoyEnBogota();
  if (hoy < p.activableDesde) {
    return c.json(
      {
        error:
          `Todavía corre el plazo de retracto: se puede activar desde el ${fechaLegible(p.activableDesde)}. ` +
          "Activarlo antes es comprar en el proveedor un paquete que el taller aún puede devolver.",
      },
      409,
    );
  }

  const ahora = new Date();
  const enCurso = await prisma.paqueteDeFacturacion.findFirst({
    where: { workshopId: p.workshopId, anuladoEl: null, activadoEl: { lte: ahora }, venceEl: { gt: ahora } },
    orderBy: { venceEl: "desc" },
  });
  const inicio = enCurso?.venceEl ?? ahora;
  const vence = sumarMeses(inicio, 12);

  await prisma.paqueteDeFacturacion.update({
    where: { id: p.id },
    data: {
      activadoEl: inicio,
      venceEl: vence,
      notas: anotar(p.notas, enCurso ? `activado; empieza al vencer el año en curso` : "activado"),
    },
  });
  return c.json({ ok: true, activadoEl: inicio.toISOString(), venceEl: vence.toISOString() });
});

const ampliarSchema = z.object({
  documentos: z.number().int().positive(),
  nivel: z.string().trim().max(32).nullable().optional(),
  pagoAdicional: z.number().nonnegative().nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
});

// POST /facturacion/talleres/:id/paquetes/:paqueteId/ampliar — pasar a un
// nivel mayor sin mover las fechas: la diferencia se paga, el año sigue igual.
facturacionRoutes.post("/talleres/:id/paquetes/:paqueteId/ampliar", async (c) => {
  const p = await paqueteDe(c);
  if (!p) return c.json({ error: "Paquete no encontrado" }, 404);
  const parsed = ampliarSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;

  const estado = estadoDePaquete(p);
  if (estado !== "activo" && estado !== "por_activar") {
    return c.json({ error: "Solo se amplía un paquete activo o por activar." }, 409);
  }
  if (d.documentos <= p.documentos) {
    return c.json({ error: `Ampliar es subir de ${p.documentos.toLocaleString("es-CO")} documentos.` }, 400);
  }
  const nivel = d.nivel ? NIVELES.find((n) => n.code === d.nivel) : null;
  if (d.nivel && !nivel) return c.json({ error: "Nivel desconocido" }, 400);

  const precio = p.precio === null && !d.pagoAdicional ? null : Number(p.precio ?? 0) + (d.pagoAdicional ?? 0);
  await prisma.paqueteDeFacturacion.update({
    where: { id: p.id },
    data: {
      documentos: d.documentos,
      nivel: nivel?.code ?? p.nivel,
      precio,
      notas: anotar(
        p.notas,
        `ampliado de ${p.documentos.toLocaleString("es-CO")} a ${d.documentos.toLocaleString("es-CO")} documentos` +
          (d.pagoAdicional ? ` (pagó $${d.pagoAdicional.toLocaleString("es-CO")} más)` : "") +
          (d.notas ? ` — ${d.notas}` : ""),
      ),
    },
  });
  return c.json({ ok: true });
});

const anularSchema = z.object({ motivo: z.string().trim().min(3, "Escribe el motivo").max(500) });

// POST /facturacion/talleres/:id/paquetes/:paqueteId/anular — retracto,
// devolución o un registro equivocado. No se borra: queda el rastro.
facturacionRoutes.post("/talleres/:id/paquetes/:paqueteId/anular", async (c) => {
  const p = await paqueteDe(c);
  if (!p) return c.json({ error: "Paquete no encontrado" }, 404);
  if (p.anuladoEl) return c.json({ error: "El paquete ya está anulado." }, 409);
  const parsed = anularSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);

  await prisma.paqueteDeFacturacion.update({
    where: { id: p.id },
    data: { anuladoEl: new Date(), notas: anotar(p.notas, `anulado — ${parsed.data.motivo}`) },
  });
  return c.json({ ok: true });
});
