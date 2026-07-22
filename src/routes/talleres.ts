import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireSuperAdmin } from "../auth/middleware.js";
import { normalizarModulos, MODULOS, esModuloValido } from "../lib/modules.js";
import {
  openwaHabilitado,
  estadoSesion,
  iniciarSesion,
  registrarWebhook,
  sesionTaller,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";

export const talleresRoutes = new Hono();
talleresRoutes.use("*", requireAuth, requireSuperAdmin);

const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.PANEL_URL ?? "").replace(/\/+$/, "");

// GET /talleres — lista (tipo ListaComercios).
talleresRoutes.get("/", async (c) => {
  const talleres = await prisma.workshop.findMany({
    where: { deletedAt: null },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      code: true,
      city: true,
      email: true,
      isActive: true,
      subscriptionStatus: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });
  return c.json(talleres);
});

// GET /talleres/:id — detalle (tipo DetalleComercio): módulos, suscripción, estado,
// usuarios, whatsapp.
talleresRoutes.get("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      code: true,
      slug: true,
      email: true,
      phone: true,
      city: true,
      isActive: true,
      subscriptionStatus: true,
      enabledModules: true,
      whatsappSession: true,
      whatsappStatus: true,
      createdAt: true,
      subscription: {
        select: {
          status: true,
          provider: true,
          collectionMode: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          plan: { select: { id: true, name: true } },
        },
      },
      users: {
        select: {
          id: true,
          role: true,
          isOwner: true,
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { isOwner: "desc" },
      },
    },
  });
  if (!w) return c.json({ error: "Taller no encontrado" }, 404);
  return c.json({ ...w, modules: normalizarModulos(w.enabledModules) });
});

// PUT /talleres/:id/modules — { modules: { turnos: true, ... } }
const modulesSchema = z.object({ modules: z.record(z.boolean()) });
talleresRoutes.put("/:id/modules", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = modulesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const limpio: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed.data.modules)) if (esModuloValido(k)) limpio[k] = v;
  const w = await prisma.workshop.update({
    where: { id },
    data: { enabledModules: limpio },
    select: { enabledModules: true },
  });
  return c.json({ modules: normalizarModulos(w.enabledModules) });
});

// PUT /talleres/:id/status — { isActive: bool }  (activar/suspender)
const statusSchema = z.object({ isActive: z.boolean() });
talleresRoutes.put("/:id/status", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const w = await prisma.workshop.update({
    where: { id },
    data: { isActive: parsed.data.isActive },
    select: { id: true, isActive: true },
  });
  return c.json(w);
});

// GET /talleres/:id/users — usuarios del taller.
talleresRoutes.get("/:id/users", async (c) => {
  const id = BigInt(c.req.param("id"));
  const users = await prisma.workshopUser.findMany({
    where: { workshopId: id },
    select: { id: true, role: true, isOwner: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { isOwner: "desc" },
  });
  return c.json(users);
});

// GET /talleres/:id/whatsapp — estado de la sesión propia del taller.
talleresRoutes.get("/:id/whatsapp", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({
    where: { id, deletedAt: null },
    select: { code: true, whatsappSession: true, whatsappStatus: true },
  });
  if (!w?.code) return c.json({ error: "Taller no encontrado" }, 404);
  if (!openwaHabilitado()) {
    return c.json({ habilitado: false, status: "sin_configurar", qr: null, session: null });
  }
  const session = w.whatsappSession ?? sesionTaller(w.code);
  const est = await estadoSesion(session).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ habilitado: true, session, status: est.status, qr: est.qr });
});

// POST /talleres/:id/whatsapp/connect — conecta/inicia la sesión del taller + webhook.
talleresRoutes.post("/:id/whatsapp/connect", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({ where: { id, deletedAt: null }, select: { code: true } });
  if (!w?.code) return c.json({ error: "Taller no encontrado" }, 404);
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);

  const session = sesionTaller(w.code);
  await iniciarSesion(session);
  if (BACKEND_URL) {
    const url = `${BACKEND_URL}/api/chat/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
    await registrarWebhook(session, url, WEBHOOK_TOKEN).catch((e) =>
      console.error("registrarWebhook taller:", e instanceof Error ? e.message : e),
    );
  }
  const est = await estadoSesion(session).catch(() => ({ status: "desconocido", qr: null }));
  await prisma.workshop.update({
    where: { id },
    data: { whatsappSession: session, whatsappStatus: est.status },
  });
  return c.json({ session, status: est.status, qr: est.qr });
});

// POST /talleres/:id/backups — placeholder (módulo sin implementar).
talleresRoutes.post("/:id/backups", (c) => c.json({ ok: true, note: "Backups: módulo no implementado" }));

// Catálogo de módulos disponibles (para pintar los toggles).
talleresRoutes.get("/meta/modules", (c) => c.json({ modules: MODULOS }));
