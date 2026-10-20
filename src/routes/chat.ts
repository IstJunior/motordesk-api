import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { avisarLead, UUID_RE } from "../lib/chat-notify.js";
import { WEBHOOK_TOKEN, SESION_LEADS } from "../lib/openwa.js";
import { rateLimit } from "../auth/rate-limit.js";

// Chat público (widget de leads + webhook OpenWA). SIN auth.
export const chatRoutes = new Hono();

// POST /chat — mensaje del visitante del widget (lead). Crea/continúa sesión.
const postSchema = z.object({
  texto: z.string().trim().min(1).max(2000),
  sessionId: z.string().optional(),
  nombre: z.string().max(120).optional(),
  telefono: z.string().max(40).optional(),
  workshopSlug: z.string().optional(),
});
// 20 mensajes por minuto y por IP: un visitante real no escribe más rápido, y
// sin esto cualquiera puede inflar chat_sessions/chat_messages sin autenticarse.
chatRoutes.post("/", rateLimit({ max: 20, ventanaMs: 60_000 }), async (c) => {
  const parsed = postSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const { texto, nombre, telefono, workshopSlug } = parsed.data;
  const nombreN = nombre?.trim() || null;
  const telefonoN = telefono?.trim() || null;
  let sid = parsed.data.sessionId && UUID_RE.test(parsed.data.sessionId) ? parsed.data.sessionId : null;

  let workshopId: bigint | null = null;
  if (workshopSlug) {
    const w = await prisma.workshop.findUnique({ where: { slug: workshopSlug }, select: { id: true } });
    workshopId = w?.id ?? null;
  }

  if (sid) {
    const ex = await prisma.chatSession.findUnique({ where: { id: sid }, select: { id: true } });
    if (!ex) sid = null;
  }
  if (!sid) {
    const s = await prisma.chatSession.create({
      data: { name: nombreN, phone: telefonoN, workshopId },
      select: { id: true },
    });
    sid = s.id;
  } else {
    await prisma.chatSession.update({
      where: { id: sid },
      data: { lastAt: new Date(), ...(nombreN ? { name: nombreN } : {}), ...(telefonoN ? { phone: telefonoN } : {}) },
    });
  }

  const msg = await prisma.chatMessage.create({
    data: { sessionId: sid, sender: "visitante", text: texto },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  avisarLead(sid, nombreN, texto);
  return c.json({ sessionId: sid, mensaje: { id: msg.id, de: msg.sender, texto: msg.text, creadoAt: msg.createdAt } }, 201);
});

// GET /chat/:sid?desde=ID — poll del visitante.
//
// El widget consulta cada 4s (15/min). El techo de 240/min deja sitio a ~16
// visitantes tras la misma IP (NAT de oficina o de operador móvil) y aun así
// corta un bucle desbocado.
chatRoutes.get("/:sid", rateLimit({ max: 240, ventanaMs: 60_000 }), async (c) => {
  // Con middleware inline, Hono deja de inferir el parámetro como obligatorio.
  const sid = c.req.param("sid") ?? "";
  if (!UUID_RE.test(sid)) return c.json({ error: "Sesión inválida" }, 400);
  const desde = Number(c.req.query("desde") ?? 0) || 0;
  const filas = await prisma.chatMessage.findMany({
    where: { sessionId: sid, id: { gt: BigInt(desde) } },
    orderBy: { id: "asc" },
    select: { id: true, sender: true, text: true, createdAt: true },
  });
  return c.json(filas.map((m) => ({ id: m.id, de: m.sender, texto: m.text, creadoAt: m.createdAt })));
});

// POST /chat/webhook?token=... — inbound de OpenWA (multi-sesión).
//  - sesión leads (motordesk): respuesta del proveedor → rutea al widget por #tag.
//  - sesión de un taller (taller-<code>): mensaje de un CLIENTE → bandeja del taller.
chatRoutes.post("/webhook", async (c) => {
  if (!WEBHOOK_TOKEN || c.req.query("token") !== WEBHOOK_TOKEN) return c.json({ error: "No autorizado" }, 401);
  const evt = (await c.req.json().catch(() => null)) as
    | { event?: string; session?: string; data?: Record<string, unknown>; [k: string]: unknown }
    | null;
  if (!evt) return c.json({ ok: true });

  const d = (evt.data ?? evt) as Record<string, unknown>;
  const evento = String(evt.event ?? d.event ?? "");
  const sessionName = String(evt.session ?? d.session ?? d.sessionName ?? "");
  const fromMe = Boolean(d.fromMe);
  const remitente = String(d.sender ?? d.from ?? d.chatId ?? "").replace(/\D/g, "");
  const texto = String(d.text ?? d.body ?? d.message ?? "").trim();
  if ((evento && evento !== "message.received") || fromMe || !texto) return c.json({ ok: true });

  // Sesión de taller → mensaje entrante de un cliente del taller.
  if (sessionName && sessionName !== SESION_LEADS && sessionName.startsWith("taller-")) {
    const w = await prisma.workshop.findFirst({ where: { whatsappSession: sessionName }, select: { id: true } });
    if (!w) return c.json({ ok: true });
    // Reusa/crea la conversación del cliente (por teléfono) en ese taller.
    let sesion = await prisma.chatSession.findFirst({
      where: { workshopId: w.id, phone: remitente },
      orderBy: { lastAt: "desc" },
      select: { id: true },
    });
    if (!sesion) {
      sesion = await prisma.chatSession.create({
        data: { workshopId: w.id, phone: remitente || null },
        select: { id: true },
      });
    }
    await prisma.chatMessage.create({ data: { sessionId: sesion.id, sender: "cliente", text: texto } });
    await prisma.chatSession.update({ where: { id: sesion.id }, data: { lastAt: new Date() } });
    return c.json({ ok: true });
  }

  // Sesión leads: el número de WhatsApp de MotorDesk.
  //
  // Con el tag #<8hex> al inicio es MotorDesk respondiendo a un lead del widget
  // desde el celular (el esquema anterior, que se conserva). Todo lo demás es
  // alguien escribiéndole a MotorDesk —un anuncio, la landing, un referido— y
  // es un lead propio en la bandeja.
  //
  // Antes todo caía en "la conversación más reciente" como si lo hubiera escrito
  // MotorDesk: el mensaje de un desconocido le aparecía a otro visitante del
  // widget, y quien escribía por WhatsApp no aparecía en ningún lado.
  const m = texto.match(/^#([0-9a-f]{8})\b[:\s]*/i);
  if (m) {
    const cuerpo = texto.slice(m[0].length).trim() || texto;
    const s = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM chat_sessions WHERE id::text LIKE ${m[1].toLowerCase() + "%"} AND workshop_id IS NULL LIMIT 1`;
    const sid = s[0]?.id ?? null;
    if (sid) {
      await prisma.chatMessage.create({ data: { sessionId: sid, sender: "proveedor", text: cuerpo } });
      await prisma.chatSession.update({ where: { id: sid }, data: { lastAt: new Date() } });
    }
    return c.json({ ok: true });
  }

  // El chat tal cual llega (`…@c.us` o `…@lid`): con eso se le responde. Los
  // grupos y los estados no son leads.
  const chatId = String(d.chatId ?? d.from ?? "").trim();
  if (!chatId || chatId.endsWith("@g.us") || chatId.startsWith("status@")) return c.json({ ok: true });
  const nombre =
    String(d.pushName ?? d.notifyName ?? d.chatName ?? d.senderName ?? "")
      .replace(/^~\s*/, "")
      .trim()
      .slice(0, 120) || null;
  const telefono = chatId.endsWith("@c.us") ? chatId.replace(/\D/g, "").slice(0, 40) : null;

  let sesion = await prisma.chatSession.findFirst({
    where: { workshopId: null, whatsappChatId: chatId },
    orderBy: { lastAt: "desc" },
    select: { id: true, name: true },
  });
  if (!sesion) {
    sesion = await prisma.chatSession.create({
      data: { canal: "whatsapp", whatsappChatId: chatId, phone: telefono, name: nombre },
      select: { id: true, name: true },
    });
  }
  await prisma.chatMessage.create({ data: { sessionId: sesion.id, sender: "visitante", text: texto } });
  // Si la había cerrado, vuelve a la bandeja: escribió otra vez.
  await prisma.chatSession.update({
    where: { id: sesion.id },
    data: { lastAt: new Date(), status: "active", closedAt: null, ...(nombre && !sesion.name ? { name: nombre } : {}) },
  });
  return c.json({ ok: true });
});
