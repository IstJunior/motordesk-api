// Respaldos de MotorDesk. Dos alcances, porque la base es de schema único:
//
//   - FULL: `pg_dump -Fc` de toda la base → R2. Es el respaldo de desastre.
//     Requiere los binarios de postgresql-client en la imagen.
//   - TALLER: export lógico recortado por `workshop_id` (ver backup-scope.ts) a
//     JSON comprimido → R2. Restaurable en caliente sobre el mismo taller.
//
// El export de taller separa dos bloques:
//   `tablas`      filas propias del taller: se borran y se reinsertan al restaurar.
//   `referencias` filas de tablas globales (users, vehicles, planes) a las que
//                 apuntan las propias: al restaurar solo se insertan si faltan
//                 (ON CONFLICT DO NOTHING). Nunca se pisan ni se borran.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, unlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { prisma } from "./db.js";
import { uploadR2Object, uploadR2Stream, getR2Buffer, deleteR2Object } from "./r2.js";
import { TABLAS_TALLER, REFERENCIAS, referenciasDe, tablaDeModelo } from "./backup-scope.js";

// pg_dump se conecta directo, no por el pooler (pgbouncer rompe COPY y prepared
// statements). DIRECT_URL es justamente la conexión directa que usa Prisma para
// migrar; si no está, se cae a DATABASE_URL.
function urlDirecta(): string {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
  if (!url) throw new Error("Falta DIRECT_URL/DATABASE_URL para el respaldo");
  return url;
}

