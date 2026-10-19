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

/** La empresa dueña de las credenciales, según Factus: a nombre de quién factura. */
export type EmpresaFactus = {
  nit: string;
  dv: string | null;
  nombre: string;
  tipoPersona: "natural" | "juridica";
};

export type ResultadoDePrueba =
  | { ok: true; ambiente: Ambiente; rangos: Rango[]; empresa: EmpresaFactus | null }
  | { ok: false; error: string };

/**
 * `GET /v2/companies`: el NIT, DV y nombre de la empresa de esas credenciales.
 *
 * MotorDesk no le dice a Factus a nombre de quién facturar: factura la empresa
 * dueña de las credenciales. Por eso el emisor se lee de aquí y no se teclea,
 * y por eso compararlo con el NIT del taller es lo que delata unas
 * credenciales pegadas en el taller equivocado.
 *
 * `null` si no responde: una prueba de conexión no falla por esto.
 */
async function empresaConToken(cred: Credenciales, acceso: string): Promise<EmpresaFactus | null> {
  try {
    const r = await fetch(`${BASES[cred.ambiente]}/v2/companies`, {
      headers: { Authorization: `Bearer ${acceso}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const d = j?.data;
    if (!d?.nit) return null;
    const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const organizacion = (d.legal_organization as { code?: string } | undefined)?.code;
    const nombre =
      texto(d.company) ||
      [texto(d.names), texto(d.surnames)].filter(Boolean).join(" ") ||
      texto(d.graphic_representation_name) ||
      texto(d.trade_name);
    return {
      nit: String(d.nit).replace(/\D/g, ""),
      dv: d.dv === null || d.dv === undefined || d.dv === "" ? null : String(d.dv),
      nombre,
      // En la tabla de Factus: 1 = persona jurídica, 2 = persona natural.
      tipoPersona: String(organizacion) === "1" ? "juridica" : "natural",
    };
  } catch {
    return null;
  }
}

/** La empresa de unas credenciales, pidiendo su propio token. */
export async function empresaDeFactus(cred: Credenciales): Promise<EmpresaFactus | null> {
  try {
    return await empresaConToken(cred, await token(cred));
  } catch {
    return null;
  }
}

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
    return { ok: true, ambiente: cred.ambiente, rangos, empresa: await empresaConToken(cred, acceso) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo contactar a Factus." };
  }
}

/** Lo que Factus dice que lleva gastado un NIT: su suscripción vigente. */
export type SuscripcionFactus = {
  nombre: string;
  asignados: number;
  consumidos: number;
  disponibles: number;
  activadaEl: string | null;
  venceEl: string | null;
  vencida: boolean;
  activa: boolean;
  ilimitada: boolean;
};

/**
 * `GET /v2/subscriptions`: las suscripciones activas del NIT de esas
 * credenciales, con sus documentos asignados, consumidos y disponibles.
 *
 * Sirve para comparar el conteo de MotorDesk con el del proveedor. En el
 * sandbox responde la cuenta compartida de Factus (un millón de documentos),
 * no la del taller: solo en producción la comparación significa algo.
 */
export async function consultarSuscripciones(
  cred: Credenciales,
): Promise<{ ok: true; suscripciones: SuscripcionFactus[] } | { ok: false; error: string }> {
  try {
    const acceso = await token(cred);
    const r = await fetch(`${BASES[cred.ambiente]}/v2/subscriptions`, {
      headers: { Authorization: `Bearer ${acceso}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => null)) as { data?: Record<string, unknown>[]; message?: string } | null;
    if (!r.ok) return { ok: false, error: j?.message || `Factus respondió HTTP ${r.status}.` };
    const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
    const texto = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      ok: true,
      suscripciones: (j?.data ?? []).map((s) => ({
        nombre: String(s.name ?? ""),
        asignados: num(s.documents_quota),
        consumidos: num(s.documents_consumed),
        disponibles: num(s.documents_available),
        activadaEl: texto(s.activated_at),
        venceEl: texto(s.expires_at),
        vencida: siNo(s.has_expired),
        activa: siNo(s.is_active),
        ilimitada: siNo(s.has_unlimited_quota),
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo consultar Factus." };
  }
}
