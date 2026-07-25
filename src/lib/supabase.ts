import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

// Valida el access token de Supabase localmente (sin llamada de red ni supabase-js).
// Soporta:
//   - HS256 con SUPABASE_JWT_SECRET (legacy symmetric).
//   - Asimétrico vía JWKS de Supabase (SUPABASE_URL/auth/v1/.well-known/jwks.json).
const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";

let hsKey: Uint8Array | null = JWT_SECRET ? new TextEncoder().encode(JWT_SECRET) : null;
let jwks: JWTVerifyGetKey | null = null;
function getJwks(): JWTVerifyGetKey | null {
  if (!SUPABASE_URL) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

if (!hsKey && !SUPABASE_URL) {
  console.warn("[auth] Falta SUPABASE_JWT_SECRET o SUPABASE_URL — la validación de token fallará.");
}

export type SupabaseAuthClaims = {
  authUid: string;
  email: string | null;
};

async function verificar(accessToken: string): Promise<JWTPayload | null> {
  try {
    const { alg } = decodeProtectedHeader(accessToken);
    if (alg === "HS256") {
      if (!hsKey) return null;
      const { payload } = await jwtVerify(accessToken, hsKey, {
        ...(SUPABASE_URL ? { issuer: `${SUPABASE_URL}/auth/v1` } : {}),
        audience: "authenticated",
      });
      return payload;
    }
    const set = getJwks();
    if (!set) return null;
    const { payload } = await jwtVerify(accessToken, set, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
    });
    return payload;
  } catch {
    return null;
  }
}

// Devuelve únicamente identidad autenticada por Supabase. Los permisos y el
// taller se resuelven después contra la base de datos; nunca desde user_metadata.
export async function resolverAuthClaims(accessToken: string): Promise<SupabaseAuthClaims | null> {
  const payload = await verificar(accessToken);
  if (!payload || payload.role !== "authenticated" || typeof payload.sub !== "string") return null;
  return {
    authUid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

// Compatibilidad con los guards existentes del control-plane.
export async function resolverAuthUid(accessToken: string): Promise<string | null> {
  return (await resolverAuthClaims(accessToken))?.authUid ?? null;
}
