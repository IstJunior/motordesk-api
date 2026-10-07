# MotorDesk API — plano de control + tenant (Hono + Prisma, multi-tenant).
# node:22-slim (glibc) para los binarios de Prisma (openssl).
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# --include=dev: Coolify inyecta NODE_ENV=production en el build, que haría a npm
# omitir devDependencies (@types/node, typescript, prisma). Forzamos su instalación.
RUN npm install --include=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# La hora del taller, igual que el contenedor de la app (motordesk/Dockerfile).
# Sin esto el proceso corre en UTC y cualquier `getHours()`, `toLocaleString()`
# sin zona o fecha construida desde texto queda cinco horas corrida respecto de
# lo que ve el taller. Node trae los datos de zonas en su ICU: no hace falta
# instalar tzdata (comprobado en node:22-slim).
ENV TZ=America/Bogota
# postgresql-client-18 (repo pgdg): pg_dump/pg_restore para los respaldos.
#
# Tiene que ser de la MISMA versión mayor que el servidor de producción o más
# nueva: pg_dump lee bases más viejas, pero se niega a respaldar una más nueva
# ("server version mismatch"). La base pasó a Postgres 18 el 2026-09-22 y con el
# cliente 17 el respaldo diario falló en silencio 13 noches seguidas. Si la base
# sube de versión otra vez, esta línea sube con ella.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# Al arrancar: aplica migraciones (aditivas) y levanta el servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
EXPOSE 3000
