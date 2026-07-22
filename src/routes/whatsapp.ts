import { Hono } from "hono";
import { requireAuth, requireSuperAdmin } from "../auth/middleware.js";
import {
  openwaHabilitado,
  estadoSesion,
  iniciarSesion,
  registrarWebhook,
  SESION_LEADS,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";

// Gateway WhatsApp GLOBAL (sesión de leads `motordesk`). Superadmin.
export const whatsappRoutes = new Hono();
whatsappRoutes.use("*", requireAuth, requireSuperAdmin);

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
  await iniciarSesion(SESION_LEADS);
  if (BACKEND_URL) {
    const url = `${BACKEND_URL}/api/chat/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
    await registrarWebhook(SESION_LEADS, url, WEBHOOK_TOKEN).catch((e) =>
      console.error("registrarWebhook leads:", e instanceof Error ? e.message : e),
    );
  }
  const est = await estadoSesion(SESION_LEADS).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ status: est.status, qr: est.qr });
});
