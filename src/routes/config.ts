import { Hono } from "hono";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

// Configuración global (superadmin): system settings + proveedores de IA.
export const configRoutes = new Hono();
configRoutes.use("*", superadminGuard);

// GET /config — ajustes del sistema.
configRoutes.get("/", async (c) => {
  const settings = await prisma.systemSetting.findMany();
  return c.json(settings);
});

// GET /config/ai-providers — proveedores de IA configurados.
configRoutes.get("/ai-providers", async (c) => {
  const providers = await prisma.aiProviderConfig.findMany({ orderBy: { id: "asc" } });
  return c.json(providers);
});
