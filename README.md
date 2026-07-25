# motordesk-api

API del plano de control + tenant de MotorDesk (Hono + Prisma, multi-tenant).
Parte de la reconstrucción estilo SmartPOS (SPA + API separados). Reemplaza
gradualmente al monolito Next.

## Stack
- Hono (HTTP) + `@hono/node-server`
- Prisma 6 (mismo `schema.prisma` + migraciones que el monolito)
- Auth: valida el access token de Supabase (JWT) con `jose` (HS256 o JWKS)

## Envs
```
DATABASE_URL=            # Postgres (Supabase pooler)
DIRECT_URL=              # Postgres directo (migraciones)
SUPABASE_JWT_SECRET=     # HS256 (legacy)  — o —
SUPABASE_URL=            # para validar por JWKS (asimétrico)
CORS_ORIGINS=            # coma-separado (dominios de las SPAs)
# Cloudflare R2 (catálogo global de manuales):
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=           # opcional para futuras URLs públicas
# OpenWA (reusa el gateway openwa-api-md):
OPENWA_URL=http://openwa-api-md:2785
OPENWA_API_KEY=
OPENWA_SESSION=motordesk
OPENWA_WEBHOOK_TOKEN=
PROVEEDOR_WA=
BACKEND_URL=             # base pública de esta API (para registrar webhooks)
PANEL_URL=
```

## Dev
```
npm install
npx prisma generate
npm run dev        # tsx watch, :3000
```

## Rutas (Fase 1 — control-plane superadmin)
- `GET /api/health`
- `GET /api/auth/whoami` (requiere Bearer)
- `GET/PUT /api/talleres` (+ `/:id`, `/:id/modules`, `/:id/status`, `/:id/users`,
  `/:id/whatsapp`, `/:id/whatsapp/connect`, `/:id/backups`)
- `GET /api/config` (+ `/ai-providers`)
- `GET /api/manuales` (catálogo `Manuales Colombia Top/` en R2), `GET /api/vehiculos`
- `GET/POST /api/inbox` (bandeja global) — `/contador`, `/:sid`
- `POST /api/chat`, `GET /api/chat/:sid`, `POST /api/chat/webhook` (público, multi-sesión)
- `GET /api/whatsapp/estado`, `POST /api/whatsapp/conectar` (gateway global leads)

## Rutas (Fase 3 — tenant, primer bloque)
- `GET /api/tenant/session` — usuario y talleres disponibles (Supabase Bearer).
- `GET /api/tenant/context` — contexto del taller seleccionado; usa
  `X-Workshop-Id` cuando el usuario pertenece a más de uno.
- `GET /api/tenant/inbox`, `/contador`, `/:sid` y `POST /:sid` — bandeja del
  taller aislada por `workshopId`; las respuestas salen por su sesión OpenWA.
- `GET/POST /api/tenant/services`, `GET/PUT/DELETE /:id` — catálogo de
  servicios; las mutaciones requieren rol operativo autorizado.

Deploy: Coolify Dockerfile, puerto 3000, `prisma migrate deploy` al arrancar.
