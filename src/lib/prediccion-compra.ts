// Qué talleres en prueba tienen más probabilidad de comprar la suscripción.
//
// No es un modelo entrenado: con dos compras (Toximotos y Los Monos, y Los
// Monos pagó el mismo día que se registró) no hay de dónde aprender pesos. Es
// un puntaje por reglas, a la vista, que mide lo que un taller que se va a
// quedar hace en la prueba: entra casi todos los días, registra trabajo de
// verdad, usa más de un módulo, no se está apagando, y mete a su gente.
//
// Lo que sí lo ancla a los datos es la REFERENCIA: el mismo puntaje calculado
// para cada taller que compró, el día que compró. El panel dibuja esa marca en
// la barra de cada candidato: «así estaba Toximotos cuando pagó». Cuando haya
// diez compras, esa referencia ya dice si los pesos sirven.
//
// Todo día se cuenta en hora de Bogotá, explícito en el SQL (la base de
// pruebas está en UTC por rol).

import { prisma } from "./db.js";
import { deIso, hoyEnBogota, iso } from "./dias-habiles.js";

// ── Lo que se cuenta ─────────────────────────────────────────────────────────

/** Módulos que se miran para la amplitud. `turno_mov` cuenta como turnos. */
export const MODULOS = ["turnos", "mostrador", "inventario", "compras", "caja", "clientes"] as const;
export type Modulo = (typeof MODULOS)[number];

const ETIQUETA_MODULO: Record<Modulo, string> = {
  turnos: "Turnos",
  mostrador: "Mostrador",
  inventario: "Inventario",
  compras: "Compras",
  caja: "Caja",
  clientes: "Clientes",
};

type Tipo = Modulo | "turno_mov";

/** Pesos del puntaje. Suman 100. */
export const PESOS = {
  constancia: 30,
  volumen: 20,
  amplitud: 15,
  recencia: 15,
  tendencia: 10,
  equipo: 10,
} as const;
type Senal = keyof typeof PESOS;

/** Desde cuánto puntaje se dice alta o media. */
const BANDA_ALTA = 70;
const BANDA_MEDIA = 45;

/** Ventana que se mira: dos semanas. Un taller no abre domingos: 10 de 14 es lleno. */
const VENTANA = 14;
const DIAS_PARA_CONSTANCIA_LLENA = 10;
/** Turnos + ventas en la ventana que ya cuentan como volumen lleno. */
const OPERACIONES_LLENAS = 40;
/** Módulos usados que ya cuentan como amplitud llena (además de turnos). */
const MODULOS_LLENOS = 4;
/** Días sin registrar nada desde los que la recencia vale cero. */
const DIAS_APAGADO = 7;

/**
 * Talleres reales de correo pero que fueron de prueba: no son ni candidatos
 * ni «se fueron», y contarlos tuerce la conversión.
 *   74  Mundo Motos (prueba interna, septiembre de 2026)
 */
const EXCLUIDOS = new Set(["74"]);

// ── Tipos de la respuesta ────────────────────────────────────────────────────

export type Banda = "alta" | "media" | "baja";

export type Factor = {
  senal: Senal;
  /** Lo que vale la señal, de 0 a 1. */
  valor: number;
  /** Puntos que aporta (valor × peso). */
  puntos: number;
  peso: number;
  /** La frase que lo explica, con el número. */
  texto: string;
};

export type Lectura = {
  puntaje: number;
  banda: Banda;
  factores: Factor[];
  diasActivos: number;
  operaciones: number;
  modulos: Modulo[];
  diasSinActividad: number | null;
  /** Actividad de cada uno de los últimos 28 días (eventos), del más viejo al de hoy. */
  serie: number[];
};

export type Candidato = {
  id: string;
  nombre: string;
  ciudad: string | null;
  telefono: string | null;
  creadoEl: string;
  finDePrueba: string | null;
  /** Día de la prueba en que va (1 = el día que se registró). */
  diaDePrueba: number;
  duracionDePrueba: number | null;
  diasRestantes: number | null;
  miembros: number;
  lectura: Lectura;
  sugerencia: { tono: "cerrar" | "acompanar" | "reactivar"; texto: string };
};

export type Referencia = {
  id: string;
  nombre: string;
  pagadoEl: string;
  /** Días que tardó en comprar desde que se registró. */
  diasHastaComprar: number;
  /** Puntaje que tenía el día que compró. Null si compró sin probar. */
  puntaje: number | null;
};

export type SeFue = {
  id: string;
  nombre: string;
  telefono: string | null;
  finDePrueba: string | null;
  ultimaActividad: string | null;
  puntajeAlFinal: number;
  estado: "vencida" | "suspendida" | "cancelada";
};

