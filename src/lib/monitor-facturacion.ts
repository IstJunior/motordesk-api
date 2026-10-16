// Monitoreo de la facturación electrónica de todos los talleres, para el panel.
//
// Responde tres preguntas:
//   1. ¿Cuánto se está facturando? Serie de documentos por día (o por mes) y
//      el total contra el periodo anterior.
//   2. ¿Está sano? Rechazos y pendientes: una factura pendiente puede existir
//      en la DIAN sin que MotorDesk lo sepa, y una rechazada es una venta sin
//      factura delante del cliente.
//   3. ¿A quién se le va a acabar? Ritmo de cada taller en los últimos 30 días
//      y la fecha en que, a ese ritmo, agota su paquete. Si es antes de que
//      venza, hay que llamarlo antes de que el mostrador se quede sin factura.
//
// El ambiente filtra la actividad (serie, indicadores, columnas del periodo).
// El cupo —paquete, usados, ritmo, proyección— es siempre de producción, que
// es lo único que gasta documentos; mezclar pruebas ahí haría ver agotado a un
// taller que no ha facturado nada de verdad.
//
// Las fechas se agrupan en hora de Bogotá, dicha en el SQL: la Supabase de
// pruebas está en UTC y sin la zona explícita contaría días distintos.

import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { cupoDeTaller } from "./cupo-facturacion.js";

const PROVEEDORES = ["factus", "nextpyme"];
const DIA = 24 * 60 * 60 * 1000;
const ZONA = "America/Bogota";

export const PERIODOS = [7, 30, 90, 365] as const;
export type Periodo = (typeof PERIODOS)[number];

type Fila = { b: string; facturas: bigint; rechazadas: bigint };
type FilaNotas = { b: string; notas: bigint };
type PorTaller = {
  workshop_id: bigint;
  facturas: bigint;
  rechazadas: bigint;
  pendientes: bigint;
  ultimo: Date | null;
};

/** Medianoche de Bogotá de hace `dias - 1` días: el periodo incluye hoy. */
function inicioDelPeriodo(dias: number, ahora: Date): Date {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA }).format(ahora);
  // Bogotá no tiene horario de verano: siempre UTC-5.
  const medianoche = new Date(`${hoy}T00:00:00-05:00`);
  return new Date(medianoche.getTime() - (dias - 1) * DIA);
}

/** Las etiquetas de todos los cubos del periodo, para que los vacíos salgan en cero. */
function cubos(desde: Date, hasta: Date, porMes: boolean): string[] {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONA }).format(d);
  const r: string[] = [];
  if (porMes) {
    const [a, m] = fmt(desde).split("-").map(Number) as [number, number];
    const [af, mf] = fmt(hasta).split("-").map(Number) as [number, number];
    for (let y = a, mm = m; y < af || (y === af && mm <= mf); mm === 12 ? ((mm = 1), y++) : mm++) {
      r.push(`${y}-${String(mm).padStart(2, "0")}-01`);
    }
    return r;
  }
  for (let t = desde.getTime(); t < hasta.getTime(); t += DIA) r.push(fmt(new Date(t + 12 * 60 * 60 * 1000)));
  return [...new Set(r)];
}

