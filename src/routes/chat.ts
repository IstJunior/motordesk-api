import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { avisarLead, UUID_RE } from "../lib/chat-notify.js";
import { WEBHOOK_TOKEN, SESION_LEADS, nombreDeSesionPorId } from "../lib/openwa.js";
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

// Lo que se guarda de un mensaje de WhatsApp. Una nota de voz o una foto no
// traen texto, pero son parte de la conversación: sin una marca, la bandeja
// mostraba respuestas a mensajes que no aparecían.
const MARCAS: Record<string, string> = {
  voice: "🎤 Nota de voz",
  ptt: "🎤 Nota de voz",
  audio: "🎵 Audio",
  image: "📷 Imagen",
  video: "🎬 Video",
  document: "📄 Documento",
  sticker: "Sticker",
  location: "📍 Ubicación",
  contact: "👤 Contacto",
  vcard: "👤 Contacto",
};

function textoDelMensaje(d: Record<string, unknown>, texto: string): string | null {
  const tipo = String(d.type ?? "");
  if (tipo === "revoked") return null;
  const marca = MARCAS[tipo];
  if (!marca) return texto || null;
  // La foto o el video con pie de foto: la marca y el texto.
  return texto ? `${marca}: ${texto}` : `[${marca}]`;
}

// El archivo llega una sola vez, en base64 dentro del webhook: OpenWA no lo
// conserva. Si no viene (OpenWA lo omite cuando pesa demasiado o la descarga
// falla), el mensaje queda con su marca y nada más.
const MAX_BYTES_ADJUNTO = 16 * 1024 * 1024;

