import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chown, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

// La biblioteca de manuales vive en el disco del servidor, no en R2.
//
// Es la misma carpeta que lee el panel de los talleres (el monolito la monta en
// /app/manuales y de ahí saca el catálogo y los archivos). R2 quedó como
// contingencia y está atrasado a propósito: 168 objetos de mayo contra 1.299
// manuales en disco. El superadmin leía y escribía en R2, así que veía una
// biblioteca vieja y lo que subía nunca llegaba a los talleres.
//
// La convención del nombre es la misma de `src/lib/r2-parser.ts` del monolito,
// y no es decorativa: un archivo que no la cumple se descarta sin avisar.
//
//   Manuales Colombia Top/{Marca}/{Modelo}/{id4} - {Modelo} - {Tipo}[ - {año}].pdf

export const RAIZ = process.env.MANUALES_DIR ?? "/app/manuales";
export const PREFIJO = "Manuales Colombia Top";
export const TIPOS_DE_MANUAL = ["Taller", "Partes", "Usuario", "Guia"] as const;
export type TipoDeManual = (typeof TIPOS_DE_MANUAL)[number];

export class ManualError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

export type ManualEnDisco = {
  id: string;
  key: string;
  title: string;
  brand: string;
  model: string;
  year: number | null;
  category: TipoDeManual;
  fileSize: number;
  lastModified: string;
  internalId: string;
};

function esTipo(valor: string): TipoDeManual | null {
  return TIPOS_DE_MANUAL.find((t) => t.toLowerCase() === valor.trim().toLowerCase()) ?? null;
}

/** Misma lectura que `parseR2ManualKey` del monolito. */
export function leerLlave(key: string, size: number, mtime: Date): ManualEnDisco | null {
  if (!key.toLowerCase().endsWith(".pdf")) return null;
  const partes = key.split("/");
  if (partes.length < 4 || partes[0] !== PREFIJO) return null;
  const brand = partes[1] || "Desconocido";
  const carpetaModelo = partes[2] || "";
  const segmentos = (partes[partes.length - 1] ?? "").replace(/\.pdf$/i, "").split(" - ");
  const internalId = segmentos[0]?.trim() ?? "";
  const ultimo = segmentos[segmentos.length - 1]?.trim() ?? "";
  const year = /^\d{4}$/.test(ultimo) ? Number(ultimo) : null;
  let iTipo = -1;
  for (let i = segmentos.length - 1; i > 0; i--) {
    if (esTipo(segmentos[i] ?? "")) {
      iTipo = i;
      break;
    }
  }
  const tipo = iTipo > 0 ? esTipo(segmentos[iTipo] ?? "")! : "Taller";
  const model = (iTipo > 1 ? segmentos.slice(1, iTipo).join(" - ").trim() : "") || carpetaModelo;
  return {
    id: key,
    key,
    title: `${model} - ${tipo === "Guia" ? "Guía" : tipo}${year ? ` ${year}` : ""}`,
    brand,
    model,
    year,
    category: tipo,
    fileSize: size,
    lastModified: mtime.toISOString(),
    internalId,
  };
}

/** La ruta en disco de una llave, o null si se sale de la biblioteca. */
export function rutaDe(key: string): string | null {
  const completa = normalize(join(RAIZ, key));
  if (!completa.startsWith(join(RAIZ, PREFIJO) + sep)) return null;
  return completa;
}

export async function discoDisponible(): Promise<boolean> {
  try {
    return (await stat(join(RAIZ, PREFIJO))).isDirectory();
  } catch {
    return false;
  }
}

async function exigirDisco() {
  if (!(await discoDisponible())) {
    throw new ManualError(
      `La API no ve la biblioteca de manuales (${RAIZ}). Falta montar el disco /home/deployer/manuales en el contenedor.`,
      503,
    );
  }
}

const TTL_MS = 5 * 60 * 1000;
let cache: { vence: number; manuales: ManualEnDisco[] } | null = null;

export function olvidarCatalogo() {
  cache = null;
}

/** Todo el catálogo, recorriendo las carpetas. Cinco minutos en caché. */
export async function catalogo(): Promise<ManualEnDisco[]> {
  await exigirDisco();
  if (cache && cache.vence > Date.now()) return cache.manuales;
  const encontrados: ManualEnDisco[] = [];
  const recorrer = async (dir: string) => {
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const completa = join(dir, e.name);
      if (e.isDirectory()) {
        await recorrer(completa);
        continue;
      }
      if (!e.name.toLowerCase().endsWith(".pdf")) continue;
      try {
        const s = await stat(completa);
        const m = leerLlave(completa.slice(RAIZ.length + 1), s.size, s.mtime);
        if (m) encontrados.push(m);
      } catch {
        // desapareció entre el listado y el stat
      }
    }
  };
  await recorrer(join(RAIZ, PREFIJO));
  encontrados.sort(
    (a, b) => a.brand.localeCompare(b.brand, "es") || a.model.localeCompare(b.model, "es", { numeric: true }),
  );
  cache = { vence: Date.now() + TTL_MS, manuales: encontrados };
  return encontrados;
}

