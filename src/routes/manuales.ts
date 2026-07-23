import { Hono } from "hono";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

// Catálogo global de manuales técnicos (superadmin).
export const manualesRoutes = new Hono();
manualesRoutes.use("*", superadminGuard);

manualesRoutes.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const manuales = await prisma.technicalManual.findMany({
    where: q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { brand: { contains: q, mode: "insensitive" } },
            { model: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { id: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      brand: true,
      model: true,
      year: true,
      category: true,
      isActive: true,
      isFeatured: true,
      createdAt: true,
    },
  });
  return c.json(manuales);
});

manualesRoutes.get("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const m = await prisma.technicalManual.findUnique({ where: { id } });
  if (!m) return c.json({ error: "No encontrado" }, 404);
  return c.json(m);
});
