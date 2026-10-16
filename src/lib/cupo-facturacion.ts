// Documentos de facturación electrónica por taller y por bolsa, vistos desde el
// panel del proveedor.
//
// El conteo es el mismo que usa el monolito para cortar la emisión
// (src/lib/facturacion/cupo.ts): si los dos contaran distinto, el panel diría
// que a un taller le quedan documentos mientras el mostrador no puede facturar.
// Cualquier cambio en qué cuenta como documento va en los dos archivos.

import { prisma } from "./db.js";

const PROVEEDORES = ["factus", "nextpyme"];
const DIA = 24 * 60 * 60 * 1000;

export const MODALIDADES = ["individual", "bolsa"] as const;
export type Modalidad = (typeof MODALIDADES)[number];

/** Documentos de producción gastados por unos talleres entre dos instantes. */
export async function contarDocumentos(workshopIds: bigint[], desde: Date, hasta: Date) {
  if (workshopIds.length === 0) return { facturas: 0, notas: 0, total: 0 };
  const base = {
    workshopId: { in: workshopIds },
    provider: { in: PROVEEDORES },
    environment: "production",
  };
  const [facturas, notas] = await Promise.all([
    prisma.dianElectronicDocument.count({
      where: { ...base, status: { not: "rejected" }, createdAt: { gte: desde, lt: hasta } },
    }),
    prisma.dianElectronicDocument.count({
      where: { ...base, creditNoteNumber: { not: null }, creditNoteAt: { gte: desde, lt: hasta } },
    }),
  ]);
  return { facturas, notas, total: facturas + notas };
}

/** Mismo día del mes, o el último si no existe (31 de enero + 1 mes = 28/29 de febrero). */
export function sumarMeses(base: Date, meses: number): Date {
  const r = new Date(base.getTime());
  const dia = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(dia, ultimo));
  return r;
}

type Paquete = Awaited<ReturnType<typeof prisma.paqueteDeFacturacion.findMany>>[number];

export type EstadoPaquete = "por_activar" | "activo" | "vencido" | "anulado";

export function estadoDePaquete(p: Paquete, ahora = new Date()): EstadoPaquete {
  if (p.anuladoEl) return "anulado";
  if (!p.activadoEl || !p.venceEl) return "por_activar";
  if (ahora >= p.venceEl) return "vencido";
  // Una renovación activada antes de que venza la anterior arranca después:
  // mientras tanto sigue "por activar" a efectos de quien la mira.
  if (ahora < p.activadoEl) return "por_activar";
  return "activo";
}

/** Fin exclusivo de una bolsa: hasta el final de su día de vencimiento. */
export function finDeBolsa(venceEl: Date): Date {
  return new Date(venceEl.getTime() + DIA);
}

/** Todo lo que el panel necesita del cupo de un taller. */
export async function cupoDeTaller(workshopId: bigint, ahora = new Date()) {
  const [cfg, paquetes] = await Promise.all([
    prisma.workshopDianConfig.findUnique({
      where: { workshopId },
      select: { provider: true, providerEnvironment: true, cupoModalidad: true, cupoBolsaId: true },
    }),
    prisma.paqueteDeFacturacion.findMany({ where: { workshopId }, orderBy: { createdAt: "desc" } }),
  ]);

  const vigente = paquetes.find((p) => estadoDePaquete(p, ahora) === "activo") ?? null;
  const usados = vigente
    ? await contarDocumentos([workshopId], vigente.activadoEl!, vigente.venceEl!)
    : { facturas: 0, notas: 0, total: 0 };

  return {
    modalidad: (cfg?.cupoModalidad === "bolsa" ? "bolsa" : "individual") as Modalidad,
    bolsaId: cfg?.cupoBolsaId ? String(cfg.cupoBolsaId) : null,
    proveedor: cfg?.provider ?? null,
    // Solo en producción se gasta cupo; en pruebas el conteo es informativo.
    produccion: Boolean(cfg && PROVEEDORES.includes(cfg.provider) && cfg.providerEnvironment === "production"),
    vigente: vigente ? String(vigente.id) : null,
    usados,
    restantes: vigente ? Math.max(0, vigente.documentos - usados.total) : null,
    paquetes: paquetes.map((p) => ({
      id: String(p.id),
      nivel: p.nivel,
      documentos: p.documentos,
      precio: p.precio === null ? null : Number(p.precio),
      pagadoEl: p.pagadoEl.toISOString().slice(0, 10),
      activableDesde: p.activableDesde.toISOString().slice(0, 10),
      activadoEl: p.activadoEl?.toISOString() ?? null,
      venceEl: p.venceEl?.toISOString() ?? null,
      anuladoEl: p.anuladoEl?.toISOString() ?? null,
      notas: p.notas,
      estado: estadoDePaquete(p, ahora),
    })),
  };
}

/**
 * Las bolsas con lo repartido y lo gastado.
 *
 * - **Repartido**: la suma de los paquetes vigentes o por activar de los
 *   talleres que gastan de ella. Pasarse no es un error en sí —el proveedor no
 *   corta por taller—, pero quiere decir que se prometieron documentos que la
 *   bolsa no tiene.
 * - **Gastado**: los documentos de producción de esos talleres desde la compra.
 *   Se cuenta por quién está hoy en la bolsa: un taller que gastó de ella y
 *   después volvió a paquete individual deja de sumar.
 */
export async function resumenDeBolsas(ahora = new Date()) {
  const bolsas = await prisma.bolsaDeFacturacion.findMany({
    orderBy: { compradaEl: "desc" },
    include: { talleres: { where: { cupoModalidad: "bolsa" }, select: { workshopId: true } } },
  });

  return Promise.all(
    bolsas.map(async (b) => {
      const ids = b.talleres.map((t) => t.workshopId);
      const [gastado, paquetes] = await Promise.all([
        contarDocumentos(ids, b.compradaEl, finDeBolsa(b.venceEl)),
        prisma.paqueteDeFacturacion.findMany({ where: { workshopId: { in: ids }, anuladoEl: null } }),
      ]);
      const repartido = paquetes
        .filter((p) => {
          const e = estadoDePaquete(p, ahora);
          return e === "activo" || e === "por_activar";
        })
        .reduce((s, p) => s + p.documentos, 0);
      return {
        id: String(b.id),
        nombre: b.nombre,
        proveedor: b.proveedor,
        documentos: b.documentos,
        precio: b.precio === null ? null : Number(b.precio),
        compradaEl: b.compradaEl.toISOString().slice(0, 10),
        venceEl: b.venceEl.toISOString().slice(0, 10),
        notas: b.notas,
        vencida: ahora >= finDeBolsa(b.venceEl),
        talleres: ids.length,
        repartido,
        gastado: gastado.total,
      };
    }),
  );
}
