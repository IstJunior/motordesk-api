import { Hono } from "hono";
import { z } from "zod";
import { credencialValida, firmarToken, superadminConfigurado } from "../lib/superadmin.js";
import { superadminGuard } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";

export const authRoutes = new Hono();

// POST /auth/login — login del superadmin por credencial (estilo SmartPOS).
//
// Con throttle: 8 intentos FALLIDOS por IP cada 15 min. Solo cuentan los fallos,
// así que entrar bien no gasta cupo y no hay forma de auto-bloquearse usando el
// panel con normalidad.
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
authRoutes.post("/login", rateLimit({ max: 8, ventanaMs: 15 * 60_000, soloErrores: true }), async (c) => {
  if (!superadminConfigurado()) return c.json({ error: "Superadmin no configurado" }, 503);
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const { username, password } = parsed.data;
  if (!credencialValida(username, password)) {
    return c.json({ error: "Credenciales inválidas" }, 401);
  }
  const token = await firmarToken();
  return c.json({ token, user: { username, isSuperAdmin: true } });
});

// GET /auth/whoami — valida el token (superadmin propio o Supabase superadmin).
authRoutes.get("/whoami", superadminGuard, (c) => {
  return c.json({ user: c.get("superadmin"), isSuperAdmin: true });
});
