import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { avisarLead, UUID_RE } from "../lib/chat-notify.js";
import { WEBHOOK_TOKEN, SESION_LEADS } from "../lib/openwa.js";

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
chatRoutes.post("/", async (c) => {
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
chatRoutes.get("/:sid", async (c) => {
  const sid = c.req.param("sid");
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

  // Sesión leads → respuesta del proveedor: rutea por #<8hex> o a la más reciente.
  const m = texto.match(/^#([0-9a-f]{8})\b[:\s]*/i);
  let sid: string | null = null;
  let cuerpo = texto;
  if (m) {
    cuerpo = texto.slice(m[0].length).trim() || texto;
    const s = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM chat_sessions WHERE id::text LIKE ${m[1].toLowerCase() + "%"} LIMIT 1`;
    sid = s[0]?.id ?? null;
  }
  if (!sid) {
    const s = await prisma.chatSession.findFirst({ orderBy: { lastAt: "desc" }, select: { id: true } });
    sid = s?.id ?? null;
  }
  if (!sid) return c.json({ ok: true });
  await prisma.chatMessage.create({ data: { sessionId: sid, sender: "proveedor", text: cuerpo } });
  await prisma.chatSession.update({ where: { id: sid }, data: { lastAt: new Date() } });
  return c.json({ ok: true });
});
