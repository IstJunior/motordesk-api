import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { normalizarModulos, MODULOS, ETIQUETA_MODULO, esModuloValido } from "../lib/modules.js";
import { encryptJson } from "../lib/crypto.js";
import {
  openwaHabilitado,
  estadoSesion,
  iniciarSesion,
  registrarWebhook,
  sesionTaller,
  WEBHOOK_TOKEN,
} from "../lib/openwa.js";
import {
  activarSuscripcion,
  cancelarSuscripcion,
  darGracia,
  extenderTrial,
  listarPlanes,
  suspenderSuscripcion,
} from "../lib/billing.js";
import {
  ROLES_TALLER,
  actualizarUsuario,
  agregarUsuario,
  cambiarPassword,
  listarUsuarios,
  quitarUsuario,
  supabaseAdminDisponible,
} from "../lib/workshop-users.js";

export const talleresRoutes = new Hono();
talleresRoutes.use("*", superadminGuard);

const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.PANEL_URL ?? "").replace(/\/+$/, "");

// GET /talleres — lista (tipo ListaComercios).
talleresRoutes.get("/", async (c) => {
  const talleres = await prisma.workshop.findMany({
    where: { deletedAt: null },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      code: true,
      city: true,
      email: true,
      isActive: true,
      subscriptionStatus: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });
  return c.json(talleres);
});

// Catálogos (antes que `/:id` para que no los capture el parámetro).
talleresRoutes.get("/meta/modules", (c) =>
  c.json({ modules: MODULOS.map((m) => ({ value: m, label: ETIQUETA_MODULO[m] })) }),
);
talleresRoutes.get("/meta/planes", async (c) => c.json(await listarPlanes()));
talleresRoutes.get("/meta/roles", (c) => c.json({ roles: ROLES_TALLER }));
// Indica si la API puede crear cuentas de acceso (service role de Supabase).
talleresRoutes.get("/meta/acceso", (c) => c.json({ puedeCrearAcceso: supabaseAdminDisponible() }));

// GET /talleres/:id — detalle (tipo DetalleComercio): módulos, suscripción, estado,
// usuarios, whatsapp.
talleresRoutes.get("/:id", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      code: true,
      slug: true,
      email: true,
      phone: true,
      city: true,
      isActive: true,
      subscriptionStatus: true,
      enabledModules: true,
      whatsappSession: true,
      whatsappStatus: true,
      createdAt: true,
      subscription: {
        select: {
          status: true,
          provider: true,
          collectionMode: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          plan: { select: { id: true, name: true } },
        },
      },
      users: {
        select: {
          id: true,
          role: true,
          isOwner: true,
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { isOwner: "desc" },
      },
    },
  });
  if (!w) return c.json({ error: "Taller no encontrado" }, 404);
  return c.json({ ...w, modules: normalizarModulos(w.enabledModules) });
});

// PUT /talleres/:id/modules — { modules: { inventario: true, ... } }
const modulesSchema = z.object({ modules: z.record(z.boolean()) });
talleresRoutes.put("/:id/modules", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = modulesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const limpio: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed.data.modules)) if (esModuloValido(k)) limpio[k] = v;
  const w = await prisma.workshop.update({
    where: { id },
    data: { enabledModules: limpio },
    select: { enabledModules: true },
  });
  const modules = normalizarModulos(w.enabledModules);
  // La página de facturación del taller lee `enabled` de su config DIAN: se
  // mantiene alineada con el flag del módulo para que ambos digan lo mismo.
  await prisma.workshopDianConfig.updateMany({
    where: { workshopId: id },
    data: { enabled: modules.facturacion_electronica },
  });
  return c.json({ modules });
});

// PUT /talleres/:id/status — { isActive: bool }  (activar/suspender)
const statusSchema = z.object({ isActive: z.boolean() });
talleresRoutes.put("/:id/status", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const w = await prisma.workshop.update({
    where: { id },
    data: { isActive: parsed.data.isActive },
    select: { id: true, isActive: true },
  });
  return c.json(w);
});

// POST /talleres/:id/suscripcion — { accion, dias?, planCode? }
// acciones: activar | pago_manual | trial | gracia | suspender | cancelar
const suscripcionSchema = z.object({
  accion: z.enum(["activar", "pago_manual", "trial", "gracia", "suspender", "cancelar"]),
  dias: z.number().int().min(1).max(365).optional(),
  planCode: z.string().min(1).optional(),
});
talleresRoutes.post("/:id/suscripcion", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = suscripcionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const { accion, dias, planCode } = parsed.data;
  try {
    switch (accion) {
      case "activar":
      case "pago_manual":
        await activarSuscripcion(id, planCode ?? null);
        break;
      case "trial":
        await extenderTrial(id, dias ?? 15);
        break;
      case "gracia":
        await darGracia(id, dias ?? 5);
        break;
      case "suspender":
        await suspenderSuscripcion(id);
        break;
      case "cancelar":
        await cancelarSuscripcion(id);
        break;
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo actualizar la suscripción" }, 400);
  }
  const w = await prisma.workshop.findUnique({
    where: { id },
    select: { subscriptionStatus: true, isActive: true, trialEndsAt: true },
  });
  return c.json(w);
});