async function guardarAdjunto(messageId: bigint, media: unknown): Promise<void> {
  if (!media || typeof media !== "object") return;
  const m = media as { mimetype?: unknown; filename?: unknown; data?: unknown; omitted?: unknown };
  if (m.omitted || typeof m.data !== "string" || !m.data) return;
  const bytes = Buffer.from(m.data, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES_ADJUNTO) return;
  const mime = (typeof m.mimetype === "string" && m.mimetype.trim() ? m.mimetype.trim() : "application/octet-stream").slice(0, 100);
  try {
    await prisma.chatMessageMedia.create({
      data: {
        messageId,
        mime,
        nombre: typeof m.filename === "string" ? m.filename.slice(0, 255) : null,
        tamano: bytes.length,
        bytes: new Uint8Array(bytes),
      },
    });
  } catch (e) {
    // El mensaje ya quedó; perder el archivo no puede tumbar el webhook.
    console.error("bandeja: no se guardó el adjunto:", e instanceof Error ? e.message : e);
  }
}

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
  const fromMe = Boolean(d.fromMe);
  const texto = String(d.text ?? d.body ?? d.message ?? "").trim();
  const enviado = evento === "message.sent";
  if (evento && evento !== "message.received" && !enviado) return c.json({ ok: true });

  // OpenWA manda el UUID de la sesión (`sessionId`), no su nombre. Antes solo
  // se leía el nombre, que nunca venía, y un mensaje de un cliente a la sesión
  // de un taller caía en la rama de leads como si le escribiera a MotorDesk.
  const sessionName =
    String(evt.session ?? d.session ?? d.sessionName ?? "") ||
    (await nombreDeSesionPorId(String(evt.sessionId ?? d.sessionId ?? "")).catch(() => null)) ||
    "";

  // Sesión de taller → mensaje entrante de un cliente del taller.
  if (sessionName && sessionName !== SESION_LEADS && sessionName.startsWith("taller-")) {
    if (enviado || fromMe || !texto) return c.json({ ok: true });
    const w = await prisma.workshop.findFirst({ where: { whatsappSession: sessionName }, select: { id: true } });
    if (!w) return c.json({ ok: true });
    // El chat tal cual llega (`…@c.us` o `…@lid`) y el número real. Desde
    // OpenWA 0.26, Baileys entrega el `@lid` como id y el número aparte, en
    // `senderPhone`: tomar los dígitos del id guardaba los del `@lid` como si
    // fueran el teléfono del cliente.
    const chatCliente = String(d.chatId ?? d.from ?? "").trim();
    const telefonoCliente =
      (/@(c\.us|s\.whatsapp\.net)$/.test(chatCliente) ? chatCliente : String(d.senderPhone ?? ""))
        .replace(/\D/g, "")
        .slice(0, 40) || null;
    // Reusa/crea la conversación del cliente en ese taller: por su chat o por
    // su teléfono, porque puede llegar unas veces con uno y otras con el otro.
    let sesion = await prisma.chatSession.findFirst({
      where: {
        workshopId: w.id,
        OR: [
          ...(chatCliente ? [{ whatsappChatId: chatCliente }] : []),
          ...(telefonoCliente ? [{ phone: telefonoCliente }] : []),
        ],
      },
      orderBy: { lastAt: "desc" },
      select: { id: true },
    });
    if (!sesion) {
      sesion = await prisma.chatSession.create({
        data: { workshopId: w.id, phone: telefonoCliente, whatsappChatId: chatCliente || null },
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
  const m = enviado || fromMe ? null : texto.match(/^#([0-9a-f]{8})\b[:\s]*/i);
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
  // grupos y los estados no son leads. En lo que sale, `chatId` es el otro.
  const chatId = String(d.chatId ?? (enviado || fromMe ? d.to : d.from) ?? "").trim();
  if (!chatId || chatId.endsWith("@g.us") || chatId.startsWith("status@")) return c.json({ ok: true });
  const contenido = textoDelMensaje(d, texto);
  if (!contenido) return c.json({ ok: true });

  // Lo que MotorDesk le escribe a alguien desde el celular. Va a su
  // conversación, si la tiene: escribirle a un contacto no lo vuelve un lead.
  if (enviado || fromMe) {
    const sesion = await prisma.chatSession.findFirst({
      where: { workshopId: null, whatsappChatId: chatId },
      orderBy: { lastAt: "desc" },
      select: { id: true },
    });
    if (!sesion) return c.json({ ok: true });
    // Lo contestado desde la bandeja ya se guardó al enviarlo, y OpenWA lo
    // devuelve como enviado: no se repite.
    const yaEsta = await prisma.chatMessage.findFirst({
      where: { sessionId: sesion.id, sender: "proveedor", text: contenido, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
      select: { id: true },
    });
    if (yaEsta) return c.json({ ok: true });
    const salida = await prisma.chatMessage.create({ data: { sessionId: sesion.id, sender: "proveedor", text: contenido }, select: { id: true } });
    await guardarAdjunto(salida.id, d.media);
    await prisma.chatSession.update({ where: { id: sesion.id }, data: { lastAt: new Date() } });
    return c.json({ ok: true });
  }

  // OpenWA trae el nombre en `contact` y, para un `@lid`, el número real en
  // `senderPhone`. Sin leerlos, toda conversación salía "Visitante" y parecía
  // que cada mensaje abría un chat nuevo.
  const contacto = (d.contact ?? {}) as Record<string, unknown>;
  const nombre =
    String(contacto.pushName ?? contacto.name ?? d.pushName ?? d.notifyName ?? d.chatName ?? d.senderName ?? "")
      .replace(/^~\s*/, "")
      .trim()
      .slice(0, 120) || null;
  const telefono =
    (chatId.endsWith("@c.us") ? chatId : String(d.senderPhone ?? contacto.number ?? "")).replace(/\D/g, "").slice(0, 40) || null;

  // La misma persona puede llegar unas veces con su número y otras con su `@lid`:
  // con el teléfono se reconoce y sigue en su misma conversación.
  let sesion = await prisma.chatSession.findFirst({
    where: {
      workshopId: null,
      OR: [{ whatsappChatId: chatId }, ...(telefono ? [{ canal: "whatsapp", phone: telefono }] : [])],
    },
    orderBy: { lastAt: "desc" },
    select: { id: true, name: true, phone: true },
  });
  if (!sesion) {
    sesion = await prisma.chatSession.create({
      data: { canal: "whatsapp", whatsappChatId: chatId, phone: telefono, name: nombre },
      select: { id: true, name: true, phone: true },
    });
  }
  const entrada = await prisma.chatMessage.create({ data: { sessionId: sesion.id, sender: "visitante", text: contenido }, select: { id: true } });
  await guardarAdjunto(entrada.id, d.media);
  // Si la había cerrado, vuelve a la bandeja: escribió otra vez.
  await prisma.chatSession.update({
    where: { id: sesion.id },
    data: {
      lastAt: new Date(),
      status: "active",
      closedAt: null,
      ...(nombre && !sesion.name ? { name: nombre } : {}),
      ...(telefono && !sesion.phone ? { phone: telefono } : {}),
    },
  });
  return c.json({ ok: true });
});