export type PrediccionCompra = {
  calculadoEl: string;
  pesos: typeof PESOS;
  bandas: { alta: number; media: number };
  candidatos: Candidato[];
  referencias: Referencia[];
  /** Puntaje promedio de los que compraron después de probar (null si ninguno). */
  umbral: number | null;
  seFueron: SeFue[];
  embudo: { enPrueba: number; compraron: number; seFueron: number; conversion: number | null };
};

// ── Datos ────────────────────────────────────────────────────────────────────

type FilaTaller = {
  id: string;
  nombre: string;
  ciudad: string | null;
  telefono: string | null;
  creado: Date;
  fin_prueba: Date | null;
  estado: string;
  activo: boolean;
  pagado_el: Date | null;
  miembros: number;
  sub_estado: string | null;
};

type FilaEvento = { id: string; dia: string; tipo: Tipo; n: number };

/** Talleres reales: fuera los sembrados de muestra (`@ejemplo.motordesk.test`). */
async function talleres(): Promise<FilaTaller[]> {
  return prisma.$queryRaw<FilaTaller[]>`
    SELECT w.id::text AS id, w.name AS nombre, w.city AS ciudad, w.phone AS telefono,
           w.created_at AS creado,
           CASE WHEN s.status = 'trialing' THEN COALESCE(s.trial_ends_at, w.trial_ends_at) ELSE w.trial_ends_at END AS fin_prueba,
           COALESCE(w.subscription_status, '') AS estado,
           COALESCE(w.is_active, true) AS activo,
           (SELECT min(i.paid_at) FROM invoices i WHERE i.workshop_id = w.id AND i.status = 'paid') AS pagado_el,
           (SELECT count(*)::int FROM workshop_user wu WHERE wu.workshop_id = w.id) AS miembros,
           s.status AS sub_estado
      FROM workshops w
      LEFT JOIN subscriptions s ON s.workshop_id = w.id
     WHERE w.deleted_at IS NULL
       AND COALESCE(w.email, '') NOT ILIKE '%@ejemplo.motordesk.test'`;
}

/** Eventos por taller, día (Bogotá) y tipo, desde que cada taller existe. */
async function eventos(): Promise<FilaEvento[]> {
  return prisma.$queryRaw<FilaEvento[]>`
    WITH ev AS (
      SELECT workshop_id, created_at AS t, 'turnos' AS tipo FROM appointments WHERE deleted_at IS NULL
      UNION ALL
      SELECT workshop_id, updated_at, 'turno_mov' FROM appointments
       WHERE deleted_at IS NULL AND updated_at > created_at + interval '1 minute'
      UNION ALL
      SELECT workshop_id, created_at, 'mostrador' FROM sales WHERE deleted_at IS NULL
      UNION ALL
      SELECT workshop_id, created_at, 'inventario' FROM inventory_items WHERE deleted_at IS NULL
      UNION ALL
      SELECT workshop_id, created_at, 'inventario' FROM inventory_movements
      UNION ALL
      SELECT workshop_id, created_at, 'compras' FROM purchases WHERE deleted_at IS NULL
      UNION ALL
      SELECT workshop_id, opened_at, 'caja' FROM cash_sessions
      UNION ALL
      SELECT workshop_id, created_at, 'clientes' FROM customer_workshops
    )
    SELECT ev.workshop_id::text AS id,
           to_char(ev.t AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS dia,
           ev.tipo,
           count(*)::int AS n
      FROM ev
      JOIN workshops w ON w.id = ev.workshop_id
     WHERE w.deleted_at IS NULL
       AND COALESCE(w.email, '') NOT ILIKE '%@ejemplo.motordesk.test'
       AND ev.t >= w.created_at - interval '1 day'
     GROUP BY 1, 2, 3`;
}

// ── Cálculo ──────────────────────────────────────────────────────────────────

const DIA_MS = 86_400_000;
const diaBogota = (d: Date) => iso(hoyEnBogota(d));
const diasEntre = (desde: string, hasta: string) => Math.round((deIso(hasta).getTime() - deIso(desde).getTime()) / DIA_MS);
const restar = (dia: string, n: number) => iso(new Date(deIso(dia).getTime() - n * DIA_MS));
const acotar = (x: number) => Math.max(0, Math.min(1, x));
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** Por día: tipo → cantidad. */
type Historia = Map<string, Map<Tipo, number>>;

function agrupar(filas: FilaEvento[]): Map<string, Historia> {
  const porTaller = new Map<string, Historia>();
  for (const f of filas) {
    let h = porTaller.get(f.id);
    if (!h) porTaller.set(f.id, (h = new Map()));
    let d = h.get(f.dia);
    if (!d) h.set(f.dia, (d = new Map()));
    d.set(f.tipo, (d.get(f.tipo) ?? 0) + f.n);
  }
  return porTaller;
}

