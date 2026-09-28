// Probar las credenciales de Factus desde el panel del proveedor.
//
// Es a propósito un módulo chico y sin estado: acá no se factura, solo se
// comprueba que las credenciales sirven y se listan los rangos de numeración
// que la DIAN le autorizó a ese taller. La emisión vive en el monolito
// (src/lib/facturacion/factus.ts) y no se duplica.
//
// El token no se cachea: una prueba manual al año no vale un token guardado, y
// guardarlo desde acá competiría con el que cachea el monolito.

const BASES = {
  sandbox: "https://api-sandbox.factus.com.co",
  production: "https://api.factus.com.co",
} as const;

export type Ambiente = keyof typeof BASES;

export type Credenciales = {
  ambiente: Ambiente;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
};

export type Rango = {
  id: number;
  documento: string;
  prefijo: string;
  desde: number;
  hasta: number;
  actual: number;
  resolucion: string | null;
  activo: boolean;
  vencido: boolean;
};

export type ResultadoDePrueba =
  | { ok: true; ambiente: Ambiente; rangos: Rango[] }
  | { ok: false; error: string };

const siNo = (v: unknown) => v === 1 || v === true;

async function token(cred: Credenciales): Promise<string> {
  // El cuerpo va como formulario, no como JSON: con JSON responde 401 sin
  // explicar por qué.
  const r = await fetch(`${BASES[cred.ambiente]}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      username: cred.username,
      password: cred.password,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => null)) as { access_token?: string; message?: string } | null;
  if (!r.ok || !j?.access_token) {
    throw new Error(j?.message || `Factus rechazó las credenciales (HTTP ${r.status}).`);
  }
  return j.access_token;
}

export async function probarConexion(cred: Credenciales): Promise<ResultadoDePrueba> {
  try {
    const acceso = await token(cred);
    // `per_page` alto a propósito: la respuesta pagina de a 10 y un taller con
    // varias resoluciones dejaría fuera justo la que busca. El arreglo viene en
    // `data.data`, no en `data`.
    const r = await fetch(`${BASES[cred.ambiente]}/v2/numbering-ranges?per_page=100`, {
      headers: { Authorization: `Bearer ${acceso}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => null)) as
      | { data?: { data?: Record<string, unknown>[] }; message?: string }
      | null;
    if (!r.ok) return { ok: false, error: j?.message || `Factus respondió HTTP ${r.status}.` };

    const rangos: Rango[] = (j?.data?.data ?? []).map((f) => ({
      id: Number(f.id),
      // Viene como NOMBRE ("Factura de Venta"), no como código.
      documento: String(f.document ?? ""),
      prefijo: String(f.prefix ?? ""),
      // Las notas crédito y débito vienen con `from`/`to` nulos: solo la factura
      // y el documento soporte llevan resolución de la DIAN.
      desde: Number(f.from ?? 0),
      hasta: Number(f.to ?? 0),
      actual: Number(f.current ?? 0),
      resolucion: (f.resolution_number as string) || null,
      activo: siNo(f.is_active),
      vencido: siNo(f.is_expired),
    }));
    return { ok: true, ambiente: cred.ambiente, rangos };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo contactar a Factus." };
  }
}
