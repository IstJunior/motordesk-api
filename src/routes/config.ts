import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import {
  configEfectiva,
  configEntorno,
  configGuardada,
  faltantes,
  guardarConfigCorreo,
  sirve,
} from "../lib/correo-config.js";
import { transporteDe } from "../lib/email.js";
import { renderEmail, paragraph } from "../lib/email-template.js";

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

// --- Correo saliente de la plataforma ---
//
// Las credenciales SMTP se configuran aquí y no por variables de entorno: son
// un dato de operación, no del despliegue, y cambiarlas no debería exigir un
// redeploy. Se guardan en `system_settings` bajo la clave que ya lee el
// monolito, así que el panel del taller las toma sin cambiar nada.

// La contraseña nunca vuelve al navegador: solo si existe.
async function estadoCorreo() {
  const guardada = await configGuardada();
  const efectiva = await configEfectiva();
  const entorno = configEntorno();

  return {
    // Lo que se muestra en el formulario. Si todavía no hay fila, se precargan
    // los valores del entorno para que el superadmin solo confirme y guarde.
    valores: {
      enabled: guardada?.enabled ?? true,
      smtpHost: guardada?.smtpHost ?? entorno?.smtpHost ?? "",
      smtpPort: guardada?.smtpPort ?? entorno?.smtpPort ?? 465,
      smtpSecure: guardada?.smtpSecure ?? entorno?.smtpSecure ?? true,
      smtpUser: guardada?.smtpUser ?? entorno?.smtpUser ?? "",
      fromName: guardada?.fromName ?? entorno?.fromName ?? "MotorDesk",
      fromEmail: guardada?.fromEmail ?? entorno?.fromEmail ?? "",
    },
    tienePassword: Boolean(guardada?.smtpPass),
    // Sin fila guardada, el entorno trae la suya y el formulario no tiene que
    // pedirla de nuevo para poder guardar.
    heredaPassword: !guardada?.smtpPass && Boolean(entorno?.smtpPass),
    guardado: sirve(guardada),
    origen: efectiva?.origen ?? null,
    faltan: efectiva ? [] : faltantes(guardada ?? entorno),
  };
}

configRoutes.get("/smtp", async (c) => c.json(await estadoCorreo()));

const smtpSchema = z.object({
  enabled: z.boolean().default(true),
  smtpHost: z.string().trim().min(1, "Falta el servidor").max(255),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().min(1, "Falta el usuario").max(255),
  fromName: z.string().trim().max(255).default("MotorDesk"),
  fromEmail: z.string().trim().email("El remitente no es un correo válido").max(255),
  // Vacío = conservar la guardada.
  smtpPass: z.string().optional().nullable(),
});

configRoutes.put("/smtp", async (c) => {
  const parsed = smtpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, 400);
  }
  const d = parsed.data;

  // Si no llega contraseña nueva y tampoco hay guardada, se toma la del
  // entorno: es la que está funcionando hoy y guardar no debería apagarlo.
  const heredada = d.smtpPass?.trim() ? null : (await configGuardada())?.smtpPass ?? configEntorno()?.smtpPass ?? null;

  try {
    await guardarConfigCorreo({ ...d, smtpPass: d.smtpPass?.trim() || heredada });
  } catch (e) {
    // encryptJson exige PAYMENT_CREDENTIALS_ENCRYPTION_KEY. Vale la pena decirlo
    // con nombre y apellido en vez de devolver un 500 mudo.
    return c.json({ error: e instanceof Error ? e.message : "No se pudo guardar" }, 400);
  }

  return c.json(await estadoCorreo());
});

const pruebaSchema = z.object({ to: z.string().trim().email("El destinatario no es un correo válido") });

// POST /config/smtp/prueba — manda un correo real con la config vigente. Es la
// única forma de saber que las credenciales sirven: SMTP no falla al guardar,
// falla al enviar.
configRoutes.post("/smtp/prueba", async (c) => {
  const parsed = pruebaSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, 400);

  const resuelto = await configEfectiva();
  if (!resuelto) return c.json({ error: `Correo sin configurar: falta ${faltantes(await configGuardada()).join(", ")}.` }, 400);

  const { config, origen } = resuelto;
  try {
    await transporteDe(config).sendMail({
      from: `${config.fromName} <${config.fromEmail}>`,
      to: parsed.data.to,
      subject: "Prueba de correo — MotorDesk",
      html: renderEmail({
        heading: "El correo saliente funciona",
        preheader: "Prueba enviada desde el panel del proveedor.",
        blocks: [
          paragraph("Este mensaje se envió desde el panel del proveedor para verificar la configuración SMTP."),
          paragraph(`Servidor: ${config.smtpHost}:${config.smtpPort} · Remitente: ${config.fromEmail}`),
        ],
      }),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo enviar" }, 400);
  }

  return c.json({ ok: true, a: parsed.data.to, origen });
});
