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
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
# Al arrancar: aplica migraciones (aditivas) y levanta el servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
EXPOSE 3000
