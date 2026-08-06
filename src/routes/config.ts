import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";

// Configuración global (superadmin): ajustes de plataforma + proveedores de IA.
export const configRoutes = new Hono();
configRoutes.use("*", superadminGuard);

// Ajustes editables de la plataforma (portados del monolito).
const AJUSTES = [
  { key: "company_name", label: "Nombre de la empresa", defaultValue: "MotorDesk", multiline: false },
  { key: "company_tax_id", label: "NIT / identificación tributaria", defaultValue: "", multiline: false },
  { key: "company_address", label: "Dirección legal", defaultValue: "", multiline: false },
  { key: "support_email", label: "Correo de soporte", defaultValue: "", multiline: false },
  { key: "default_primary_color", label: "Color primario por defecto", defaultValue: "#f97316", multiline: false },
  { key: "terms_conditions", label: "Términos y condiciones", defaultValue: "", multiline: true },
  { key: "privacy_policy", label: "Política de privacidad", defaultValue: "", multiline: true },
] as const;

const CLAVES = new Set<string>(AJUSTES.map((a) => a.key));

// Endpoint por proveedor (mismo mapa que usaba el monolito).
const ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  grok: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  ollama: "http://localhost:11434",
};

const PROVEEDORES_IA = Object.keys(ENDPOINTS);

function texto(valor: unknown, porDefecto = ""): string {
  return typeof valor === "string" ? valor : porDefecto;
}

async function ajustesActuales() {
  const filas = await prisma.systemSetting.findMany({ where: { key: { in: [...CLAVES] } } });
  const porClave = new Map(filas.map((f) => [f.key, f.value]));
  return AJUSTES.map((a) => ({
    key: a.key,
    label: a.label,
    multiline: a.multiline,
    value: texto(porClave.get(a.key), a.defaultValue),
  }));
}

// GET /config — ajustes de plataforma con su valor actual.
configRoutes.get("/", async (c) => c.json(await ajustesActuales()));

// PUT /config — { settings: { company_name: "…", … } }
const settingsSchema = z.object({ settings: z.record(z.string()) });
configRoutes.put("/", async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const now = new Date();
  const entradas = Object.entries(parsed.data.settings).filter(([k]) => CLAVES.has(k));

  await prisma.$transaction(
    entradas.map(([key, value]) => {
      const limpio = value.trim();
      const guardado = limpio.length > 0 ? limpio : Prisma.DbNull;
      return prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: guardado, type: "string", group: "platform", createdAt: now, updatedAt: now },
        update: { value: guardado, type: "string", group: "platform", updatedAt: now },
      });
    }),
  );

  return c.json(await ajustesActuales());
});

// --- Proveedores de IA ---

// La API key nunca se devuelve completa: solo si existe y sus últimos caracteres.
function sinSecreto<T extends { apiKey: string | null }>(p: T) {
  const { apiKey, ...resto } = p;
  return {
    ...resto,
    tieneApiKey: Boolean(apiKey),
    apiKeyPista: apiKey ? `…${apiKey.slice(-4)}` : null,
  };
}

configRoutes.get("/ai-providers", async (c) => {
  const providers = await prisma.aiProviderConfig.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
  return c.json({ providers: providers.map(sinSecreto), proveedores: PROVEEDORES_IA });
});

const proveedorSchema = z.object({
  provider: z.string().trim().min(1).max(255),
  model: z.string().trim().min(1).max(255),
  isActive: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  // Vacío en edición = conservar la key guardada.
  apiKey: z.string().trim().optional().nullable(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

// Solo un proveedor puede ser el predeterminado.
async function limpiarPredeterminado(id: bigint) {
  await prisma.aiProviderConfig.updateMany({
    where: { isDefault: true, id: { not: id } },
    data: { isDefault: false },
  });
}

configRoutes.post("/ai-providers", async (c) => {
  const parsed = proveedorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const d = parsed.data;
  const now = new Date();
  const creado = await prisma.aiProviderConfig.create({
    data: {
      provider: d.provider,
      model: d.model,
      isActive: d.isActive,
      isDefault: d.isDefault,
      apiKey: d.apiKey?.trim() || null,
      endpoint: ENDPOINTS[d.provider] ?? null,
      ...(d.maxTokens ? { maxTokens: d.maxTokens } : {}),
      ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
  if (d.isDefault) await limpiarPredeterminado(creado.id);
  return c.json(sinSecreto(creado), 201);
});

configRoutes.put("/ai-providers/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = proveedorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const d = parsed.data;
  const apiKey = d.apiKey?.trim();
  const actualizado = await prisma.aiProviderConfig.update({
    where: { id },
    data: {
      provider: d.provider,
      model: d.model,
      isActive: d.isActive,
      isDefault: d.isDefault,
      endpoint: ENDPOINTS[d.provider] ?? null,
      ...(apiKey ? { apiKey } : {}),
      ...(d.maxTokens ? { maxTokens: d.maxTokens } : {}),
      ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
      updatedAt: new Date(),
    },
  });
  if (d.isDefault) await limpiarPredeterminado(id);
  return c.json(sinSecreto(actualizado));
});

configRoutes.delete("/ai-providers/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  try {
    await prisma.aiProviderConfig.delete({ where: { id } });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo eliminar" }, 400);
  }
  return c.json({ ok: true });
});
