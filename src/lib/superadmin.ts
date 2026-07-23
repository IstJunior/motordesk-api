import { SignJWT, jwtVerify } from "jose";

// Auth de superadmin propia del sistema (estilo SmartPOS): credencial por env,
// login contra la API que emite su propio JWT. NO depende de Supabase/Google.
//
// Envs:
//   SUPERADMIN_USER       usuario (ej. IstJuniorX)
//   SUPERADMIN_PASSWORD   contraseña
//   SUPERADMIN_JWT_SECRET secreto para firmar el token del panel
const USER = process.env.SUPERADMIN_USER ?? "";
const PASSWORD = process.env.SUPERADMIN_PASSWORD ?? "";
const secret = new TextEncoder().encode(process.env.SUPERADMIN_JWT_SECRET ?? "");

export function superadminConfigurado(): boolean {
  return Boolean(USER && PASSWORD && process.env.SUPERADMIN_JWT_SECRET);
}

// Verifica credencial (comparación normalizada del usuario, password exacto).
export function credencialValida(username: string, password: string): boolean {
  if (!superadminConfigurado()) return false;
  return username.trim().toLowerCase() === USER.toLowerCase() && password === PASSWORD;
}

export async function firmarToken(): Promise<string> {
  return new SignJWT({ role: "superadmin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
}

// Devuelve el usuario si el token de superadmin es válido, o null.
export async function verificarToken(token: string): Promise<{ user: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.role !== "superadmin" || typeof payload.sub !== "string") return null;
    return { user: payload.sub };
  } catch {
    return null;
  }
}
