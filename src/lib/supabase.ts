import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

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

// Devuelve el auth uid (sub) del token, o null si inválido.
export async function resolverAuthUid(accessToken: string): Promise<string | null> {
  try {
    if (hsKey) {
      const { payload } = await jwtVerify(accessToken, hsKey);
      return typeof payload.sub === "string" ? payload.sub : null;
    }
    const set = getJwks();
    if (!set) return null;
    const { payload } = await jwtVerify(accessToken, set);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
