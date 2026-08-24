// Alcance de datos de un taller, derivado del DMMF de Prisma.
//
// MotorDesk es multi-tenant de schema único (todo cuelga de `workshop_id`), no
// schema-por-tenant como SmartPOS. Por eso el respaldo de UN taller no puede ser
// `pg_dump --schema`: hay que recortar por filas. Para no mantener a mano el
// orden de FKs de ~50 modelos, el grafo se calcula solo leyendo el datamodel:
//
//   1. `workshops` con `id = $1` es la raíz.
//   2. Toda tabla con FK directa a `workshops` se recorta por `workshop_id = $1`.
//   3. Toda tabla sin `workshop_id` pero con FK obligatoria a una tabla ya
//      recortada hereda el recorte vía subconsulta (appointment_services →
//      appointments, chat_messages → chat_sessions, …). Se itera a punto fijo.
//   4. Lo que no cae en 1–3 es global del sistema (users, vehicles, roles,
//      planes, manuales…) y NO pertenece al taller: se trata como *referencia*.
import { Prisma } from "@prisma/client";

type Modelo = (typeof Prisma.dmmf.datamodel.models)[number];
type Campo = Modelo["fields"][number];

const MODELOS = Prisma.dmmf.datamodel.models;
const POR_NOMBRE = new Map<string, Modelo>(MODELOS.map((m) => [m.name, m]));

const MODELO_RAIZ = "Workshop";

function tabla(m: Modelo): string {
  return m.dbName ?? m.name;
}

// Nombre de columna real de un campo escalar del modelo.
function columna(m: Modelo, campoNombre: string): string {
  const f = m.fields.find((x) => x.name === campoNombre);
  return f?.dbName ?? campoNombre;
}

// Relaciones "hacia el padre" (many-to-one): objeto, no lista, con FK local.
function padres(m: Modelo): Campo[] {
  return m.fields.filter(
    (f) => f.kind === "object" && !f.isList && (f.relationFromFields?.length ?? 0) > 0,
  );
}

export type TablaTaller = {
  modelo: string;
  tabla: string;
  // Predicado SQL que recorta la tabla al taller. `$1` = id del taller.
  where: string;
};

export type Referencia = {
  // Tabla del taller que apunta hacia afuera.
  desdeTabla: string;
  desdeWhere: string;
  columnaFk: string;
  // Tabla global referenciada.
  haciaModelo: string;
  haciaTabla: string;
  haciaColumna: string;
};

function construir(): { tablas: TablaTaller[]; referencias: Referencia[] } {
  const raiz = POR_NOMBRE.get(MODELO_RAIZ);
  if (!raiz) throw new Error(`El datamodel no tiene el modelo ${MODELO_RAIZ}`);

  const where = new Map<string, string>();
  where.set(MODELO_RAIZ, `"id" = $1`);

  // (1)+(2) FK directa a Workshop.
  for (const m of MODELOS) {
    if (m.name === MODELO_RAIZ) continue;
    const aTaller = padres(m).find((f) => f.type === MODELO_RAIZ);
    if (!aTaller) continue;
    const col = columna(m, aTaller.relationFromFields![0]!);
    where.set(m.name, `"${col}" = $1`);
  }

  // (3) Herencia por padre ya recortado, a punto fijo.
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const m of MODELOS) {
      if (where.has(m.name)) continue;
      const via = padres(m).find((f) => f.isRequired && where.has(f.type));
      if (!via) continue;
      const padre = POR_NOMBRE.get(via.type)!;
      const colLocal = columna(m, via.relationFromFields![0]!);
      const colPadre = columna(padre, via.relationToFields![0]!);
      where.set(
        m.name,
        `"${colLocal}" IN (SELECT "${colPadre}" FROM "${tabla(padre)}" WHERE ${where.get(via.type)})`,
      );
      cambio = true;
    }
  }

  // Orden topológico: un modelo va después de todos los del taller a los que
  // apunta. Con eso el INSERT respeta las FKs reales (workshop_branches antes
  // que appointments) y el DELETE en orden inverso no deja huérfanos.
  const enTaller = [...where.keys()];
  const pendientes = new Set(enTaller);
  const orden: string[] = [];
  while (pendientes.size > 0) {
    const listos = [...pendientes].filter((nombre) => {
      const m = POR_NOMBRE.get(nombre)!;
      return padres(m).every((f) => f.type === nombre || !pendientes.has(f.type));
    });
    // Ciclo (auto-referencia cruzada): se corta metiendo el resto tal cual.
    if (listos.length === 0) {
      orden.push(...pendientes);
      break;
    }
    for (const nombre of listos) {
      orden.push(nombre);
      pendientes.delete(nombre);
    }
  }

  const tablas: TablaTaller[] = orden.map((nombre) => {
    const m = POR_NOMBRE.get(nombre)!;
    return { modelo: nombre, tabla: tabla(m), where: where.get(nombre)! };
  });

  // (4) Referencias: FKs de tablas del taller hacia tablas globales.
  const referencias: Referencia[] = [];
  for (const t of tablas) {
    const m = POR_NOMBRE.get(t.modelo)!;
    for (const f of padres(m)) {
      if (where.has(f.type)) continue;
      const destino = POR_NOMBRE.get(f.type);
      if (!destino) continue;
      referencias.push({
        desdeTabla: t.tabla,
        desdeWhere: t.where,
        columnaFk: columna(m, f.relationFromFields![0]!),
        haciaModelo: f.type,
        haciaTabla: tabla(destino),
        haciaColumna: columna(destino, f.relationToFields![0]!),
      });
    }
  }

  return { tablas, referencias };
}

const grafo = construir();

// Tablas propias del taller, en orden de inserción (borrar en orden inverso).
export const TABLAS_TALLER: TablaTaller[] = grafo.tablas;

// FKs que salen del taller hacia tablas globales (users, vehicles, planes…).
export const REFERENCIAS: Referencia[] = grafo.referencias;

// FKs de una tabla global hacia otra global (vehicles → vehicle_models), para
// arrastrar las referencias de segundo nivel al exportar.
export function referenciasDe(modelo: string): Referencia[] {
  const m = POR_NOMBRE.get(modelo);
  if (!m) return [];
  const propias = new Set(TABLAS_TALLER.map((t) => t.modelo));
  return padres(m)
    .filter((f) => !propias.has(f.type) && POR_NOMBRE.has(f.type))
    .map((f) => {
      const destino = POR_NOMBRE.get(f.type)!;
      return {
        desdeTabla: tabla(m),
        desdeWhere: "",
        columnaFk: columna(m, f.relationFromFields![0]!),
        haciaModelo: f.type,
        haciaTabla: tabla(destino),
        haciaColumna: columna(destino, f.relationToFields![0]!),
      };
    });
}

export function tablaDeModelo(modelo: string): string | null {
  const m = POR_NOMBRE.get(modelo);
  return m ? tabla(m) : null;
}
