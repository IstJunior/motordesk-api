// Probar el token de Nextpyme desde el panel del proveedor.
//
// Como `factus-probe.ts`: chico y sin estado. Acá no se factura; la emisión
// vive en el monolito (src/lib/facturacion/nextpyme.ts) y no se duplica.
//
// Se pide la tabla maestra porque valida el token y, de paso, trae el catálogo
// de unidades contra el que se cotejan los ids que manda MotorDesk. La forma de
// esa respuesta no está documentada, así que el catálogo se busca por nombre en
// vez de suponer una ruta. (verificar con credenciales de habilitación)

/**
 * Los `unit_measure_id` que el monolito puede mandar hoy. Copia a mano de
 * `idsNextpymeQueUsamos()` en src/lib/facturacion/unidades-dian.ts: si allá se
 * coteja una unidad nueva, se agrega acá.
 */
const UNIDADES_QUE_MANDA_MOTORDESK = [70];

export type ResultadoDePruebaNextpyme =
  | { ok: true; unidadesSinCotejar: string[] }
  | { ok: false; error: string };

function buscarCatalogo(json: unknown, nombre: RegExp): unknown[] {
  if (!json || typeof json !== "object") return [];
  for (const [clave, valor] of Object.entries(json as Record<string, unknown>)) {
    if (nombre.test(clave) && Array.isArray(valor)) return valor;
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      const hondo = buscarCatalogo(valor, nombre);
      if (hondo.length) return hondo;
    }
  }
  return [];
}

export async function probarConexionNextpyme(cred: { baseUrl: string; token: string }): Promise<ResultadoDePruebaNextpyme> {
  let r: Response;
  try {
    r = await fetch(`${cred.baseUrl.replace(/\/+$/, "")}/reports/master/database`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "No se pudo contactar a Nextpyme. Revisa la URL." };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, error: "Nextpyme rechazó el token." };
  if (r.status === 404) return { ok: false, error: "La URL no es la de la API de Nextpyme (respondió 404)." };
  if (!r.ok) return { ok: false, error: `Nextpyme respondió HTTP ${r.status}.` };

  const json = await r.json().catch(() => null);
  const unidades = buscarCatalogo(json, /unit/i);
  const ids = new Set(unidades.map((u) => Number((u as { id?: unknown }).id)));
  // Sin catálogo a la vista no se puede cotejar: se reportan todas como
  // pendientes antes que dar por buenas unas que nadie miró.
  const sinCotejar = UNIDADES_QUE_MANDA_MOTORDESK.filter((id) => unidades.length === 0 || !ids.has(id));
  return { ok: true, unidadesSinCotejar: sinCotejar.map(String) };
}
