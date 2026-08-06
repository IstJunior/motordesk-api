import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

// Catálogo global de modelos de vehículo (superadmin).
export const vehiculosRoutes = new Hono();
vehiculosRoutes.use("*", superadminGuard);

export const TIPOS_VEHICULO = [
  "car",
  "motorcycle",
  "emoto",
  "suv",
  "truck",
  "pickup",
  "van",
  "atv",
  "electric",
  "escooter",
] as const;

// `vehicle_models.created_by_id` es obligatorio. Con el login por credencial no
// hay usuario de Supabase, así que se atribuye al superadmin de la base.
async function autorId(c: Context): Promise<bigint> {
  const actual = c.get("user");
  if (actual?.id) return actual.id;
  const sa = await prisma.user.findFirst({
    where: { isSuperAdmin: true, deletedAt: null },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (!sa) throw new Error("No hay un usuario superadmin al que atribuir el modelo.");
  return sa.id;
}

async function exigirUnico(type: string, brand: string, model: string, excluir?: bigint) {
  const existe = await prisma.vehicleModel.findFirst({
    where: {
      type,
      brand: { equals: brand, mode: "insensitive" },
      model: { equals: model, mode: "insensitive" },
      ...(excluir ? { NOT: { id: excluir } } : {}),
    },
    select: { id: true },
  });
  if (existe) throw new Error("Esta marca y modelo ya existen para el tipo seleccionado.");
}

vehiculosRoutes.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const type = c.req.query("type") ?? "";
  const models = await prisma.vehicleModel.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(q
        ? {
            OR: [
              { brand: { contains: q, mode: "insensitive" } },
              { model: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ brand: "asc" }, { model: "asc" }, { yearFrom: "asc" }],
    take: 200,
    select: { id: true, type: true, brand: true, model: true, yearFrom: true, yearTo: true, engine: true, isActive: true },
  });
  return c.json(models);
});

vehiculosRoutes.get("/meta/tipos", (c) => c.json({ tipos: TIPOS_VEHICULO }));

const modeloSchema = z.object({
  type: z.enum(TIPOS_VEHICULO),
  brand: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  yearFrom: z.number().int().min(1900).max(2100),
  yearTo: z.number().int().min(1900).max(2100).optional().nullable(),
  engine: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().default(true),
});

const SELECCION = {
  id: true,
  type: true,
  brand: true,
  model: true,
  yearFrom: true,
  yearTo: true,
  engine: true,
  isActive: true,
} as const;

vehiculosRoutes.post("/", async (c) => {
  const parsed = modeloSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const d = parsed.data;
  if (d.yearTo && d.yearTo < d.yearFrom) {
    return c.json({ error: "El año hasta no puede ser menor que el año desde." }, 400);
  }
  try {
    await exigirUnico(d.type, d.brand, d.model);
    const creado = await prisma.vehicleModel.create({
      data: {
        type: d.type,
        brand: d.brand,
        model: d.model,
        yearFrom: d.yearFrom,
        yearTo: d.yearTo ?? null,
        engine: d.engine?.trim() || null,
        isActive: d.isActive,
        createdById: await autorId(c),
      },
      select: SELECCION,
    });
    return c.json(creado, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo crear el modelo" }, 400);
  }
});

vehiculosRoutes.put("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = modeloSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const d = parsed.data;
  if (d.yearTo && d.yearTo < d.yearFrom) {
    return c.json({ error: "El año hasta no puede ser menor que el año desde." }, 400);
  }
  try {
    await exigirUnico(d.type, d.brand, d.model, id);
    const actualizado = await prisma.vehicleModel.update({
      where: { id },
      data: {
        type: d.type,
        brand: d.brand,
        model: d.model,
        yearFrom: d.yearFrom,
        yearTo: d.yearTo ?? null,
        engine: d.engine?.trim() || null,
        isActive: d.isActive,
      },
      select: SELECCION,
    });
    return c.json(actualizado);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo actualizar el modelo" }, 400);
  }
});

// Los vehículos de los clientes referencian el modelo: si está en uso se
// desactiva en lugar de romper la relación.
vehiculosRoutes.delete("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const enUso = await prisma.vehicle.count({ where: { vehicleModelId: id } });
  if (enUso > 0) {
    await prisma.vehicleModel.update({ where: { id }, data: { isActive: false } });
    return c.json({ ok: true, desactivado: true, vehiculos: enUso });
  }
  try {
    await prisma.vehicleModel.delete({ where: { id } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo eliminar" }, 400);
  }
  return c.json({ ok: true, desactivado: false });
});
