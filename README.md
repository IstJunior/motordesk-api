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
- `GET /api/manuales` (+ `/:id`), `GET /api/vehiculos`
- `GET/POST /api/inbox` (bandeja global) — `/contador`, `/:sid`
- `POST /api/chat`, `GET /api/chat/:sid`, `POST /api/chat/webhook` (público, multi-sesión)
- `GET /api/whatsapp/estado`, `POST /api/whatsapp/conectar` (gateway global leads)

Deploy: Coolify Dockerfile, puerto 3000, `prisma migrate deploy` al arrancar.
