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
# postgresql-client-17 (repo pgdg): pg_dump/pg_restore para los respaldos.
# La 17 es más nueva que el servidor de Supabase y pg_dump es compatible hacia
# atrás, así que sirve aunque la base sea 15 o 16.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# Al arrancar: aplica migraciones (aditivas) y levanta el servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
EXPOSE 3000
