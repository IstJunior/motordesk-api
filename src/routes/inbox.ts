import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { UUID_RE } from "../lib/chat-notify.js";

// Bandeja del superadmin: todas las conversaciones (leads + talleres).
export const inboxRoutes = new Hono();
inboxRoutes.use("*", superadminGuard);

async function noLeidos(sessionId: string, seenAt: Date | null): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      sessionId,
      sender: { in: ["visitante", "cliente"] },
      ...(seenAt ? { createdAt: { gt: seenAt } } : {}),
    },
  });
}

// GET /inbox — conversaciones (recientes primero).
inboxRoutes.get("/", async (c) => {
  const sesiones = await prisma.chatSession.findMany({
    orderBy: { lastAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      phone: true,
      workshopId: true,
      seenAt: true,
      lastAt: true,
      workshop: { select: { name: true } },
      messages: { orderBy: { id: "desc" }, take: 1, select: { text: true } },
      _count: { select: { messages: true } },
    },
  });
  const out = [];
  for (const s of sesiones) {
    out.push({
      id: s.id,
      nombre: s.name,
      telefono: s.phone,
      workshopId: s.workshopId,
      workshopNombre: s.workshop?.name ?? null,
      ultimo: s.messages[0]?.text ?? null,
      ultimoAt: s.lastAt,
      total: s._count.messages,
      noLeidos: await noLeidos(s.id, s.seenAt),
    });
  }
  return c.json(out);
});

// GET /inbox/contador — nº de conversaciones con no leídos.
inboxRoutes.get("/contador", async (c) => {
  const sesiones = await prisma.chatSession.findMany({ select: { id: true, seenAt: true } });
  let n = 0;
  for (const s of sesiones) if ((await noLeidos(s.id, s.seenAt)) > 0) n++;
  return c.json({ noLeidos: n });
});

// GET /inbox/:sid — mensajes (marca leída).
inboxRoutes.get("/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  const filas = await prisma.chatMessage.findMany({
    where: { sessionId: sid },
    orderBy: { id: "asc" },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  await prisma.chatSession.update({ where: { id: sid }, data: { seenAt: new Date() } });
  return c.json(filas.map((m) => ({ id: m.id, de: m.sender, texto: m.text, creadoAt: m.createdAt })));
});

// POST /inbox/:sid — responder (sender='proveedor').
inboxRoutes.post("/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  const parsed = z.object({ texto: z.string().trim().min(1).max(2000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const ex = await prisma.chatSession.findUnique({ where: { id: sid }, select: { id: true } });
  if (!ex) return c.json({ error: "No encontrada" }, 404);
  const msg = await prisma.chatMessage.create({
    data: { sessionId: sid, sender: "proveedor", text: parsed.data.texto },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  await prisma.chatSession.update({ where: { id: sid }, data: { lastAt: new Date(), seenAt: new Date() } });
  return c.json({ id: msg.id, de: msg.sender, texto: msg.text, creadoAt: msg.createdAt }, 201);
});
