import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { normalizarModulos, MODULOS, esModuloValido } from "../lib/modules.js";
import {
  openwaHabilitado,
  estadoSesion,
  iniciarSesion,
  registrarWebhook,
  sesionTaller,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";
import {
  activarSuscripcion,
  cancelarSuscripcion,
  darGracia,
  extenderTrial,
  listarPlanes,
  suspenderSuscripcion,
} from "../lib/billing.js";
import {
  ROLES_TALLER,
  agregarUsuario,
  cambiarRol,
  listarUsuarios,
  quitarUsuario,
} from "../lib/workshop-users.js";

export const talleresRoutes = new Hono();
talleresRoutes.use("*", superadminGuard);

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

// Catálogos (antes que `/:id` para que no los capture el parámetro).
talleresRoutes.get("/meta/modules", (c) => c.json({ modules: MODULOS }));
talleresRoutes.get("/meta/planes", async (c) => c.json(await listarPlanes()));
talleresRoutes.get("/meta/roles", (c) => c.json({ roles: ROLES_TALLER }));

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

// POST /talleres/:id/suscripcion — { accion, dias?, planCode? }
// acciones: activar | pago_manual | trial | gracia | suspender | cancelar
const suscripcionSchema = z.object({
  accion: z.enum(["activar", "pago_manual", "trial", "gracia", "suspender", "cancelar"]),
  dias: z.number().int().min(1).max(365).optional(),
  planCode: z.string().min(1).optional(),
});
talleresRoutes.post("/:id/suscripcion", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = suscripcionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const { accion, dias, planCode } = parsed.data;
  try {
    switch (accion) {
      case "activar":
      case "pago_manual":
        await activarSuscripcion(id, planCode ?? null);
        break;
      case "trial":
        await extenderTrial(id, dias ?? 15);
        break;
      case "gracia":
        await darGracia(id, dias ?? 5);
        break;
      case "suspender":
        await suspenderSuscripcion(id);
        break;
      case "cancelar":
        await cancelarSuscripcion(id);
        break;
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo actualizar la suscripción" }, 400);
  }
  const w = await prisma.workshop.findUnique({
    where: { id },
    select: { subscriptionStatus: true, isActive: true, trialEndsAt: true },
  });
  return c.json(w);
});

// GET /talleres/:id/users — usuarios del taller.
talleresRoutes.get("/:id/users", async (c) => {
  const id = BigInt(c.req.param("id"));
  return c.json(await listarUsuarios(id));
});

// POST /talleres/:id/users — { nombre, email, role }
const nuevoUsuarioSchema = z.object({
  nombre: z.string().trim().max(255).default(""),
  email: z.string().trim().email(),
  role: z.string().min(1),
});
talleresRoutes.post("/:id/users", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = nuevoUsuarioSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  try {
    await agregarUsuario(id, parsed.data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo agregar el usuario" }, 400);
  }
  return c.json(await listarUsuarios(id), 201);
});

// PATCH /talleres/:id/users/:uid — { role }
talleresRoutes.patch("/:id/users/:uid", async (c) => {
  const id = BigInt(c.req.param("id"));
  const uid = BigInt(c.req.param("uid"));
  const parsed = z.object({ role: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  try {
    await cambiarRol(id, uid, parsed.data.role);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo cambiar el rol" }, 400);
  }
  return c.json(await listarUsuarios(id));
});

// DELETE /talleres/:id/users/:uid — quita la membresía (no borra la cuenta).
talleresRoutes.delete("/:id/users/:uid", async (c) => {
  const id = BigInt(c.req.param("id"));
  const uid = BigInt(c.req.param("uid"));
  try {
    await quitarUsuario(id, uid);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo quitar el usuario" }, 400);
  }
  return c.json(await listarUsuarios(id));
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
