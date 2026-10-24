import { Hono } from "hono";
import { superadminGuard } from "../auth/middleware.js";
import {
  openwaHabilitado,
  conectarSesion,
  estadoSesion,
  reiniciarSesion,
  EstadoDesconocido,
  registrarWebhook,
  SESION_LEADS,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";

// Gateway WhatsApp GLOBAL (sesión de leads `motordesk`). Superadmin.
export const whatsappRoutes = new Hono();
whatsappRoutes.use("*", superadminGuard);

const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.PANEL_URL ?? "").replace(/\/+$/, "");
const PROVEEDOR_WA = (process.env.PROVEEDOR_WA ?? "").replace(/\D/g, "");

/**
 * El webhook del número de MotorDesk. Además de lo que llega, pide lo que sale
 * (`message.sent`): lo que se le contesta a alguien desde el celular también
 * tiene que verse en su conversación de la bandeja.
 */
export async function asegurarWebhookDeLeads(): Promise<void> {
  if (!openwaHabilitado() || !BACKEND_URL) return;
  const url = `${BACKEND_URL}/api/chat/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
  await registrarWebhook(SESION_LEADS, url, WEBHOOK_TOKEN, ["message.received", "message.sent"]).catch((e) =>
    console.error("registrarWebhook leads:", e instanceof Error ? e.message : e),
  );
}

whatsappRoutes.get("/estado", async (c) => {
  if (!openwaHabilitado()) {
    return c.json({ habilitado: false, proveedor: false, proveedorNumero: null, status: "sin_configurar", qr: null });
  }
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({
    habilitado: true,
    proveedor: PROVEEDOR_WA.length > 0,
    proveedorNumero: PROVEEDOR_WA || null,
    status: est.status,
    qr: est.qr,
  });
});

whatsappRoutes.post("/conectar", async (c) => {
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);
  // `conectarSesion` y no `iniciarSesion`: si la sesión viene en bucle de
  // caídas, un `start` a secas no hace nada y el QR no aparece nunca.
  try {
    await conectarSesion(SESION_LEADS);
  } catch (e) {
    if (e instanceof EstadoDesconocido) return c.json({ error: e.message }, 503);
    throw e;
  }
  await asegurarWebhookDeLeads();
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});

/**
 * Reinicia el navegador de la sesión sin desvincular el número.
 *
 * Es la salida cuando el QR no aparece o la sesión quedó a medias: mata el
 * navegador, cancela las reconexiones y arranca de nuevo con el mismo perfil.
 * Antes además desvinculaba, y pulsarlo sobre una sesión sana obligaba a
 * escanear otra vez.
 */
whatsappRoutes.post("/reiniciar", async (c) => {
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);
  await reiniciarSesion(SESION_LEADS);
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});

/**
 * Desvincula el número y arranca de cero: hay que volver a escanear el QR.
 * Para cambiar de número o cuando el perfil quedó dañado.
 */
whatsappRoutes.post("/desvincular", async (c) => {
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);
  await reiniciarSesion(SESION_LEADS, { desvincular: true });
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});
