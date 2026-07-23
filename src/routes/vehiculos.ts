import { Hono } from "hono";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

// Catálogo global de modelos de vehículo (superadmin).
export const vehiculosRoutes = new Hono();
vehiculosRoutes.use("*", superadminGuard);

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
