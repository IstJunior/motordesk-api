import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
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

// POST /auth/puente — { destino } → { url }
//
// Pase de un solo uso para abrir la app (el panel de un taller, "ver como") con
// la sesión del superadmin. El panel del proveedor entra con su credencial, que
// la app no conoce: sin esto, "Abrir panel del taller" mandaba al login de la
// app salvo que se hubiera entrado además con Google.
//
// El pase vale un minuto y una vez. Se guarda solo su huella; la app lo canjea
// en /super/entrar. El destino solo puede ser una página /super/ de la app.
const puenteSchema = z.object({ destino: z.string().regex(/^\/super\/[A-Za-z0-9/_?=&%.-]*$/).max(255) });
authRoutes.post("/puente", superadminGuard, async (c) => {
  const parsed = puenteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Destino inválido" }, 400);

  // Con sesión de Supabase ya se sabe quién es. Con la credencial propia, es la
  // cuenta superadmin de la app; si hubiera más de una no se adivina.
  let userId = c.get("user")?.id ?? null;
  if (!userId) {
    const superadmins = await prisma.user.findMany({
      where: { isSuperAdmin: true, deletedAt: null, authId: { not: null } },
      select: { id: true },
      take: 2,
    });
    if (superadmins.length !== 1) {
      return c.json({ error: "No se pudo decidir con qué cuenta entrar a la app. Entre con Google." }, 409);
    }
    userId = superadmins[0]!.id;
  }

  const pase = randomBytes(32).toString("base64url");
  await prisma.puenteSuperadmin.create({
    data: {
      tokenHash: createHash("sha256").update(pase).digest("hex"),
      userId: BigInt(userId),
      destino: parsed.data.destino,
      expiraEn: new Date(Date.now() + 60_000),
    },
  });
  // Relativa: el panel (/app) y la app viven en el mismo dominio.
  return c.json({ url: `/super/entrar?pase=${pase}` });
});
