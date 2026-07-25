import { Hono } from "hono";
import { z } from "zod";
import {
  requireActiveWorkshop,
  requireWorkshop,
  requireWorkshopRole,
} from "../auth/workshop.js";
import { prisma } from "../lib/db.js";

export const tenantServicesRoutes = new Hono();
tenantServicesRoutes.use("*", requireWorkshop);
tenantServicesRoutes.use("*", requireActiveWorkshop);

const managers = requireWorkshopRole("workshop_admin", "workshop_manager", "workshop_receptionist");
const price = z.coerce.number().min(0).max(999_999_999).default(0);
const serviceSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(10_000).nullable().optional(),
  durationMinutes: z.coerce.number().int().min(1).max(1_440).default(60),
  priceCar: price,
  priceMotorcycle: price,
  priceSuv: price,
  priceTruck: price,
  pricePickup: price,
  priceVan: price,
  priceAtv: price,
  priceElectric: price,
  priceEscooter: price,
  isActive: z.boolean().default(true),
});

function serviceId(raw: string | undefined): bigint | null {
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

function serviceData(input: z.infer<typeof serviceSchema>) {
  return {
    name: input.name,
    description: input.description || null,
    durationMinutes: input.durationMinutes,
    priceCar: input.priceCar,
    priceMotorcycle: input.priceMotorcycle,
    priceSuv: input.priceSuv,
    priceTruck: input.priceTruck,
    pricePickup: input.pricePickup,
    priceVan: input.priceVan,
    priceAtv: input.priceAtv,
    priceElectric: input.priceElectric,
    priceEscooter: input.priceEscooter,
    isActive: input.isActive,
  };
}

tenantServicesRoutes.get("/", async (c) => {
  const workshop = c.get("workshop");
  const services = await prisma.service.findMany({
    where: { workshopId: workshop.id, deletedAt: null },
    orderBy: { name: "asc" },
  });
  return c.json(services);
});

tenantServicesRoutes.get("/:id", async (c) => {
  const workshop = c.get("workshop");
  const id = serviceId(c.req.param("id"));
  if (!id) return c.json({ error: "Servicio inválido" }, 400);
  const service = await prisma.service.findFirst({
    where: { id, workshopId: workshop.id, deletedAt: null },
  });
  if (!service) return c.json({ error: "Servicio no encontrado" }, 404);
  return c.json(service);
});

tenantServicesRoutes.post("/", managers, async (c) => {
  const workshop = c.get("workshop");
  const parsed = serviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos", details: parsed.error.flatten() }, 400);
  const service = await prisma.service.create({
    data: { workshopId: workshop.id, ...serviceData(parsed.data) },
  });
  return c.json(service, 201);
});

tenantServicesRoutes.put("/:id", managers, async (c) => {
  const workshop = c.get("workshop");
  const id = serviceId(c.req.param("id"));
  if (!id) return c.json({ error: "Servicio inválido" }, 400);
  const parsed = serviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos", details: parsed.error.flatten() }, 400);
  const exists = await prisma.service.findFirst({
    where: { id, workshopId: workshop.id, deletedAt: null },
    select: { id: true },
  });
  if (!exists) return c.json({ error: "Servicio no encontrado" }, 404);
  const service = await prisma.service.update({
    where: { id },
    data: serviceData(parsed.data),
  });
  return c.json(service);
});

tenantServicesRoutes.delete("/:id", managers, async (c) => {
  const workshop = c.get("workshop");
  const id = serviceId(c.req.param("id"));
  if (!id) return c.json({ error: "Servicio inválido" }, 400);
  const exists = await prisma.service.findFirst({
    where: { id, workshopId: workshop.id, deletedAt: null },
    select: { id: true },
  });
  if (!exists) return c.json({ error: "Servicio no encontrado" }, 404);
  await prisma.service.update({ where: { id }, data: { isActive: false } });
  return c.json({ ok: true });
});
