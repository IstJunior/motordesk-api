import { Hono } from "hono";
import { prisma } from "../lib/db.js";
import { parseR2Manual, type R2Manual } from "../lib/r2-manuals.js";
import { deleteR2Object, listR2Objects, r2Configured, uploadR2Object } from "../lib/r2.js";
import { superadminGuard } from "../auth/middleware.js";

// Catálogo global de manuales técnicos (superadmin). La fuente de verdad es R2:
// el taller lee esos mismos objetos, así que subir y borrar aquí opera sobre el
// bucket. La fila en `technical_manuals` aporta el ID interno del nombre.
export const manualesRoutes = new Hono();
manualesRoutes.use("*", superadminGuard);

const R2_MANUALS_PREFIX = "Manuales Colombia Top/";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

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

function nombreSeguro(valor: string): string {
  return valor.replace(/[/\\?%*:|"<>]/g, "-").trim();
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

// POST /manuales — multipart: file (PDF), brand, model, year?, engineType?, category?
// Sube al bucket con la estructura que espera el catálogo:
// Manuales Colombia Top/{marca}/{modelo}/{id} - {modelo} - Taller - {año}.pdf
manualesRoutes.post("/", async (c) => {
  if (!r2Configured()) return c.json({ error: "R2 no está configurado en la API" }, 503);

  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: "Formulario inválido" }, 400);

  const file = form["file"];
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "Falta el archivo PDF" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "El archivo supera los 80 MB" }, 413);
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return c.json({ error: "El manual debe ser un PDF" }, 400);
  }

  const brand = nombreSeguro(String(form["brand"] ?? ""));
  const model = nombreSeguro(String(form["model"] ?? ""));
  if (!brand || !model) return c.json({ error: "Marca y modelo son obligatorios" }, 400);
  const yearRaw = Number(String(form["year"] ?? "").trim());
  const year = Number.isFinite(yearRaw) && yearRaw > 1900 ? Math.trunc(yearRaw) : new Date().getFullYear();
  const title = String(form["title"] ?? "").trim() || `${model} - Taller`;
  const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  // El registro se crea primero: su id autoincremental es el ID interno que
  // lleva el nombre del archivo en el bucket.
  const registro = await prisma.technicalManual.create({
    data: {
      title,
      slug,
      brand,
      model,
      year,
      engineType: String(form["engineType"] ?? "").trim() || null,
      category: String(form["category"] ?? "").trim() || "Taller",
      filePath: "pending",
      fileSize: 0,
      mimeType: "",
      isActive: true,
    },
  });

  const paddedId = String(registro.id).padStart(4, "0");
  const key = `${R2_MANUALS_PREFIX}${brand}/${model}/${paddedId} - ${model} - Taller - ${year}.pdf`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadR2Object(key, buffer, "application/pdf");
    await prisma.technicalManual.update({
      where: { id: registro.id },
      data: { filePath: key, fileSize: buffer.byteLength, mimeType: "application/pdf" },
    });
  } catch (error) {
    // Sin archivo en el bucket el registro no sirve para nada.
    await prisma.technicalManual.delete({ where: { id: registro.id } }).catch(() => {});
    console.error("[manuales] Falló la subida a R2:", error instanceof Error ? error.message : error);
    return c.json({ error: "No fue posible subir el manual a R2" }, 502);
  }

  catalogCache = null;
  return c.json({ key, brand, model, year, internalId: paddedId }, 201);
});

// DELETE /manuales?key=… — borra el objeto del bucket y su fila si existe.
manualesRoutes.delete("/", async (c) => {
  if (!r2Configured()) return c.json({ error: "R2 no está configurado en la API" }, 503);
  const key = (c.req.query("key") ?? "").trim();
  if (!key.startsWith(R2_MANUALS_PREFIX)) return c.json({ error: "Manual no válido" }, 400);

  try {
    await deleteR2Object(key);
  } catch (error) {
    console.error("[manuales] Falló el borrado en R2:", error instanceof Error ? error.message : error);
    return c.json({ error: "No fue posible borrar el manual en R2" }, 502);
  }
  await prisma.technicalManual.deleteMany({ where: { filePath: key } });

  catalogCache = null;
  return c.json({ ok: true });
});

manualesRoutes.get("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const m = await prisma.technicalManual.findUnique({ where: { id } });
  if (!m) return c.json({ error: "No encontrado" }, 404);
  return c.json(m);
});
