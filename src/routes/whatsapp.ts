import { Hono } from "hono";
import { superadminGuard } from "../auth/middleware.js";
import {
  openwaHabilitado,
  conectarSesion,
  estadoSesion,
  reiniciarSesion,
  registrarWebhook,
  SESION_LEADS,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";

// Gateway WhatsApp GLOBAL (sesión de leads `motordesk`). Superadmin.
export const whatsappRoutes = new Hono();
whatsappRoutes.use("*", superadminGuard);

const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.PANEL_URL ?? "").replace(/\/+$/, "");
const PROVEEDOR_WA = (process.env.PROVEEDOR_WA ?? "").replace(/\D/g, "");

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
  await conectarSesion(SESION_LEADS);
  if (BACKEND_URL) {
    const url = `${BACKEND_URL}/api/chat/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
    await registrarWebhook(SESION_LEADS, url, WEBHOOK_TOKEN).catch((e) =>
      console.error("registrarWebhook leads:", e instanceof Error ? e.message : e),
    );
  }
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});

/**
 * Reinicio de raíz, aunque la sesión parezca sana.
 *
 * Es la salida cuando el QR no aparece o la sesión quedó a medias: mata el
 * navegador, cancela las reconexiones y arranca de cero. Va aparte de
 * "conectar" porque desconecta lo que hubiera: quien lo pulsa sabe que va a
 * tener que escanear otra vez.
 */
whatsappRoutes.post("/reiniciar", async (c) => {
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);
  await reiniciarSesion(SESION_LEADS);
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});
