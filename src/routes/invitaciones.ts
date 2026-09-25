import { Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { auditar } from "../lib/auditoria.js";
import { enviarTexto, openwaHabilitado, SESION_LEADS } from "../lib/openwa.js";

// Invitar a un taller a usar MotorDesk.
//
// Es distinta del alta desde el panel. Aquella la llena el superadministrador
// con los datos del taller delante; esta solo necesita un celular, y es el
// dueño quien llena lo suyo y crea el taller. Sirve cuando lo único que hay
// después de una llamada es un número.
//
// La tabla la creó el monolito y la comparten los dos. Acá se emiten y se
// listan; la página que las canjea —`/rt/<token>`— vive allá, porque crear el
// taller necesita el alta en Supabase y los horarios por defecto.

export const invitacionesRoutes = new Hono();
invitacionesRoutes.use("*", superadminGuard);

/** Una invitación no usada en dos semanas ya no sirve. */
const DIAS = 14;
const CORTESIA = 30;

const hashDelToken = (t: string) => createHash("sha256").update(t).digest("hex");

function baseDelSitio(): string {
  return (process.env.PANEL_URL ?? process.env.BACKEND_URL ?? "https://motordesk.nexcoreia.com").replace(/\/+$/, "");
}

/** A `57XXXXXXXXXX`, que es como los quiere el gateway. */
function normalizarCelular(crudo: string): string | null {
  const d = crudo.replace(/\D/g, "");
  if (d.length === 10) return `57${d}`;
  if (d.length === 12 && d.startsWith("57")) return d;
  return d.length >= 10 ? d : null;
}

/** El texto que recibe el dueño del taller. */
function mensajeDeInvitacion(e: {
  nombreDelDueno: string | null;
  nombreDelTaller: string | null;
  diasDeCortesia: number;
  url: string;
}): string {
  const saludo = e.nombreDelDueno ? `Hola ${e.nombreDelDueno}` : "Hola";
  const taller = e.nombreDelTaller ? ` de ${e.nombreDelTaller}` : "";
  return [
    `${saludo}, le escribimos de MotorDesk.`,
    "",
    `Dejamos listo el acceso${taller} para que empiece a usar el sistema: turnos, agenda, inventario, caja y avisos a sus clientes por WhatsApp, todo en un solo lugar.`,
    "",
    `Tiene ${e.diasDeCortesia} días de cortesía. No se pide tarjeta y no hay cobro automático.`,
    "",
    `Active su taller acá: ${e.url}`,
    "",
    "Son dos minutos. Cualquier duda, responda a este mismo mensaje.",
  ].join("\n");
}

const nueva = z.object({
  telefono: z.string().min(7),
  taller: z.string().trim().max(255).optional(),
  dueno: z.string().trim().max(255).optional(),
  dias: z.coerce.number().int().min(0).max(365).optional(),
});

invitacionesRoutes.post("/", async (c) => {
  const cuerpo = await c.req.json().catch(() => ({}));
  const parseo = nueva.safeParse(cuerpo);
  if (!parseo.success) return c.json({ error: "Datos inválidos" }, 400);

  const telefono = normalizarCelular(parseo.data.telefono);
  if (!telefono) return c.json({ error: "Escribe un celular válido." }, 400);

  const nombreDelTaller = parseo.data.taller?.trim() || null;
  const nombreDelDueno = parseo.data.dueno?.trim() || null;
  const dias = parseo.data.dias ?? CORTESIA;

  const token = randomBytes(32).toString("base64url");
  const expiraEl = new Date(Date.now() + DIAS * 24 * 60 * 60 * 1000);

  // Una invitación viva por número. Reenviar reemplaza la anterior, para que el
  // dueño no termine con tres enlaces en el chat sin saber cuál sirve.
  await prisma.workshopInvite.updateMany({
    where: { phone: telefono, revokedAt: null, completedAt: null },
    data: { revokedAt: new Date() },
  });

  const fila = await prisma.workshopInvite.create({
    data: {
      tokenHash: hashDelToken(token),
      phone: telefono,
      workshopName: nombreDelTaller,
      ownerName: nombreDelDueno,
      trialDays: dias,
      expiresAt: expiraEl,
    },
    select: { id: true },
  });

  const url = `${baseDelSitio()}/rt/${token}`;
  const texto = mensajeDeInvitacion({ nombreDelDueno, nombreDelTaller, diasDeCortesia: dias, url });

  // Se intenta enviar y se mira si salió; no se le pregunta antes al gateway
  // si está listo.
  //
  // El campo `status` de una sesión se queda en `qr_ready` aunque el teléfono
  // ya esté vinculado, y confiar en él hizo que durante días los avisos de los
  // talleres salieran por el navegador con la sesión sana. El propio envío es
  // la única comprobación que no miente.
  let enviado = false;
  if (openwaHabilitado()) {
    enviado = await enviarTexto(SESION_LEADS, telefono, texto)
      .then(() => true)
      .catch((e) => {
        console.error("invitación por la línea de MotorDesk:", e instanceof Error ? e.message : e);
        return false;
      });
  }

  await auditar({
    actor: c.get("superadmin"),
    accion: "taller.invitar",
    descripcion: "Invitación a un taller",
    detalle: { telefono, taller: nombreDelTaller, dias, enviado },
  }).catch(() => {});

  return c.json({
    id: fila.id.toString(),
    url,
    expiraEl: expiraEl.toISOString(),
    enviado,
    // Sin línea vinculada, lo manda quien está en pantalla desde su WhatsApp.
    whatsapp: enviado ? null : `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`,
  });
});

invitacionesRoutes.get("/", async (c) => {
  const filas = await prisma.workshopInvite.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // `relationMode = "prisma"` haría una consulta por fila si se incluyera la
  // relación; los talleres se traen de una vez.
  const ids = [...new Set(filas.map((f) => f.workshopId).filter((v): v is bigint => v !== null))];
  const talleres = ids.length
    ? await prisma.workshop.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } })
    : [];
  const porId = new Map(talleres.map((t) => [t.id.toString(), t]));

  const ahora = Date.now();
  return c.json(
    filas.map((f) => {
      const wsId = f.workshopId?.toString() ?? null;
      const taller = wsId ? porId.get(wsId) : null;
      return {
        id: f.id.toString(),
        telefono: f.phone,
        taller: f.workshopName,
        dueno: f.ownerName,
        dias: f.trialDays,
        estado: f.revokedAt
          ? "revocada"
          : f.completedAt
            ? "usada"
            : f.expiresAt.getTime() < ahora
              ? "vencida"
              : "abierta",
        creadaEl: f.createdAt.toISOString(),
        tallerCreado: taller ? { id: taller.id.toString(), nombre: taller.name, code: taller.code } : null,
      };
    }),
  );
});

invitacionesRoutes.post("/:id/revocar", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: "Id inválido" }, 400);
  await prisma.workshopInvite.updateMany({
    where: { id: BigInt(id), completedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return c.json({ ok: true });
});
