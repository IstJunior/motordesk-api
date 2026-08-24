import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth.js";
import { talleresRoutes } from "./routes/talleres.js";
import { configRoutes } from "./routes/config.js";
import { manualesRoutes } from "./routes/manuales.js";
import { vehiculosRoutes } from "./routes/vehiculos.js";
import { inboxRoutes } from "./routes/inbox.js";
import { chatRoutes } from "./routes/chat.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { tenantRoutes } from "./routes/tenant.js";
import { backupsRoutes } from "./routes/backups.js";
import { auditoriaRoutes } from "./routes/auditoria.js";
import { iniciarBackupProgramado } from "./lib/backup-scheduler.js";
import { auditarMutaciones } from "./lib/auditoria.js";

// BigInt de Prisma → string en las respuestas JSON.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

// Rutas montadas en "/api" y en "/" (por si el proxy hace StripPrefix del /api).
const api = new Hono();

api.get("/health", (c) => c.json({ ok: true, servicio: "motordesk-api" }));

// Auth del superadmin (login por credencial + whoami).
api.route("/auth", authRoutes);

// Toda mutación del control-plane deja rastro en `activity_log`. Se aplica por
// prefijo y no dentro de cada router para que un endpoint nuevo quede auditado
// sin tener que acordarse. La bandeja queda fuera a propósito: responder chats
// es volumen, no una acción sensible.
for (const base of ["/talleres", "/config", "/manuales", "/vehiculos", "/backups", "/whatsapp"]) {
  api.use(base, auditarMutaciones);
  api.use(`${base}/*`, auditarMutaciones);
}

// Control-plane (superadmin).
api.route("/talleres", talleresRoutes);
api.route("/config", configRoutes);
api.route("/manuales", manualesRoutes);
api.route("/vehiculos", vehiculosRoutes);
api.route("/inbox", inboxRoutes);
api.route("/backups", backupsRoutes);
api.route("/auditoria", auditoriaRoutes);

// Superficie tenant (Supabase Auth + scope por workshop_user).
api.route("/tenant", tenantRoutes);
api.route("/whatsapp", whatsappRoutes);

// Chat público (widget de leads) — SIN auth.
api.route("/chat", chatRoutes);

// CORS_ORIGINS: lista separada por comas, o "*" para permitir cualquier origen.
// En producción la SPA va bajo el mismo dominio (/app + /control-api), así que
// esto solo aplica a clientes externos y al desarrollo local.
function origenesPermitidos(): string | string[] {
  const bruto = (process.env.CORS_ORIGINS ?? "*").trim();
  const lista = bruto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return lista.length === 0 || lista.includes("*") ? "*" : lista;
}

const app = new Hono();
app.use("*", logger());
app.use(
  "*",
  cors({
    // Ojo: hono trata una LISTA como allowlist exacta, así que `["*"]` no casa
    // con ningún origen y la respuesta sale sin `access-control-allow-origin`.
    // El comodín hay que pasarlo como string suelto.
    origin: origenesPermitidos(),
    allowHeaders: ["Authorization", "Content-Type", "X-Workshop-Id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.route("/api", api);
app.route("/", api);
app.get("/", (c) => c.json({ servicio: "motordesk-api", api: "/api" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`motordesk-api escuchando en :${info.port}`);
  void iniciarBackupProgramado();
});
