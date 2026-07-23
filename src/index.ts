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

// BigInt de Prisma → string en las respuestas JSON.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

// Rutas montadas en "/api" y en "/" (por si el proxy hace StripPrefix del /api).
const api = new Hono();

api.get("/health", (c) => c.json({ ok: true, servicio: "motordesk-api" }));

// Auth del superadmin (login por credencial + whoami).
api.route("/auth", authRoutes);

// Control-plane (superadmin).
api.route("/talleres", talleresRoutes);
api.route("/config", configRoutes);
api.route("/manuales", manualesRoutes);
api.route("/vehiculos", vehiculosRoutes);
api.route("/inbox", inboxRoutes);
api.route("/whatsapp", whatsappRoutes);

// Chat público (widget de leads) — SIN auth.
api.route("/chat", chatRoutes);

const app = new Hono();
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()),
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.route("/api", api);
app.route("/", api);
app.get("/", (c) => c.json({ servicio: "motordesk-api", api: "/api" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`motordesk-api escuchando en :${info.port}`);
});