/** Lee la historia de un taller tal como estaba el día `corte`. */
export function leer(historia: Historia | undefined, corte: string, miembros: number): Lectura {
  const dias = [...(historia?.keys() ?? [])].filter((d) => d <= corte).sort();
  const total = (d: string) => [...(historia?.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const de = (d: string, t: Tipo) => historia?.get(d)?.get(t) ?? 0;

  const desde = restar(corte, VENTANA - 1);
  const enVentana = dias.filter((d) => d >= desde);
  const diasActivos = enVentana.length;
  const operaciones = enVentana.reduce((s, d) => s + de(d, "turnos") + de(d, "mostrador"), 0);

  const usados = new Set<Modulo>();
  for (const d of dias) {
    for (const t of historia!.get(d)!.keys()) usados.add(t === "turno_mov" ? "turnos" : t);
  }
  const modulos = MODULOS.filter((m) => usados.has(m));

  const ultimo = dias.at(-1) ?? null;
  const diasSinActividad = ultimo ? diasEntre(ultimo, corte) : null;

  const corteSemana = restar(corte, 6);
  const previa = restar(corte, 13);
  const reciente = dias.filter((d) => d >= corteSemana).reduce((s, d) => s + total(d), 0);
  const anterior = dias.filter((d) => d >= previa && d < corteSemana).reduce((s, d) => s + total(d), 0);

  const serie = Array.from({ length: 28 }, (_, i) => total(restar(corte, 27 - i)));

  // Cada señal de 0 a 1.
  const valor: Record<Senal, number> = {
    constancia: acotar(diasActivos / DIAS_PARA_CONSTANCIA_LLENA),
    volumen: acotar(Math.log1p(operaciones) / Math.log1p(OPERACIONES_LLENAS)),
    amplitud: acotar((modulos.length - 1) / (MODULOS_LLENOS - 1)),
    recencia: diasSinActividad === null ? 0 : acotar(1 - Math.max(0, diasSinActividad - 1) / (DIAS_APAGADO - 1)),
    tendencia: reciente === 0 && anterior === 0 ? 0 : acotar(((reciente + 1) / (anterior + 1) - 0.3) / 0.7),
    equipo: miembros >= 2 ? 1 : 0,
  };

  const faltan = MODULOS.filter((m) => !usados.has(m)).map((m) => ETIQUETA_MODULO[m].toLowerCase());
  const texto: Record<Senal, string> = {
    constancia: `${plural(diasActivos, "día", "días")} con actividad de los últimos ${VENTANA}`,
    volumen: `${plural(operaciones, "turno o venta", "turnos y ventas")} en dos semanas`,
    amplitud:
      modulos.length === 0
        ? "Todavía no usa ningún módulo"
        : `Usa ${modulos.length} de ${MODULOS.length} módulos${faltan.length ? ` · falta ${faltan.slice(0, 2).join(" y ")}` : ""}`,
    recencia:
      diasSinActividad === null
        ? "Nunca ha registrado nada"
        : diasSinActividad === 0
          ? "Registró algo hoy"
          : diasSinActividad === 1
            ? "Registró algo ayer"
            : `Lleva ${diasSinActividad} días sin registrar nada`,
    tendencia:
      reciente === 0 && anterior === 0
        ? "Sin actividad en dos semanas"
        : anterior === 0
          ? "Empezó a usarlo esta semana"
          : reciente >= anterior
            ? `Esta semana usó más que la anterior (${reciente} contra ${anterior})`
            : `Esta semana usó menos que la anterior (${reciente} contra ${anterior})`,
    equipo: miembros >= 2 ? `Tiene ${miembros} personas en el equipo` : "Lo usa una sola persona",
  };

  const factores = (Object.keys(PESOS) as Senal[]).map((senal) => ({
    senal,
    valor: Math.round(valor[senal] * 100) / 100,
    peso: PESOS[senal],
    puntos: Math.round(valor[senal] * PESOS[senal] * 10) / 10,
    texto: texto[senal],
  }));
  const puntaje = Math.round(factores.reduce((s, f) => s + f.puntos, 0));
  const banda: Banda = puntaje >= BANDA_ALTA ? "alta" : puntaje >= BANDA_MEDIA ? "media" : "baja";

  return { puntaje, banda, factores, diasActivos, operaciones, modulos, diasSinActividad, serie };
}

function sugerir(l: Lectura, diasRestantes: number | null): Candidato["sugerencia"] {
  const vence = diasRestantes === null ? "" : diasRestantes <= 0 ? "vence hoy" : `vence en ${plural(diasRestantes, "día", "días")}`;
  if (l.diasSinActividad === null || l.diasSinActividad >= 4) {
    return {
      tono: "reactivar",
      texto:
        l.diasSinActividad === null
          ? "No ha registrado nada. Ofrézcale cargarle los primeros turnos con él."
          : `Lleva ${l.diasSinActividad} días quieto. Pregúntele qué lo frenó antes de que se enfríe.`,
    };
  }
  if (l.banda === "alta") {
    return {
      tono: "cerrar",
      texto:
        diasRestantes !== null && diasRestantes <= 7
          ? `Listo para cerrar: lo usa casi a diario y la prueba ${vence}. Ofrézcale el plan anual.`
          : `Va bien. Escríbale antes del cierre${vence ? ` (la prueba ${vence})` : ""} con el plan anual.`,
    };
  }
  const sinInventario = !l.modulos.includes("inventario");
  const sinMostrador = !l.modulos.includes("mostrador");
  if (sinInventario || sinMostrador) {
    return {
      tono: "acompanar",
      texto: sinInventario
        ? "Solo usa una parte. Ofrézcale cargarle el inventario: es lo que más amarra."
        : "Agenda pero no vende por el sistema. Muéstrele el mostrador y la caja.",
    };
  }
  return { tono: "acompanar", texto: `Lo usa a ratos. Una llamada corta para resolver dudas${vence ? `; la prueba ${vence}` : ""}.` };
}

export async function prediccionDeCompra(ahora = new Date()): Promise<PrediccionCompra> {
  const [filas, evs] = await Promise.all([talleres(), eventos()]);
  const historias = agrupar(evs);
  const hoy = diaBogota(ahora);

  const candidatos: Candidato[] = [];
  const referencias: Referencia[] = [];
  const seFueron: SeFue[] = [];

  for (const t of filas) {
    if (EXCLUIDOS.has(t.id)) continue;
    const creado = diaBogota(t.creado);
    const fin = t.fin_prueba ? diaBogota(t.fin_prueba) : null;
    const historia = historias.get(t.id);

    if (t.pagado_el) {
      const pagado = diaBogota(t.pagado_el);
      const dias = diasEntre(creado, pagado);
      // Quien paga el mismo día que se registra no probó: no dice nada del
      // comportamiento en la prueba, así que no entra al umbral.
      referencias.push({
        id: t.id,
        nombre: t.nombre,
        pagadoEl: pagado,
        diasHastaComprar: dias,
        puntaje: dias >= 7 ? leer(historia, pagado, t.miembros).puntaje : null,
      });
      continue;
    }

    const enPrueba =
      t.activo && (t.estado === "trial" || t.sub_estado === "trialing") && (fin === null || fin >= hoy);

    if (enPrueba) {
      const lectura = leer(historia, hoy, t.miembros);
      const diasRestantes = fin ? diasEntre(hoy, fin) : null;
      candidatos.push({
        id: t.id,
        nombre: t.nombre,
        ciudad: t.ciudad,
        telefono: t.telefono,
        creadoEl: creado,
        finDePrueba: fin,
        diaDePrueba: diasEntre(creado, hoy) + 1,
        duracionDePrueba: fin ? diasEntre(creado, fin) : null,
        diasRestantes,
        miembros: t.miembros,
        lectura,
        sugerencia: sugerir(lectura, diasRestantes),
      });
    } else {
      const dias = [...(historia?.keys() ?? [])].sort();
      const corte = fin && fin < hoy ? fin : hoy;
      seFueron.push({
        id: t.id,
        nombre: t.nombre,
        telefono: t.telefono,
        finDePrueba: fin,
        ultimaActividad: dias.at(-1) ?? null,
        puntajeAlFinal: leer(historia, corte, t.miembros).puntaje,
        estado: !t.activo || t.estado === "suspended" ? "suspendida" : t.estado === "canceled" ? "cancelada" : "vencida",
      });
    }
  }

  candidatos.sort((a, b) => b.lectura.puntaje - a.lectura.puntaje || (a.diasRestantes ?? 99) - (b.diasRestantes ?? 99));
  referencias.sort((a, b) => a.pagadoEl.localeCompare(b.pagadoEl));
  seFueron.sort((a, b) => (b.ultimaActividad ?? "").localeCompare(a.ultimaActividad ?? ""));

  const conPrueba = referencias.filter((r) => r.puntaje !== null);
  const umbral = conPrueba.length
    ? Math.round(conPrueba.reduce((s, r) => s + (r.puntaje ?? 0), 0) / conPrueba.length)
    : null;
  const decididos = referencias.length + seFueron.length;

  return {
    calculadoEl: ahora.toISOString(),
    pesos: PESOS,
    bandas: { alta: BANDA_ALTA, media: BANDA_MEDIA },
    candidatos,
    referencias,
    umbral,
    seFueron,
    embudo: {
      enPrueba: candidatos.length,
      compraron: referencias.length,
      seFueron: seFueron.length,
      conversion: decididos ? Math.round((referencias.length / decididos) * 100) : null,
    },
  };
}