// GET /talleres/:id/users — usuarios del taller.
talleresRoutes.get("/:id/users", async (c) => {
  const id = BigInt(c.req.param("id"));
  return c.json(await listarUsuarios(id));
});

// POST /talleres/:id/users — { nombre, email, role, password? }
const nuevoUsuarioSchema = z.object({
  nombre: z.string().trim().max(255).default(""),
  email: z.string().trim().email(),
  role: z.string().min(1),
  password: z.string().trim().max(128).optional(),
});
talleresRoutes.post("/:id/users", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = nuevoUsuarioSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  try {
    const resultado = await agregarUsuario(id, parsed.data);
    return c.json({ ...resultado, usuarios: await listarUsuarios(id) }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo agregar el usuario" }, 400);
  }
});


// PATCH /talleres/:id/users/:uid — { nombre?, email?, role?, isOwner? }
const editarUsuarioSchema = z.object({
  nombre: z.string().trim().max(255).optional(),
  email: z.string().trim().email().optional(),
  role: z.string().min(1).optional(),
  isOwner: z.boolean().optional(),
});
talleresRoutes.patch("/:id/users/:uid", async (c) => {
  const id = BigInt(c.req.param("id"));
  const uid = BigInt(c.req.param("uid"));
  const parsed = editarUsuarioSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  try {
    await actualizarUsuario(id, uid, parsed.data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo actualizar el usuario" }, 400);
  }
  return c.json(await listarUsuarios(id));
});

// PATCH /talleres/:id/users/:uid/password — { password }
talleresRoutes.patch("/:id/users/:uid/password", async (c) => {
  const id = BigInt(c.req.param("id"));
  const uid = BigInt(c.req.param("uid"));
  const parsed = z
    .object({ password: z.string().min(8).max(128) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "La contraseña debe tener al menos 8 caracteres." }, 400);
  try {
    await cambiarPassword(id, uid, parsed.data.password);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo cambiar la contraseña" }, 400);
  }
  return c.json({ ok: true });
});

// DELETE /talleres/:id/users/:uid — quita la membresía (no borra la cuenta).
talleresRoutes.delete("/:id/users/:uid", async (c) => {
  const id = BigInt(c.req.param("id"));
  const uid = BigInt(c.req.param("uid"));
  try {
    await quitarUsuario(id, uid);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo quitar el usuario" }, 400);
  }
  return c.json(await listarUsuarios(id));
});

// GET /talleres/:id/whatsapp — estado de la sesión propia del taller.
talleresRoutes.get("/:id/whatsapp", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({
    where: { id, deletedAt: null },
    select: { code: true, whatsappSession: true, whatsappStatus: true },
  });
  if (!w?.code) return c.json({ error: "Taller no encontrado" }, 404);
  if (!openwaHabilitado()) {
    return c.json({ habilitado: false, status: "sin_configurar", qr: null, session: null });
  }
  const session = w.whatsappSession ?? sesionTaller(w.code);
  const est = await estadoSesion(session).catch(() => ({ status: "desconocido", qr: null }));
  return c.json({ habilitado: true, session, status: est.status, qr: est.qr });
});