function md5(ruta: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(ruta)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

// Lo que el superadmin escribe va a nombre del dueño de la biblioteca. Cuando
// la API corría como root, sin esto las carpetas nuevas quedaban de root y el
// importador (que corre como el usuario del servidor) ya no podía escribir en
// ellas. Hoy corre con el UID del dueño (ver Dockerfile) y esto no cambia
// nada, pero protege si alguna vez vuelve a correr con otro usuario.
async function comoLaBiblioteca(ruta: string) {
  try {
    const s = await stat(RAIZ);
    await chown(ruta, s.uid, s.gid);
  } catch {
    // sin permiso para cambiar dueño: el archivo igual queda legible
  }
}

/** Busca una carpeta existente sin distinguir mayúsculas: "yamaha" es "Yamaha". */
async function carpetaExistente(dentroDe: string, nombre: string): Promise<string> {
  try {
    const hijas = await readdir(dentroDe, { withFileTypes: true });
    const igual = hijas.find((h) => h.isDirectory() && h.name.toLowerCase() === nombre.toLowerCase());
    if (igual) return igual.name;
  } catch {
    // no existe todavía
  }
  return nombre;
}

function limpio(valor: string): string {
  // " - " es el separador de la convención: dentro de un nombre lo rompería.
  return valor
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function subirManual(input: {
  contenido: Buffer;
  marca: string;
  modelo: string;
  tipo: string;
  anio: number | null;
}): Promise<ManualEnDisco> {
  await exigirDisco();
  const marca = limpio(input.marca);
  const modelo = limpio(input.modelo);
  if (!marca || !modelo) throw new ManualError("Marca y modelo son obligatorios.");
  const tipo = esTipo(input.tipo) ?? "Taller";

  const todos = await catalogo();

  // El mismo PDF ya está en la biblioteca, se llame como se llame: no se
  // duplica. Se comparan solo los del mismo tamaño, que son pocos o ninguno.
  const huella = createHash("md5").update(input.contenido).digest("hex");
  for (const m of todos.filter((x) => x.fileSize === input.contenido.byteLength)) {
    const ruta = rutaDe(m.key);
    if (ruta && (await md5(ruta).catch(() => "")) === huella) {
      throw new ManualError(`Ese PDF ya está en la biblioteca como "${m.brand} · ${m.title}".`, 409);
    }
  }

  // El id sigue la numeración de la biblioteca: el siguiente al mayor.
  const mayor = todos.reduce((max, m) => Math.max(max, Number(m.internalId) || 0), 0);
  const id = String(mayor + 1).padStart(4, "0");

  const base = join(RAIZ, PREFIJO);
  const dirMarca = await carpetaExistente(base, marca);
  const dirModelo = await carpetaExistente(join(base, dirMarca), modelo);
  const carpeta = join(base, dirMarca, dirModelo);
  const nombre = `${id} - ${modelo} - ${tipo}${input.anio ? ` - ${input.anio}` : ""}.pdf`;
  const destino = join(carpeta, nombre);

  await mkdir(carpeta, { recursive: true });
  await comoLaBiblioteca(join(base, dirMarca));
  await comoLaBiblioteca(carpeta);
  // Se escribe a un temporal y se renombra: el panel nunca ve un PDF a medias.
  const temporal = `${destino}.subiendo`;
  await writeFile(temporal, input.contenido);
  await rename(temporal, destino);
  await comoLaBiblioteca(destino);

  olvidarCatalogo();
  const s = await stat(destino);
  return leerLlave(destino.slice(RAIZ.length + 1), s.size, s.mtime)!;
}

export async function borrarManual(key: string): Promise<void> {
  await exigirDisco();
  const ruta = rutaDe(key);
  if (!ruta || !ruta.toLowerCase().endsWith(".pdf")) throw new ManualError("Manual no válido.");
  try {
    await rm(ruta);
  } catch {
    throw new ManualError("Ese manual ya no está en la biblioteca.", 404);
  }
  // La carpeta del modelo, si quedó vacía, también se va: si no, el panel
  // listaría un modelo sin manuales.
  const carpeta = ruta.slice(0, ruta.lastIndexOf(sep));
  const vaciada = await rmdir(carpeta).then(() => true).catch(() => false);
  // Y la de la marca, si era su último modelo.
  if (vaciada) await rmdir(carpeta.slice(0, carpeta.lastIndexOf(sep))).catch(() => {});
  olvidarCatalogo();
}
