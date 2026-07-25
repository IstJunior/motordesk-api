import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import {
  requireActiveWorkshop,
  requireWorkshop,
  requireWorkshopRole,
} from "../auth/workshop.js";
import { prisma } from "../lib/db.js";
import { UUID_RE } from "../lib/chat-notify.js";
import { enviarTexto, openwaHabilitado, sesionTaller } from "../lib/openwa.js";
import { tenantCustomersRoutes } from "./tenant-customers.js";
import { tenantServicesRoutes } from "./tenant-services.js";
import { normalizarModulos } from "../lib/modules.js";

export const tenantRoutes = new Hono();
tenantRoutes.use("*", requireAuth);

// Identidad y talleres disponibles para que la SPA elija contexto.
tenantRoutes.get("/session", async (c) => {
  const user = c.get("user");
  const ids = user.workshops.map((entry) => entry.workshopId);
  const workshops = await prisma.workshop.findMany({
    where: { id: { in: ids }, deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      code: true,
      slug: true,
      name: true,
      isActive: true,
      subscriptionStatus: true,
      enabledModules: true,
    },
  });
  const memberships = new Map(user.workshops.map((entry) => [entry.workshopId.toString(), entry]));
  return c.json({
    user: { id: user.id, email: user.email },
    requiresWorkshopSelection: workshops.length > 1,
    workshops: workshops.map((workshop) => {
      const membership = memberships.get(workshop.id.toString())!;
      return {
        ...workshop,
        role: membership.role,
        isOwner: membership.isOwner,
        modules: normalizarModulos(workshop.enabledModules),
      };
    }),
  });
});
tenantRoutes.route("/services", tenantServicesRoutes);
tenantRoutes.route("/customers", tenantCustomersRoutes);

tenantRoutes.get("/context", requireWorkshop, (c) => c.json(c.get("workshop")));

const inbox = new Hono();
inbox.use("*", requireWorkshop);
inbox.use("*", requireActiveWorkshop);
inbox.use("*", requireWorkshopRole("workshop_admin", "workshop_manager", "workshop_receptionist"));

async function unread(sessionId: string, seenAt: Date | null): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      sessionId,
      sender: { in: ["cliente", "visitante"] },
      ...(seenAt ? { createdAt: { gt: seenAt } } : {}),
    },
  });
}

// Únicamente conversaciones pertenecientes al taller autenticado.
inbox.get("/", async (c) => {
  const workshop = c.get("workshop");
  const sessions = await prisma.chatSession.findMany({
    where: { workshopId: workshop.id },
    orderBy: { lastAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      phone: true,
      seenAt: true,
      lastAt: true,
      messages: { orderBy: { id: "desc" }, take: 1, select: { text: true } },
      _count: { select: { messages: true } },
    },
  });
  return c.json(await Promise.all(sessions.map(async (session) => ({
    id: session.id,
    nombre: session.name,
    telefono: session.phone,
    ultimo: session.messages[0]?.text ?? null,
    ultimoAt: session.lastAt,
    total: session._count.messages,
    noLeidos: await unread(session.id, session.seenAt),
  }))));
});

inbox.get("/contador", async (c) => {
  const workshop = c.get("workshop");
  const sessions = await prisma.chatSession.findMany({
    where: { workshopId: workshop.id },
    select: { id: true, seenAt: true },
  });
  const counts = await Promise.all(sessions.map((session) => unread(session.id, session.seenAt)));
  return c.json({ noLeidos: counts.filter((count) => count > 0).length });
});

inbox.get("/:sid", async (c) => {
  const workshop = c.get("workshop");
  const sid = c.req.param("sid");
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  const session = await prisma.chatSession.findFirst({
    where: { id: sid, workshopId: workshop.id },
    select: { id: true },
  });
  if (!session) return c.json({ error: "Conversación no encontrada" }, 404);
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: sid },
    orderBy: { id: "asc" },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  await prisma.chatSession.update({ where: { id: sid }, data: { seenAt: new Date() } });
  return c.json(messages.map((message) => ({
    id: message.id,
    de: message.sender,
    texto: message.text,
    creadoAt: message.createdAt,
  })));
});

const replySchema = z.object({ texto: z.string().trim().min(1).max(2000) });
inbox.post("/:sid", async (c) => {
  const workshop = c.get("workshop");
  const sid = c.req.param("sid");
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  const parsed = replySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const session = await prisma.chatSession.findFirst({
    where: { id: sid, workshopId: workshop.id },
    select: { id: true, phone: true },
  });
  if (!session) return c.json({ error: "Conversación no encontrada" }, 404);
  if (!session.phone) return c.json({ error: "La conversación no tiene teléfono" }, 409);
  if (!openwaHabilitado()) return c.json({ error: "WhatsApp no configurado" }, 503);
  const whatsappSession = workshop.whatsappSession ?? (workshop.code ? sesionTaller(workshop.code) : null);
  if (!whatsappSession) return c.json({ error: "El taller no tiene sesión de WhatsApp" }, 409);

  try {
    await enviarTexto(whatsappSession, session.phone, parsed.data.texto);
  } catch (error) {
    console.error("tenant inbox reply:", error instanceof Error ? error.message : error);
    return c.json({ error: "No fue posible enviar el mensaje" }, 502);
  }

  const message = await prisma.chatMessage.create({
    data: { sessionId: sid, sender: "taller", text: parsed.data.texto },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  await prisma.chatSession.update({
    where: { id: sid },
    data: { lastAt: new Date(), seenAt: new Date() },
  });
  return c.json({ id: message.id, de: message.sender, texto: message.text, creadoAt: message.createdAt }, 201);
});

tenantRoutes.route("/inbox", inbox);
