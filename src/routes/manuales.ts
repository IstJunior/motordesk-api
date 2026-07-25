import { Hono } from "hono";
import { prisma } from "../lib/db.js";
import { parseR2Manual, type R2Manual } from "../lib/r2-manuals.js";
import { listR2Objects, r2Configured } from "../lib/r2.js";
import { superadminGuard } from "../auth/middleware.js";

// Catálogo global de manuales técnicos (superadmin).
export const manualesRoutes = new Hono();
manualesRoutes.use("*", superadminGuard);

const R2_MANUALS_PREFIX = "Manuales Colombia Top/";
const CACHE_TTL_MS = 5 * 60 * 1000;

let catalogCache: { expiresAt: number; manuals: R2Manual[] } | null = null;

async function loadCatalog(): Promise<R2Manual[]> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.manuals;
  const objects = await listR2Objects(R2_MANUALS_PREFIX);
  const manuals = objects
    .map(parseR2Manual)
    .filter((manual): manual is R2Manual => manual !== null)
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
  catalogCache = { expiresAt: Date.now() + CACHE_TTL_MS, manuals };
  return manuals;
}

function matchesQuery(manual: R2Manual, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLocaleLowerCase("es");
  const fields = [manual.brand, manual.model, manual.title, manual.internalId, manual.year?.toString() ?? ""];
  return fields.some((field) => field.toLocaleLowerCase("es").includes(normalized));
}
manualesRoutes.get("/", async (c) => {
  if (!r2Configured()) return c.json({ error: "R2 no está configurado en la API" }, 503);
  const query = (c.req.query("q") ?? "").trim();
  try {
    const manuals = await loadCatalog();
    return c.json(manuals.filter((manual) => matchesQuery(manual, query)));
  } catch (error) {
    console.error("[manuales] No fue posible listar R2:", error instanceof Error ? error.message : error);
    return c.json({ error: "No fue posible cargar el catálogo de R2" }, 502);
  }
});

manualesRoutes.get("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const m = await prisma.technicalManual.findUnique({ where: { id } });
  if (!m) return c.json({ error: "No encontrado" }, 404);
  return c.json(m);
});
