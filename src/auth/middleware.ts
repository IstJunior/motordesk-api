import type { Context, Next } from "hono";
import { prisma } from "../lib/db.js";
import { resolverAuthUid } from "../lib/supabase.js";

// Usuario autenticado resuelto desde el token de Supabase.
export type AuthUser = {
  id: bigint;
  email: string;
  isSuperAdmin: boolean;
  // Talleres a los que pertenece (workshopId → rol/owner).
  workshops: { workshopId: bigint; role: string; isOwner: boolean }[];
};

// Cache corta authUid → user (evita golpear Supabase + DB en cada request de un
// mismo cliente). TTL 30s.
const cache = new Map<string, { user: AuthUser; exp: number }>();

async function cargarUsuario(authUid: string): Promise<AuthUser | null> {
  const hit = cache.get(authUid);
  if (hit && hit.exp > Date.now()) return hit.user;

  const dbUser = await prisma.user.findFirst({
    where: { authId: authUid, deletedAt: null },
    select: {
      id: true,
      email: true,
      isSuperAdmin: true,
      workshops: { select: { workshopId: true, role: true, isOwner: true } },
    },
  });
  if (!dbUser) return null;
  const user: AuthUser = {
    id: dbUser.id,
    email: dbUser.email,
    isSuperAdmin: dbUser.isSuperAdmin,
    workshops: dbUser.workshops.map((w) => ({ workshopId: w.workshopId, role: w.role, isOwner: w.isOwner })),
  };
  cache.set(authUid, { user, exp: Date.now() + 30_000 });
  return user;
}

// Exige un Bearer token de Supabase válido y carga el usuario en el contexto.
export async function requireAuth(c: Context, next: Next) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "No autenticado" }, 401);
  const authUid = await resolverAuthUid(auth.slice(7));
  if (!authUid) return c.json({ error: "Token inválido o expirado" }, 401);
  const user = await cargarUsuario(authUid);
  if (!user) return c.json({ error: "Usuario no encontrado" }, 401);
  c.set("user", user);
  await next();
}

// Exige que el usuario autenticado sea superadmin. Usar DESPUÉS de requireAuth.
export async function requireSuperAdmin(c: Context, next: Next) {
  const user = c.get("user");
  if (!user) return c.json({ error: "No autenticado" }, 401);
  if (!user.isSuperAdmin) return c.json({ error: "Sin permiso" }, 403);
  await next();
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}