// POST /talleres/:id/whatsapp/connect — conecta/inicia la sesión del taller + webhook.
talleresRoutes.post("/:id/whatsapp/connect", async (c) => {
  const id = BigInt(c.req.param("id"));
  const w = await prisma.workshop.findFirst({ where: { id, deletedAt: null }, select: { code: true } });
  if (!w?.code) return c.json({ error: "Taller no encontrado" }, 404);
  if (!openwaHabilitado()) return c.json({ error: "OpenWA no configurado" }, 503);

  const session = sesionTaller(w.code);
  await iniciarSesion(session);
  if (BACKEND_URL) {
    const url = `${BACKEND_URL}/api/chat/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
    await registrarWebhook(session, url, WEBHOOK_TOKEN).catch((e) =>
      console.error("registrarWebhook taller:", e instanceof Error ? e.message : e),
    );
  }
  const est = await estadoSesion(session).catch(() => ({ status: "desconocido", qr: null }));
  await prisma.workshop.update({
    where: { id },
    data: { whatsappSession: session, whatsappStatus: est.status },
  });
  return c.json({ session, status: est.status, qr: est.qr });
});

// GET /talleres/:id/dian — datos de facturación electrónica del taller.
// La clave técnica nunca se devuelve, solo si existe.
talleresRoutes.get("/:id/dian", async (c) => {
  const id = BigInt(c.req.param("id"));
  const cfg = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });
  if (!cfg) {
    return c.json({
      environment: "habilitacion",
      personType: "juridica",
      documentType: "31",
      documentNumber: "",
      dv: "",
      legalName: "",
      address: "",
      city: "",
      municipalityCode: "",
      department: "",
      email: "",
      phone: "",
      taxRegime: "",
      responsibilities: "",
      softwareId: "",
      resolutionPrefix: "",
      resolutionNumber: "",
      rangeFrom: null,
      rangeTo: null,
      nextInvoiceNumber: null,
      tieneClaveTecnica: false,
    });
  }
  const { technicalKeyEncrypted, ...resto } = cfg;
  return c.json({ ...resto, tieneClaveTecnica: Boolean(technicalKeyEncrypted) });
});

// PUT /talleres/:id/dian — guarda emisor, resolución y software.
const textoOpcional = z.string().trim().max(255).optional().nullable();
const dianSchema = z.object({
  environment: z.enum(["habilitacion", "produccion"]).default("habilitacion"),
  personType: z.enum(["natural", "juridica"]).default("juridica"),
  documentType: z.string().trim().max(16).default("31"),
  documentNumber: textoOpcional,
  dv: z.string().trim().max(2).optional().nullable(),
  legalName: textoOpcional,
  address: textoOpcional,
  city: textoOpcional,
  municipalityCode: z.string().trim().max(16).optional().nullable(),
  department: textoOpcional,
  email: textoOpcional,
  phone: z.string().trim().max(80).optional().nullable(),
  taxRegime: textoOpcional,
  responsibilities: textoOpcional,
  softwareId: textoOpcional,
  resolutionPrefix: z.string().trim().max(32).optional().nullable(),
  resolutionNumber: z.string().trim().max(120).optional().nullable(),
  // Solo se guarda si viene con contenido; vacío = conservar la actual.
  technicalKey: z.string().trim().optional().nullable(),
  rangeFrom: z.number().int().positive().optional().nullable(),
  rangeTo: z.number().int().positive().optional().nullable(),
});

function limpiar(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

talleresRoutes.put("/:id/dian", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = dianSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const d = parsed.data;

  const rangeFrom = d.rangeFrom ?? null;
  const rangeTo = d.rangeTo ?? null;
  if (rangeFrom !== null && rangeTo !== null && rangeTo < rangeFrom) {
    return c.json({ error: "El rango hasta no puede ser menor que el rango desde." }, 400);
  }

  const workshop = await prisma.workshop.findFirst({
    where: { id, deletedAt: null },
    select: { enabledModules: true },
  });
  if (!workshop) return c.json({ error: "Taller no encontrado" }, 404);
  const enabled = normalizarModulos(workshop.enabledModules).facturacion_electronica;

  const current = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });
  const resolutionPrefix = limpiar(d.resolutionPrefix);

  // La numeración nunca retrocede: con prefijo nuevo arranca en el rango
  // declarado; con el mismo prefijo continúa tras el último documento emitido.
  const lastDocument = await prisma.dianElectronicDocument.findFirst({
    where: { workshopId: id, prefix: resolutionPrefix },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const nextInvoiceNumber =
    rangeFrom === null
      ? current?.nextInvoiceNumber ?? null
      : Math.max(
          rangeFrom,
          current?.resolutionPrefix === resolutionPrefix ? current?.nextInvoiceNumber ?? 0 : 0,
          (lastDocument?.number ?? 0) + 1,
        );

  const claveTecnica = limpiar(d.technicalKey);
  const datos = {
    enabled,
    environment: d.environment,
    personType: d.personType,
    documentType: limpiar(d.documentType) ?? "31",
    documentNumber: limpiar(d.documentNumber),
    dv: limpiar(d.dv),
    legalName: limpiar(d.legalName),
    address: limpiar(d.address),
    city: limpiar(d.city),
    municipalityCode: limpiar(d.municipalityCode),
    department: limpiar(d.department),
    email: limpiar(d.email),
    phone: limpiar(d.phone),
    taxRegime: limpiar(d.taxRegime),
    responsibilities: limpiar(d.responsibilities),
    softwareId: limpiar(d.softwareId),
    resolutionPrefix,
    resolutionNumber: limpiar(d.resolutionNumber),
    rangeFrom,
    rangeTo,
    nextInvoiceNumber,
  };

  try {
    await prisma.workshopDianConfig.upsert({
      where: { workshopId: id },
      create: {
        workshopId: id,
        ...datos,
        technicalKeyEncrypted: claveTecnica ? encryptJson({ value: claveTecnica }) : null,
      },
      update: {
        ...datos,
        ...(claveTecnica ? { technicalKeyEncrypted: encryptJson({ value: claveTecnica }) } : {}),
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo guardar la configuración DIAN" }, 400);
  }

  const cfg = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });
  const { technicalKeyEncrypted, ...resto } = cfg!;
  return c.json({ ...resto, tieneClaveTecnica: Boolean(technicalKeyEncrypted) });
});

// POST /talleres/:id/backups — placeholder (módulo sin implementar).
talleresRoutes.post("/:id/backups", (c) => c.json({ ok: true, note: "Backups: módulo no implementado" }));