function marcaTiempo(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export const VERSION_EXPORT = 1;

// Las filas viajan como TEXTO JSON, no como objetos ya parseados. Es a propósito:
// `to_jsonb` serializa `numeric` y `int8` como números JSON, y si JavaScript los
// parsea pasan por un float64 (precisión de ~15-17 dígitos). Manteniendo el texto
// tal cual sale de Postgres y devolviéndolo a `$1::jsonb` sin tocarlo, el valor
// que vuelve es exactamente el que salió.
export type BloqueTabla = { tabla: string; filas: number; json: string };

export type ExportTaller = {
  version: number;
  workshopId: string;
  workshopCode: string | null;
  generadoEn: string;
  // Filas propias del taller, en orden de inserción.
  tablas: BloqueTabla[];
  // Filas de tablas globales referenciadas, en orden de dependencia.
  referencias: BloqueTabla[];
};

// ---------------------------------------------------------------------------
// FULL
// ---------------------------------------------------------------------------

// Comprueba que pg_dump exista antes de prometerle un respaldo a nadie.
export async function pgDumpDisponible(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("pg_dump", ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

// Dump completo de la base a un archivo temporal y de ahí a R2. Se pasa por
// disco (y no por stream directo) porque PutObject necesita ContentLength.
async function dumpFullAR2(key: string): Promise<number> {
  const tmp = join(tmpdir(), `md-full-${randomUUID()}.dump`);
  try {
    const destino = await open(tmp, "w");
    const salidaArchivo = destino.createWriteStream();
    const dump = spawn("pg_dump", [urlDirecta(), "--no-owner", "--no-privileges", "-Fc"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    dump.stderr.on("data", (d) => (stderr += d.toString()));
    dump.stdout.pipe(salidaArchivo);

    const codigo = await new Promise<number>((res, rej) => {
      dump.on("error", rej);
      salidaArchivo.on("error", rej);
      salidaArchivo.on("close", () => dump.on("close", res));
      dump.on("close", (c) => salidaArchivo.end(() => res(c ?? 1)));
    });
    await destino.close().catch(() => {});
    if (codigo !== 0) throw new Error(`pg_dump falló (código ${codigo}): ${stderr.slice(0, 500)}`);

    const { size } = await stat(tmp);
    if (size === 0) throw new Error("pg_dump produjo un archivo vacío");
    await uploadR2Stream(key, createReadStream(tmp), size);
    return size;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// TALLER — export
// ---------------------------------------------------------------------------

// Vuelca varias tablas ya recortadas a texto JSON en UNA sola consulta: cada
// tabla es una rama del UNION ALL. Contra una base remota la diferencia es
// grande (39 idas y vueltas → 1). El `::text` es lo que evita que el driver
// parsee los números (ver nota en BloqueTabla).
//
// Los nombres de tabla salen del datamodel de Prisma, no de la petición, así que
// interpolarlos no abre inyección; el único parámetro es el id del taller.
async function volcarLote(
  entradas: { tabla: string; where: string }[],
  id: bigint,
): Promise<BloqueTabla[]> {
  if (entradas.length === 0) return [];
  const ramas = entradas.map(
    (e) =>
      `SELECT '${e.tabla}' AS tabla, count(*) AS filas,
              COALESCE(jsonb_agg(to_jsonb(f)), '[]'::jsonb)::text AS json
       FROM "${e.tabla}" f WHERE ${e.where}`,
  );
  const filas = await prisma.$queryRawUnsafe<{ tabla: string; filas: bigint; json: string }[]>(
    ramas.join(" UNION ALL "),
    id,
  );
  const porTabla = new Map(filas.map((f) => [f.tabla, f]));
  // Se reordena según `entradas`: UNION ALL no garantiza el orden y aquí el
  // orden ES el de inserción.
  return entradas.map((e) => {
    const f = porTabla.get(e.tabla);
    return { tabla: e.tabla, filas: Number(f?.filas ?? 0), json: f?.json ?? "[]" };
  });
}

// Predicado de cada tabla global: el conjunto de filas alcanzables desde el
// taller. Se construye a punto fijo y en SQL puro, así la cascada
// (appointments → vehicles → vehicle_models → users) no pasa por JavaScript.
function predicadosReferencias(): { modelo: string; tabla: string; where: string }[] {
  const fuentes = new Map<string, { tabla: string; columna: string; sql: Set<string> }>();

  const agregar = (
    modelo: string,
    tabla: string,
    columna: string,
    desdeTabla: string,
    desdeWhere: string,
    columnaFk: string,
  ) => {
    const actual = fuentes.get(modelo) ?? { tabla, columna, sql: new Set<string>() };
    actual.sql.add(
      `SELECT "${columnaFk}" FROM "${desdeTabla}" WHERE ${desdeWhere} AND "${columnaFk}" IS NOT NULL`,
    );
    fuentes.set(modelo, actual);
  };

  // Nivel 1: desde las tablas del taller.
  for (const r of REFERENCIAS) {
    agregar(r.haciaModelo, r.haciaTabla, r.haciaColumna, r.desdeTabla, r.desdeWhere, r.columnaFk);
  }

  const where = (m: string) => {
    const f = fuentes.get(m)!;
    return `"${f.columna}" IN (${[...f.sql].join(" UNION ")})`;
  };

  // Niveles siguientes: FKs entre tablas globales. Tope de vueltas por si el
  // grafo tuviera un ciclo.
  for (let vuelta = 0; vuelta < 5; vuelta++) {
    let cambio = false;
    for (const modelo of [...fuentes.keys()]) {
      const origen = fuentes.get(modelo)!;
      for (const r of referenciasDe(modelo)) {
        const antes = fuentes.get(r.haciaModelo)?.sql.size ?? -1;
        agregar(
          r.haciaModelo,
          r.haciaTabla,
          r.haciaColumna,
          origen.tabla,
          where(modelo),
          r.columnaFk,
        );
        if ((fuentes.get(r.haciaModelo)?.sql.size ?? 0) !== antes) cambio = true;
      }
    }
    if (!cambio) break;
  }

  // Orden de inserción: primero aquello de lo que otros dependen
  // (vehicle_models y users antes que vehicles).
  const modelos = [...fuentes.keys()];
  const pendientes = new Set(modelos);
  const orden: string[] = [];
  while (pendientes.size > 0) {
    const listos = modelos.filter(
      (m) =>
        pendientes.has(m) &&
        referenciasDe(m).every((r) => r.haciaModelo === m || !pendientes.has(r.haciaModelo)),
    );
    if (listos.length === 0) {
      orden.push(...pendientes);
      break;
    }
    for (const m of listos) {
      orden.push(m);
      pendientes.delete(m);
    }
  }

  return orden.map((m) => ({ modelo: m, tabla: fuentes.get(m)!.tabla, where: where(m) }));
}

const REFERENCIAS_WHERE = predicadosReferencias();

export async function exportarTaller(id: bigint): Promise<ExportTaller> {
  const taller = await prisma.workshop.findUnique({ where: { id }, select: { code: true } });
  if (!taller) throw new Error(`El taller ${id} no existe`);

  const [tablas, referencias] = await Promise.all([
    volcarLote(TABLAS_TALLER, id),
    volcarLote(REFERENCIAS_WHERE, id),
  ]);

  return {
    version: VERSION_EXPORT,
    workshopId: id.toString(),
    workshopCode: taller.code ?? null,
    generadoEn: new Date().toISOString(),
    tablas,
    referencias,
  };
}

// ---------------------------------------------------------------------------
// TALLER — restore
// ---------------------------------------------------------------------------

// Reinserta filas desde JSON. `jsonb_populate_record` hace la conversión de
// tipos (fechas, numeric, jsonb, bigint) contra el rowtype real de la tabla, así
// que no hay que mapear columnas a mano.
async function insertar(
  tx: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> },
  bloque: BloqueTabla,
  siFalta: boolean,
): Promise<number> {
  if (bloque.filas === 0) return 0;
  const conflicto = siFalta ? " ON CONFLICT DO NOTHING" : "";
  // `bloque.json` va tal cual al parámetro: nunca se parsea en JavaScript.
  return tx.$executeRawUnsafe(
    `INSERT INTO "${bloque.tabla}"
     SELECT (jsonb_populate_record(NULL::"${bloque.tabla}", f)).*
     FROM jsonb_array_elements($1::jsonb) AS f${conflicto}`,
    bloque.json,
  );
}

// Deja las secuencias por encima del mayor id vivo: si no, el siguiente INSERT
// natural chocaría contra los ids reinsertados.
async function ajustarSecuencias(
  tx: {
    $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number>;
  },
  tablas: string[],
): Promise<void> {
  const seriales = await tx.$queryRawUnsafe<{ tabla: string; columna: string }[]>(
    `SELECT table_name AS tabla, column_name AS columna
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])
       AND column_default LIKE 'nextval(%'`,
    tablas,
  );
  for (const s of seriales) {
    await tx.$executeRawUnsafe(
      `SELECT setval(
         pg_get_serial_sequence('"${s.tabla}"', '${s.columna}'),
         GREATEST(COALESCE((SELECT MAX("${s.columna}") FROM "${s.tabla}"), 0), 1)
       )`,
    );
  }
}

export type ResultadoRestore = {
  ensayo: boolean;
  tablas: { tabla: string; borradas: number; insertadas: number }[];
  referencias: { tabla: string; insertadas: number }[];
};

// Se lanza al final de un ensayo para que Postgres deshaga la transacción.
class Ensayo extends Error {
  constructor() {
    super("ensayo");
  }
}

// DESTRUCTIVO: borra TODAS las filas del taller y las reemplaza por las del
// respaldo. Todo dentro de una transacción: si algo falla, no se pierde nada.
//
// Con `ensayo: true` ejecuta exactamente lo mismo y luego deshace la
// transacción: sirve para ver cuántas filas se borrarían e insertarían, y para
// que un respaldo corrupto reviente sin haber tocado nada.
export async function restaurarTaller(
  id: bigint,
  datos: ExportTaller,
  opciones: { ensayo?: boolean } = {},
): Promise<ResultadoRestore> {
  if (datos.version !== VERSION_EXPORT) {
    throw new Error(`Versión de respaldo no soportada: ${datos.version}`);
  }
  if (datos.workshopId !== id.toString()) {
    throw new Error(
      `El respaldo es del taller ${datos.workshopId} y se intenta restaurar sobre el ${id}. ` +
        "Restaurar datos de un taller sobre otro no está permitido.",
    );
  }

  const ensayo = opciones.ensayo === true;
  const porTabla = new Map(datos.tablas.map((t) => [t.tabla, t]));
  const resultado: ResultadoRestore = { ensayo, tablas: [], referencias: [] };

  try {
    await prisma.$transaction(
      async (tx) => {
      // 1) Referencias globales primero: las filas propias apuntan a ellas.
      for (const r of datos.referencias) {
        const insertadas = await insertar(tx, r, true);
        resultado.referencias.push({ tabla: r.tabla, insertadas });
      }

      // 2) Borrado en orden inverso al de inserción (hijos antes que padres).
      const borradas = new Map<string, number>();
      for (const t of [...TABLAS_TALLER].reverse()) {
        const n = await tx.$executeRawUnsafe(`DELETE FROM "${t.tabla}" WHERE ${t.where}`, id);
        borradas.set(t.tabla, n);
      }

      // 3) Reinserción en orden de dependencia.
      for (const t of TABLAS_TALLER) {
        const bloque = porTabla.get(t.tabla) ?? { tabla: t.tabla, filas: 0, json: "[]" };
        const insertadas = await insertar(tx, bloque, false);
        resultado.tablas.push({
          tabla: t.tabla,
          borradas: borradas.get(t.tabla) ?? 0,
          insertadas,
        });
      }

        // 4) Secuencias al día (propias + referencias tocadas).
        await ajustarSecuencias(tx, [
          ...TABLAS_TALLER.map((t) => t.tabla),
          ...datos.referencias.map((r) => r.tabla),
        ]);

        // 5) Ensayo: todo lo anterior se deshace al salir por excepción.
        if (ensayo) throw new Ensayo();
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
  } catch (e) {
    if (!(e instanceof Ensayo)) throw e;
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Registro en backup_records
// ---------------------------------------------------------------------------

export type TipoBackup = "manual" | "programado";

// Corre un respaldo full dejando rastro en `backup_records` pase lo que pase.
export async function ejecutarBackupFull(tipo: TipoBackup): Promise<{
  id: string;
  objectKey: string;
  sizeBytes: number;
}> {
  const objectKey = `full/${marcaTiempo()}-${tipo}.dump`;
  const registro = await prisma.backupRecord.create({
    data: { scope: "full", status: "running", objectKey },
    select: { id: true },
  });

  try {
    const sizeBytes = await dumpFullAR2(objectKey);
    await prisma.backupRecord.update({
      where: { id: registro.id },
      data: { status: "done", sizeBytes: BigInt(sizeBytes), completedAt: new Date() },
    });
    return { id: registro.id, objectKey, sizeBytes };
  } catch (e) {
    await prisma.backupRecord.update({
      where: { id: registro.id },
      data: {
        status: "failed",
        failureReason: e instanceof Error ? e.message : String(e),
        completedAt: new Date(),
      },
    });
    throw e;
  }
}

// Respaldo lógico de UN taller. `scope` guarda "workshop:<id>" porque
// backup_records no tiene columna propia de taller.
export async function ejecutarBackupTaller(
  id: bigint,
  tipo: TipoBackup,
): Promise<{ id: string; objectKey: string; sizeBytes: number; filas: number }> {
  const taller = await prisma.workshop.findUnique({
    where: { id },
    select: { code: true, name: true },
  });
  if (!taller) throw new Error(`El taller ${id} no existe`);

  const carpeta = (taller.code ?? `id-${id}`).replace(/[^a-zA-Z0-9_-]/g, "-");
  const objectKey = `talleres/${carpeta}/${marcaTiempo()}-${tipo}.json.gz`;
  const registro = await prisma.backupRecord.create({
    data: { scope: `workshop:${id}`, status: "running", objectKey },
    select: { id: true },
  });

  try {
    const datos = await exportarTaller(id);
    const comprimido = gzipSync(Buffer.from(JSON.stringify(datos), "utf8"));
    await uploadR2Object(objectKey, comprimido, "application/gzip");
    await prisma.backupRecord.update({
      where: { id: registro.id },
      data: { status: "done", sizeBytes: BigInt(comprimido.length), completedAt: new Date() },
    });
    const filas = datos.tablas.reduce((n, t) => n + t.filas, 0);
    return { id: registro.id, objectKey, sizeBytes: comprimido.length, filas };
  } catch (e) {
    await prisma.backupRecord.update({
      where: { id: registro.id },
      data: {
        status: "failed",
        failureReason: e instanceof Error ? e.message : String(e),
        completedAt: new Date(),
      },
    });
    throw e;
  }
}

// Lee y descomprime un export de taller guardado en R2.
export async function leerExportTaller(objectKey: string): Promise<ExportTaller> {
  const bruto = await getR2Buffer(objectKey);
  const texto = objectKey.endsWith(".gz") ? gunzipSync(bruto).toString("utf8") : bruto.toString("utf8");
  return JSON.parse(texto) as ExportTaller;
}

// Purga: deja los `retener` respaldos `done` más recientes de un alcance y borra
// el resto (objeto en R2 + registro). Los `failed` se limpian aparte por edad.
export async function purgar(scope: string, retener: number): Promise<number> {
  const sobrantes = await prisma.backupRecord.findMany({
    where: { scope, status: "done" },
    orderBy: { createdAt: "desc" },
    skip: retener,
    select: { id: true, objectKey: true },
  });
  for (const s of sobrantes) {
    await deleteR2Object(s.objectKey).catch(() => {});
    await prisma.backupRecord.delete({ where: { id: s.id } }).catch(() => {});
  }
  return sobrantes.length;
}

export function streamDesdeBuffer(buf: Buffer): Readable {
  return Readable.from(buf);
}
