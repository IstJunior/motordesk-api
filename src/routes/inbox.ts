import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { UUID_RE } from "../lib/chat-notify.js";
import { enviarTextoAChat, openwaHabilitado, SESION_LEADS } from "../lib/openwa.js";

// Bandeja del proveedor: SOLO los leads de la landing (`workshop_id IS NULL`).
//
// El webhook de OpenWA también crea sesiones con `workshop_id` cuando un cliente
// le escribe por WhatsApp a un taller. Esas son conversaciones privadas entre el
// taller y su cliente y se leen desde la bandeja del taller (`/tenant/inbox`),
// no desde aquí: el proveedor no tiene por qué verlas de forma rutinaria.
export const inboxRoutes = new Hono();
inboxRoutes.use("*", superadminGuard);

// Recorte de la bandeja del proveedor. Se aplica en TODOS los endpoints, no solo
// en el listado: si no, bastaría con conocer el UUID para leer o responder la
// conversación de un taller.
const SOLO_LEADS = { workshopId: null } as const;

async function noLeidos(sessionId: string, seenAt: Date | null): Promise<number> {
  return prisma.chatMessage.count({
    where: {
      sessionId,
      sender: { in: ["visitante", "cliente"] },
      ...(seenAt ? { createdAt: { gt: seenAt } } : {}),
    },
  });
}

// Devuelve la sesión si es un lead; null si no existe o pertenece a un taller.
async function leadONada(sid: string) {
  return prisma.chatSession.findFirst({
    where: { id: sid, ...SOLO_LEADS },
    select: { id: true, canal: true, whatsappChatId: true },
  });
}

// GET /inbox — conversaciones (recientes primero).
inboxRoutes.get("/", async (c) => {
  const sesiones = await prisma.chatSession.findMany({
    where: SOLO_LEADS,
    orderBy: { lastAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      phone: true,
      seenAt: true,
      lastAt: true,
      canal: true,
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
      canal: s.canal,
      workshopId: null,
      workshopNombre: null,
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
  const sesiones = await prisma.chatSession.findMany({
    where: SOLO_LEADS,
    select: { id: true, seenAt: true },
  });
  let n = 0;
  for (const s of sesiones) if ((await noLeidos(s.id, s.seenAt)) > 0) n++;
  return c.json({ noLeidos: n });
});

// GET /inbox/:sid/mensajes/:mid/adjunto — el archivo del mensaje (nota de voz,
// foto…), para reproducirlo en la bandeja.
inboxRoutes.get("/:sid/mensajes/:mid/adjunto", async (c) => {
  const sid = c.req.param("sid") ?? "";
  const mid = c.req.param("mid") ?? "";
  if (!UUID_RE.test(sid) || !/^\d+$/.test(mid)) return c.json({ error: "No encontrado" }, 404);
  const media = await prisma.chatMessageMedia.findFirst({
    where: { messageId: BigInt(mid), message: { sessionId: sid, session: SOLO_LEADS } },
    select: { mime: true, bytes: true },
  });
  if (!media) return c.json({ error: "No encontrado" }, 404);
  return c.body(new Uint8Array(media.bytes), 200, {
    "Content-Type": media.mime,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
});

// GET /inbox/:sid — mensajes (marca leída).
inboxRoutes.get("/:sid", async (c) => {
  const sid = c.req.param("sid") ?? "";
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  if (!(await leadONada(sid))) return c.json({ error: "No encontrada" }, 404);

  const filas = await prisma.chatMessage.findMany({
    where: { sessionId: sid },
    orderBy: { id: "asc" },
    select: { id: true, sender: true, text: true, createdAt: true, media: { select: { mime: true, nombre: true, tamano: true } } },
  });
  await prisma.chatSession.update({ where: { id: sid }, data: { seenAt: new Date() } });
  return c.json(
    filas.map((m) => ({ id: m.id, de: m.sender, texto: m.text, creadoAt: m.createdAt, adjunto: m.media ?? null })),
  );
});

// POST /inbox/:sid — responder (sender='proveedor').
inboxRoutes.post("/:sid", async (c) => {
  const sid = c.req.param("sid") ?? "";
  if (!UUID_RE.test(sid)) return c.json({ error: "Conversación inválida" }, 400);
  const parsed = z
    .object({ texto: z.string().trim().min(1).max(2000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const lead = await leadONada(sid);
  if (!lead) return c.json({ error: "No encontrada" }, 404);

  // Se guarda antes de enviar: OpenWA devuelve lo enviado por el webhook
  // (`message.sent`) y, si llegara primero, el webhook no tendría con qué
  // reconocerlo y lo guardaría dos veces.
  const msg = await prisma.chatMessage.create({
    data: { sessionId: sid, sender: "proveedor", text: parsed.data.texto },
    select: { id: true, sender: true, text: true, createdAt: true },
  });

  // A quien escribió por WhatsApp se le responde por WhatsApp. Si no sale, no
  // se guarda: la bandeja no puede mostrar como enviado algo que no le llegó.
  if (lead.canal === "whatsapp" && lead.whatsappChatId) {
    const error = !openwaHabilitado()
      ? { texto: "El WhatsApp de MotorDesk no está configurado.", status: 503 as const }
      : await enviarTextoAChat(SESION_LEADS, lead.whatsappChatId, parsed.data.texto).then(
          () => null,
          (e) => {
            console.error("bandeja: no salió por WhatsApp:", e instanceof Error ? e.message : e);
            return { texto: "No se pudo enviar por WhatsApp. Revise que la sesión esté conectada.", status: 502 as const };
          },
        );
    if (error) {
      await prisma.chatMessage.delete({ where: { id: msg.id } }).catch(() => {});
      return c.json({ error: error.texto }, error.status);
    }
  }

  await prisma.chatSession.update({
    where: { id: sid },
    data: { lastAt: new Date(), seenAt: new Date() },
  });
  return c.json({ id: msg.id, de: msg.sender, texto: msg.text, creadoAt: msg.createdAt }, 201);
});