export async function monitorDeFacturacion(opciones: { dias: Periodo; conPruebas: boolean }, ahora = new Date()) {
  const { dias, conPruebas } = opciones;
  const ambientes = conPruebas ? ["production", "sandbox", "habilitacion"] : ["production"];
  const porMes = dias > 90;
  const unidad = porMes ? "month" : "day";
  const desde = inicioDelPeriodo(dias, ahora);
  const hasta = ahora;
  const desdeAnterior = new Date(desde.getTime() - dias * DIA);

  const base = Prisma.sql`provider = ANY(${PROVEEDORES}) AND environment = ANY(${ambientes})`;

  const [filas, filasNotas, porTaller, notasPorTaller, anterior, ritmo, talleres] = await Promise.all([
    prisma.$queryRaw<Fila[]>`
      SELECT to_char(date_trunc(${unidad}::text, created_at AT TIME ZONE ${ZONA}::text), 'YYYY-MM-DD') AS b,
             count(*) FILTER (WHERE status <> 'rejected') AS facturas,
             count(*) FILTER (WHERE status = 'rejected') AS rechazadas
      FROM dian_electronic_documents
      WHERE ${base} AND created_at >= ${desde} AND created_at < ${hasta}
      GROUP BY 1`,
    prisma.$queryRaw<FilaNotas[]>`
      SELECT to_char(date_trunc(${unidad}::text, credit_note_at AT TIME ZONE ${ZONA}::text), 'YYYY-MM-DD') AS b,
             count(*) AS notas
      FROM dian_electronic_documents
      WHERE ${base} AND credit_note_number IS NOT NULL AND credit_note_at >= ${desde} AND credit_note_at < ${hasta}
      GROUP BY 1`,
    prisma.$queryRaw<PorTaller[]>`
      SELECT workshop_id,
             count(*) FILTER (WHERE status <> 'rejected') AS facturas,
             count(*) FILTER (WHERE status = 'rejected') AS rechazadas,
             count(*) FILTER (WHERE status IN ('pending', 'sending')) AS pendientes,
             max(created_at) AS ultimo
      FROM dian_electronic_documents
      WHERE ${base} AND created_at >= ${desde} AND created_at < ${hasta}
      GROUP BY workshop_id`,
    prisma.$queryRaw<{ workshop_id: bigint; notas: bigint }[]>`
      SELECT workshop_id, count(*) AS notas
      FROM dian_electronic_documents
      WHERE ${base} AND credit_note_number IS NOT NULL AND credit_note_at >= ${desde} AND credit_note_at < ${hasta}
      GROUP BY workshop_id`,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT
        (SELECT count(*) FROM dian_electronic_documents
          WHERE ${base} AND status <> 'rejected' AND created_at >= ${desdeAnterior} AND created_at < ${desde})
      + (SELECT count(*) FROM dian_electronic_documents
          WHERE ${base} AND credit_note_number IS NOT NULL AND credit_note_at >= ${desdeAnterior} AND credit_note_at < ${desde})
        AS total`,
    // El ritmo es de producción y de los últimos 30 días, sea cual sea el filtro.
    prisma.$queryRaw<{ workshop_id: bigint; docs: bigint }[]>`
      SELECT workshop_id, count(*) AS docs FROM (
        SELECT workshop_id FROM dian_electronic_documents
         WHERE provider = ANY(${PROVEEDORES}) AND environment = 'production' AND status <> 'rejected'
           AND created_at >= ${new Date(ahora.getTime() - 30 * DIA)}
        UNION ALL
        SELECT workshop_id FROM dian_electronic_documents
         WHERE provider = ANY(${PROVEEDORES}) AND environment = 'production' AND credit_note_number IS NOT NULL
           AND credit_note_at >= ${new Date(ahora.getTime() - 30 * DIA)}
      ) d GROUP BY workshop_id`,
    prisma.workshop.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, enabledModules: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // ── Serie ──
  const porCubo = new Map<string, { facturas: number; notas: number; rechazadas: number }>();
  for (const c of cubos(desde, hasta, porMes)) porCubo.set(c, { facturas: 0, notas: 0, rechazadas: 0 });
  for (const f of filas) {
    const c = porCubo.get(f.b) ?? { facturas: 0, notas: 0, rechazadas: 0 };
    c.facturas += Number(f.facturas);
    c.rechazadas += Number(f.rechazadas);
    porCubo.set(f.b, c);
  }
  for (const f of filasNotas) {
    const c = porCubo.get(f.b) ?? { facturas: 0, notas: 0, rechazadas: 0 };
    c.notas += Number(f.notas);
    porCubo.set(f.b, c);
  }
  const serie = [...porCubo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fecha, v]) => ({ fecha, ...v }));

  // ── Por taller ──
  const actividad = new Map(porTaller.map((t) => [String(t.workshop_id), t]));
  const notasDe = new Map(notasPorTaller.map((t) => [String(t.workshop_id), Number(t.notas)]));
  const ritmoDe = new Map(ritmo.map((t) => [String(t.workshop_id), Number(t.docs) / 30]));

  const conModulo = talleres.filter((t) => {
    const m = t.enabledModules as Record<string, unknown> | null;
    return Boolean(m && m.facturacion_electronica);
  });
  // Un taller sin el módulo pero con documentos en el periodo también sale:
  // es justo lo raro que hay que ver.
  const ids = new Set([...conModulo.map((t) => String(t.id)), ...actividad.keys(), ...notasDe.keys()]);
  const nombre = new Map(talleres.map((t) => [String(t.id), t.name]));

  const filasTaller = await Promise.all(
    [...ids].map(async (id) => {
      const cupo = await cupoDeTaller(BigInt(id), ahora);
      const vigente = cupo.paquetes.find((p) => p.id === cupo.vigente) ?? null;
      const porActivar = cupo.paquetes.find((p) => p.estado === "por_activar" && !p.activadoEl) ?? null;
      const a = actividad.get(id);
      const ritmoDiario = ritmoDe.get(id) ?? 0;

      let agotaEl: string | null = null;
      if (vigente && ritmoDiario > 0 && cupo.restantes !== null) {
        agotaEl = new Date(ahora.getTime() + (cupo.restantes / ritmoDiario) * DIA).toISOString();
      }
      const venceEl = vigente?.venceEl ?? null;
      const diasParaVencer = venceEl ? Math.ceil((new Date(venceEl).getTime() - ahora.getTime()) / DIA) : null;

      // El riesgo más grave primero: es lo que se ve en la tabla.
      let riesgo: "agotado" | "se_agota" | "sin_paquete" | "por_vencer" | "alto_consumo" | null = null;
      if (cupo.produccion && !vigente) riesgo = porActivar ? null : "sin_paquete";
      else if (vigente && cupo.usados.total >= vigente.documentos) riesgo = "agotado";
      else if (agotaEl && venceEl && agotaEl < venceEl) riesgo = "se_agota";
      else if (diasParaVencer !== null && diasParaVencer <= 30) riesgo = "por_vencer";
      else if (vigente && cupo.usados.total >= vigente.documentos * 0.8) riesgo = "alto_consumo";

      return {
        id,
        nombre: nombre.get(id) ?? `Taller ${id}`,
        modalidad: cupo.modalidad,
        bolsaId: cupo.bolsaId,
        produccion: cupo.produccion,
        proveedor: cupo.proveedor,
        documentos: vigente?.documentos ?? null,
        usados: cupo.usados.total,
        venceEl,
        porActivarDesde: porActivar?.activableDesde ?? null,
        periodo: {
          facturas: a ? Number(a.facturas) : 0,
          notas: notasDe.get(id) ?? 0,
          rechazadas: a ? Number(a.rechazadas) : 0,
          pendientes: a ? Number(a.pendientes) : 0,
        },
        ultimoEl: a?.ultimo ? a.ultimo.toISOString() : null,
        ritmoDiario: Math.round(ritmoDiario * 100) / 100,
        agotaEl,
        riesgo,
      };
    }),
  );
  filasTaller.sort(
    (x, y) => y.periodo.facturas + y.periodo.notas - (x.periodo.facturas + x.periodo.notas) || x.nombre.localeCompare(y.nombre),
  );

  const emitidos = serie.reduce((s, c) => s + c.facturas + c.notas, 0);
  const rechazadas = serie.reduce((s, c) => s + c.rechazadas, 0);
  return {
    periodo: { dias, conPruebas, desde: desde.toISOString(), hasta: hasta.toISOString(), granularidad: unidad },
    kpis: {
      emitidos,
      emitidosAnterior: Number(anterior[0]?.total ?? 0),
      facturas: serie.reduce((s, c) => s + c.facturas, 0),
      notas: serie.reduce((s, c) => s + c.notas, 0),
      rechazadas,
      pendientes: filasTaller.reduce((s, t) => s + t.periodo.pendientes, 0),
      talleresActivos: filasTaller.filter((t) => t.periodo.facturas + t.periodo.notas > 0).length,
      talleresConModulo: conModulo.length,
      enRiesgo: filasTaller.filter((t) => t.riesgo && t.riesgo !== "alto_consumo").length,
    },
    serie,
    talleres: filasTaller,
  };
}
