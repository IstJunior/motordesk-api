import { Hono, type Context } from "hono";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import {
  borrarManual,
  catalogo,
  ManualError,
  subirManual,
  TIPOS_DE_MANUAL,
  type ManualEnDisco,
} from "../lib/manuales-disco.js";

// Catálogo global de manuales técnicos (superadmin).
//
// La fuente es el disco del servidor, el mismo que leen los talleres (ver
// lib/manuales-disco.ts). Antes era R2, que es la copia de contingencia y está
// atrasada: el superadmin veía 168 manuales de mayo y lo que subía no le
// llegaba a ningún taller.
export const manualesRoutes = new Hono();
manualesRoutes.use("*", superadminGuard);

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const POR_PAGINA = 50;

function coincide(m: ManualEnDisco, q: string): boolean {
  if (!q) return true;
  const n = q.toLocaleLowerCase("es");
  return [m.brand, m.model, m.title, m.internalId, m.category, m.year?.toString() ?? ""].some((c) =>
    c.toLocaleLowerCase("es").includes(n),
  );
}

function responderError(c: Context, error: unknown, que: string) {
  if (error instanceof ManualError) return c.json({ error: error.message }, error.status);
  console.error(`[manuales] ${que}:`, error instanceof Error ? error.message : error);
  return c.json({ error: `No fue posible ${que}.` }, 500);
}

// GET /manuales?q=&page= — una página del catálogo, con el total y las marcas.
// Antes devolvía todo de una: con 1.299 manuales eso es una tabla que el
// navegador tarda en pintar para mostrar las primeras veinte filas.
manualesRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const pagina = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  try {
    const todos = await catalogo();
    const filtrados = todos.filter((m) => coincide(m, q));
    return c.json({
      manuales: filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA),
      total: filtrados.length,
      totalBiblioteca: todos.length,
      marcas: new Set(todos.map((m) => m.brand)).size,
      pagina,
      porPagina: POR_PAGINA,
    });
  } catch (error) {
    return responderError(c, error, "cargar la biblioteca de manuales");
  }
});

manualesRoutes.get("/meta/tipos", (c) => c.json({ tipos: TIPOS_DE_MANUAL }));

// POST /manuales — multipart: file (PDF), brand, model, year?, type?
manualesRoutes.post("/", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.json({ error: "Formulario inválido" }, 400);

  const file = form["file"];
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "Falta el archivo PDF" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "El archivo supera los 80 MB" }, 413);
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return c.json({ error: "El manual debe ser un PDF" }, 400);
  }
  const contenido = Buffer.from(await file.arrayBuffer());
  // Un PDF empieza con "%PDF": el tipo que manda el navegador se puede falsear.
  if (contenido.subarray(0, 4).toString("latin1") !== "%PDF") {
    return c.json({ error: "El archivo no es un PDF válido" }, 400);
  }

  const anioCrudo = Number(String(form["year"] ?? "").trim());
  const anio = Number.isInteger(anioCrudo) && anioCrudo > 1900 && anioCrudo < 2100 ? anioCrudo : null;

  try {
    const manual = await subirManual({
      contenido,
      marca: String(form["brand"] ?? ""),
      modelo: String(form["model"] ?? ""),
      tipo: String(form["type"] ?? "Taller"),
      anio,
    });
    return c.json(manual, 201);
  } catch (error) {
    return responderError(c, error, "subir el manual");
  }
});

// DELETE /manuales?key=… — borra el PDF de la biblioteca (y su fila, si la hay).
manualesRoutes.delete("/", async (c) => {
  const key = (c.req.query("key") ?? "").trim();
  try {
    await borrarManual(key);
  } catch (error) {
    return responderError(c, error, "borrar el manual");
  }
  // La fila solo existe para la consulta con IA; si había una, ya no apunta a nada.
  await prisma.technicalManual.deleteMany({ where: { filePath: { endsWith: key } } }).catch(() => {});
  return c.json({ ok: true });
});
