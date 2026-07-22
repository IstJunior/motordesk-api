import { PrismaClient } from "@prisma/client";

// Cap del pool: el pooler de Supabase corre en session mode con límite duro de
// conexiones. Prisma por defecto abre (cpus*2+1); lo capamos salvo que la URL ya
// lo diga. (Portado del monolito.)
function databaseUrlWithPoolCap(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", "5");
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", "20");
    return url.toString();
  } catch {
    return raw;
  }
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrlWithPoolCap() } },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
