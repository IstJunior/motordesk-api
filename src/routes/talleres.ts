import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { superadminGuard } from "../auth/middleware.js";
import { normalizarModulos, MODULOS, ETIQUETA_MODULO, esModuloValido } from "../lib/modules.js";
import { encryptJson, decryptJson } from "../lib/crypto.js";
import { empresaDeFactus, probarConexion, type EmpresaFactus } from "../lib/factus-probe.js";
import { probarConexionNextpyme } from "../lib/nextpyme-probe.js";
import {
  openwaHabilitado,
  estadoSesion,
  conectarSesion,
  EstadoDesconocido,
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
  SOLO_PERSONAL,
  actualizarUsuario,
  agregarUsuario,
  cambiarPassword,
  faltantesSupabaseAdmin,
  listarUsuarios,
  quitarUsuario,
  supabaseAdminDisponible,
} from "../lib/workshop-users.js";
import { crearTaller } from "../lib/crear-taller.js";
import { TIPOS_TALLER } from "../lib/workshop-types.js";
import { resumenPlantillas } from "../lib/plantillas.js";
import { auditar } from "../lib/auditoria.js";
import { prestadorCompleto } from "../lib/contrato-config.js";
import { correoDisponible, faltantesCorreo } from "../lib/email.js";

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
      // Solo el personal: `workshop_user` también guarda a los clientes del
      // taller con role='client', y el conteo los estaba sumando.
      _count: { select: { users: { where: SOLO_PERSONAL } } },
    },
  });
  return c.json(talleres);
});

// POST /talleres — alta de taller desde el panel del proveedor.
const nuevoTallerSchema = z.object({
  nombre: z.string().trim().min(2),
  email: z.string().trim().email(),
  tipo: z.string().optional(),
  telefono: z.string().trim().optional().nullable(),
  ciudad: z.string().trim().optional().nullable(),
  direccion: z.string().trim().optional().nullable(),
  duenoNombre: z.string().trim().min(2),
  duenoEmail: z.string().trim().email().optional().nullable(),
  duenoPassword: z.string().min(8).optional().nullable(),
  diasTrial: z.number().int().min(0).max(365).optional(),
  sembrarPlantillas: z.boolean().optional(),
  enviarInvitacion: z.boolean().optional(),
});

talleresRoutes.post("/", async (c) => {
  const parseo = nuevoTallerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parseo.success) {
    return c.json({ error: parseo.error.issues[0]?.message ?? "Datos inválidos" }, 400);
  }
  try {
    const taller = await crearTaller(parseo.data);
    await auditar({
      actor: c.get("superadmin"),
      accion: "taller.crear",
      descripcion: "Alta de taller",
      tallerId: BigInt(taller.id),
      detalle: { code: taller.code, tipo: taller.tipo, servicios: taller.servicios, invitacion: taller.invitacion?.enviada ?? null },
    });
    c.set("auditado", true);
    return c.json(taller, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo crear el taller" }, 400);
  }
});

// Catálogos (antes que `/:id` para que no los capture el parámetro).
talleresRoutes.get("/meta/tipos", (c) =>
  c.json({
    tipos: TIPOS_TALLER.map((t) => ({ value: t.value, label: t.label })),
    plantillas: resumenPlantillas(),
  }),
);

talleresRoutes.get("/meta/modules", (c) =>
  c.json({ modules: MODULOS.map((m) => ({ value: m, label: ETIQUETA_MODULO[m] })) }),
);
talleresRoutes.get("/meta/planes", async (c) => c.json(await listarPlanes()));
talleresRoutes.get("/meta/roles", (c) => c.json({ roles: ROLES_TALLER }));
// Indica si la API puede crear cuentas de acceso (service role de Supabase) y
// si puede mandar la invitación por correo. El panel usa esto para deshabilitar
// la casilla con una explicación en vez de dejarla gris sin motivo.
talleresRoutes.get("/meta/acceso", async (c) =>
  c.json({
    puedeCrearAcceso: supabaseAdminDisponible(),
    faltan: faltantesSupabaseAdmin(),
    puedeInvitar: await correoDisponible(),
    faltanCorreo: await faltantesCorreo(),
  }),
);

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
      contratoRequerido: true,
      subscriptionStatus: true,
      trialEndsAt: true,
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
          graceEndsAt: true,
          metadata: true,
          plan: { select: { id: true, code: true, name: true, intervalMonths: true } },
        },
      },
      users: {
        where: SOLO_PERSONAL,
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
  return c.json({ ...w, modules: normalizarModulos(w.enabledModules), contrato: await contratoDelTaller(id) });
});

// El contrato del taller: si se le pide, si ya lo firmó y si se puede firmar
// (sin los datos del prestador, encender el interruptor no bloquea a nadie).
async function contratoDelTaller(id: bigint) {
  const [firmado] = await prisma.$queryRaw<{ codigo: string; version: string; firmado_en: Date; firmante_nombre: string }[]>`
    SELECT codigo, version, firmado_en, firmante_nombre FROM contratos_firmados
    WHERE workshop_id = ${id} ORDER BY firmado_en DESC LIMIT 1`;
  return {
    firmado: firmado
      ? { codigo: firmado.codigo, version: firmado.version, firmadoEn: firmado.firmado_en, firmante: firmado.firmante_nombre }
      : null,
    disponible: await prestadorCompleto(),
  };
}

// PUT /talleres/:id/contrato — { requerido: bool }
//
// Encendido, el administrador del taller encuentra el contrato al entrar a su
// panel y no puede usarlo hasta firmarlo. Apagarlo no borra lo ya firmado.
const contratoSchema = z.object({ requerido: z.boolean() });
// Historial de pagos de la suscripción: lo que de verdad se cobró, venga de
// Mercado Pago (automático), ePayco (link) o un pago registrado a mano. La
// fuente es payment_transactions, que todos los caminos de cobro llenan; la
// factura solo aporta el período y el plan. Se muestra el monto de la
// transacción y no el de la factura: una suscripción de Mercado Pago creada
// antes de un cambio de precio sigue cobrando el monto viejo.
type Payload = Record<string, unknown>;
const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const numero = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : null);
const capital = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

function detalleDelPago(provider: string, raw: unknown) {
  const p = (raw && typeof raw === "object" ? raw : {}) as Payload;
  if (p.manual === true) return { origen: "manual", medio: "Registrado a mano", neto: null as number | null, cuotas: null as number | null };
  if (provider === "mercado_pago") {
    const tarjeta = (p.card ?? {}) as Payload;
    const metodo = texto(p.payment_method_id);
    const ultimos = texto(tarjeta.last_four_digits);
    const det = (p.transaction_details ?? {}) as Payload;
    return {
      origen: "mercado_pago",
      medio: metodo ? `${capital(metodo)}${ultimos ? ` •••• ${ultimos}` : ""}` : null,
      neto: numero(det.net_received_amount),
      cuotas: numero(p.installments),
    };
  }
  if (provider === "epayco") {
    const franquicia = texto(p.x_franchise);
    const banco = texto(p.x_bank_name);
    const tarjeta = texto(p.x_cardnumber);
    return {
      origen: "epayco",
      medio: [franquicia, banco, tarjeta].filter(Boolean).join(" · ") || null,
      neto: null,
      cuotas: numero(p.x_quotas),
    };
  }
  return { origen: provider, medio: null, neto: null, cuotas: null };
}

talleresRoutes.get("/:id/pagos", async (c) => {
  const id = BigInt(c.req.param("id"));
  const filas = await prisma.paymentTransaction.findMany({
    where: { workshopId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      provider: true,
      status: true,
      amount: true,
      currency: true,
      providerTxId: true,
      reference: true,
      errorMessage: true,
      rawPayload: true,
      createdAt: true,
      invoice: { select: { periodStart: true, periodEnd: true, paidAt: true, plan: { select: { name: true } } } },
    },
  });
  const pagos = filas.map((t) => {
    const d = detalleDelPago(t.provider, t.rawPayload);
    return {
      id: t.id.toString(),
      fecha: (t.invoice?.paidAt ?? t.createdAt).toISOString(),
      origen: d.origen,
      estado: t.status,
      monto: Number(t.amount),
      neto: d.neto,
      moneda: t.currency,
      medio: d.medio,
      cuotas: d.cuotas,
      transaccion: t.providerTxId,
      referencia: t.reference,
      error: t.errorMessage,
      plan: t.invoice?.plan?.name ?? null,
      periodoDesde: t.invoice?.periodStart.toISOString() ?? null,
      periodoHasta: t.invoice?.periodEnd.toISOString() ?? null,
    };
  });
  const aprobados = pagos.filter((p) => p.estado === "approved");
  return c.json({
    pagos,
    resumen: {
      cobrado: aprobados.reduce((s, p) => s + p.monto, 0),
      pagosAprobados: aprobados.length,
      rechazados: pagos.filter((p) => p.estado !== "approved" && p.estado !== "pending").length,
    },
  });
});

talleresRoutes.put("/:id/contrato", async (c) => {
  const id = BigInt(c.req.param("id"));
  const parsed = contratoSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  if (parsed.data.requerido && !(await prestadorCompleto())) {
    return c.json({ error: "Antes de pedir el contrato, llene el nombre y el documento del prestador en Sistema → Contrato de los talleres." }, 400);
  }
  const w = await prisma.workshop.update({
    where: { id },
    data: { contratoRequerido: parsed.data.requerido },
    select: { contratoRequerido: true },
  });
  return c.json({ contratoRequerido: w.contratoRequerido, contrato: await contratoDelTaller(id) });
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
  // Aviso si Mercado Pago no aceptó aplazar el cobro: el cambio queda hecho,
  // pero MP cobrará en su fecha original.
  let aviso: string | null = null;
  try {
    switch (accion) {
      case "activar":
        aviso = (await activarSuscripcion(id, planCode ?? null)).aviso;
        break;
      case "pago_manual":
        aviso = (await activarSuscripcion(id, planCode ?? null, { pagado: true })).aviso;
        break;
      case "trial":
        aviso = (await extenderTrial(id, dias ?? 15))?.aviso ?? null;
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
  // Lo que quedó, para que el panel diga exactamente qué cambió.
  const w = await prisma.workshop.findUnique({
    where: { id },
    select: {
      subscriptionStatus: true,
      isActive: true,
      trialEndsAt: true,
      subscription: { select: { status: true, trialEndsAt: true, currentPeriodEnd: true, graceEndsAt: true } },
    },
  });
  return c.json({ ...w, aviso });
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
  // Igual que la sesión de leads: si viene en bucle de caídas, un `start` a
  // secas no hace nada y el QR no aparece. `conectarSesion` la reinicia de raíz
  // solo en ese caso; si está sana no la toca.
  try {
    await conectarSesion(session);
  } catch (e) {
    if (e instanceof EstadoDesconocido) return c.json({ error: e.message }, 503);
    throw e;
  }
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

/**
 * La configuración sin un solo secreto adentro.
 *
 * Antes se devolvía `{ ...resto }` quitando a mano la clave técnica, y eso
 * dejaba de ser seguro en el momento en que la tabla ganó columnas nuevas: el
 * `client_secret` y la contraseña de Factus habrían salido cifrados —pero
 * salidos— hacia el navegador. Se listan los campos que sí se publican en vez
 * de quitar los que no, así una columna nueva no se filtra por descuido.
 */
function sinSecretos(cfg: NonNullable<Awaited<ReturnType<typeof prisma.workshopDianConfig.findUnique>>>) {
  return {
    enabled: cfg.enabled,
    environment: cfg.environment,
    personType: cfg.personType,
    documentType: cfg.documentType,
    documentNumber: cfg.documentNumber,
    dv: cfg.dv,
    legalName: cfg.legalName,
    address: cfg.address,
    city: cfg.city,
    municipalityCode: cfg.municipalityCode,
    department: cfg.department,
    email: cfg.email,
    phone: cfg.phone,
    taxRegime: cfg.taxRegime,
    responsibilities: cfg.responsibilities,
    softwareId: cfg.softwareId,
    resolutionPrefix: cfg.resolutionPrefix,
    resolutionNumber: cfg.resolutionNumber,
    rangeFrom: cfg.rangeFrom,
    rangeTo: cfg.rangeTo,
    nextInvoiceNumber: cfg.nextInvoiceNumber,
    provider: cfg.provider,
    providerEnvironment: cfg.providerEnvironment,
    factusClientId: cfg.factusClientId ?? "",
    factusUsername: cfg.factusUsername ?? "",
    factusNumberingRangeId: cfg.factusNumberingRangeId,
    factusSupportRangeId: cfg.factusSupportRangeId,
    factusCreditNoteRangeId: cfg.factusCreditNoteRangeId,
    tieneClaveTecnica: Boolean(cfg.technicalKeyEncrypted),
    tieneFactusSecret: Boolean(cfg.factusClientSecretEnc),
    tieneFactusPassword: Boolean(cfg.factusPasswordEnc),
    nextpymeBaseUrl: cfg.nextpymeBaseUrl,
    nextpymeTestSetId: cfg.nextpymeTestSetId,
    tieneNextpymeToken: Boolean(cfg.nextpymeTokenEnc),
    creditNotePrefix: cfg.creditNotePrefix,
    nextCreditNoteNumber: cfg.nextCreditNoteNumber,
    providerCertificateDaysLeft: cfg.providerCertificateDaysLeft,
    providerResolutionDaysLeft: cfg.providerResolutionDaysLeft,
  };
}

// GET /talleres/:id/dian — datos de facturación electrónica del taller.
// Los secretos nunca se devuelven, solo si existen.
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
      provider: "motordesk",
      providerEnvironment: null,
      factusClientId: "",
      factusUsername: "",
      factusNumberingRangeId: null,
      factusSupportRangeId: null,
      factusCreditNoteRangeId: null,
      tieneFactusSecret: false,
      tieneFactusPassword: false,
      nextpymeBaseUrl: null,
      nextpymeTestSetId: null,
      tieneNextpymeToken: false,
      creditNotePrefix: null,
      nextCreditNoteNumber: null,
      providerCertificateDaysLeft: null,
      providerResolutionDaysLeft: null,
    });
  }
  return c.json(sinSecretos(cfg));
});

// PUT /talleres/:id/dian — guarda emisor, resolución y software.
const textoOpcional = z.string().trim().max(255).optional().nullable();

// Lo que es igual sea quien sea el que emite: emisor, resolución y software.
const dianComun = z.object({
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
  // El próximo número, si se pide uno. Nunca retrocede: ver el PUT.
  nextInvoiceNumber: z.number().int().positive().optional().nullable(),
});

// Quién emite. Cada proveedor declara sus propios campos: con un esquema plano
// cualquier combinación pasaba, y una configuración a medias se descubría el
// día que el taller intentaba facturar, delante del cliente.
const dianSchema = z.discriminatedUnion("provider", [
  // La vía directa no transmite nada; se conserva porque los campos del emisor
  // son los que haría falta el día que se haga.
  dianComun.extend({ provider: z.literal("motordesk") }),
  dianComun.extend({
    provider: z.literal("factus"),
    providerEnvironment: z.enum(["sandbox", "production"]).default("sandbox"),
    factusClientId: z.string().trim().max(255).optional().nullable(),
    factusUsername: z.string().trim().max(255).optional().nullable(),
    // Vacíos = conservar los guardados, igual que la clave técnica.
    factusClientSecret: z.string().trim().optional().nullable(),
    factusPassword: z.string().trim().optional().nullable(),
    factusNumberingRangeId: z.number().int().positive().optional().nullable(),
    factusSupportRangeId: z.number().int().positive().optional().nullable(),
    factusCreditNoteRangeId: z.number().int().positive().optional().nullable(),
  }),
  // Nextpyme: una URL y un token. Lo demás que pide —emisor y numeración— es
  // común, porque con Nextpyme el número lo pone MotorDesk.
  dianComun.extend({
    provider: z.literal("nextpyme"),
    providerEnvironment: z.enum(["habilitacion", "production"]).default("habilitacion"),
    nextpymeBaseUrl: z.string().trim().max(255).optional().nullable(),
    // Vacío = conservar el guardado.
    nextpymeToken: z.string().trim().optional().nullable(),
    nextpymeTestSetId: z.string().trim().max(64).optional().nullable(),
    creditNotePrefix: z.string().trim().max(32).optional().nullable(),
    nextCreditNoteNumber: z.number().int().positive().optional().nullable(),
  }),
]);

/** "factusNumberingRangeId: Expected number, received string" — que se sepa cuál campo. */
function primerError(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return "Datos inválidos";
  return i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message;
}

function limpiar(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

talleresRoutes.put("/:id/dian", async (c) => {
  const id = BigInt(c.req.param("id"));
  const cuerpo = await c.req.json().catch(() => null);
  // Sin proveedor es la vía directa, como antes de que el esquema se partiera.
  const parsed = dianSchema.safeParse(
    cuerpo && typeof cuerpo === "object" && !("provider" in cuerpo) ? { ...cuerpo, provider: "motordesk" } : cuerpo,
  );
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;
  // Los campos de cada proveedor solo existen si se eligió ese proveedor.
  const fx = d.provider === "factus" ? d : null;
  const nx = d.provider === "nextpyme" ? d : null;

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

  const claveTecnica = limpiar(d.technicalKey);
  const factusSecret = limpiar(fx?.factusClientSecret);
  const factusPassword = limpiar(fx?.factusPassword);
  const nextpymeToken = limpiar(nx?.nextpymeToken);
  const nextpymeBaseUrl = limpiar(nx?.nextpymeBaseUrl)?.replace(/\/+$/, "") ?? null;

  // Lo mismo que el panel exige antes de habilitar "Guardar", repetido acá
  // porque el panel no es el único que puede llamar. Un secreto vacío vale si
  // ya hay uno guardado: vacío significa conservarlo.
  if (fx) {
    const faltan = [
      !limpiar(fx.factusClientId) && "Client ID",
      !factusSecret && !current?.factusClientSecretEnc && "Client secret",
      !limpiar(fx.factusUsername) && "Usuario (correo)",
      !factusPassword && !current?.factusPasswordEnc && "Contraseña",
      !fx.factusNumberingRangeId && "Rango para facturas de venta",
      // Sin él la caja no puede anular una venta facturada: Factus lo exige.
      !fx.factusCreditNoteRangeId && "Rango para notas crédito",
    ].filter((x): x is string => Boolean(x));
    if (faltan.length > 0) {
      return c.json({ error: `Para facturar por Factus falta: ${faltan.join(", ")}.` }, 400);
    }
  }
  if (nx) {
    const faltan = [
      !nextpymeBaseUrl && "URL de la API",
      !nextpymeToken && !current?.nextpymeTokenEnc && "Token",
      !limpiar(d.documentNumber) && "NIT del emisor",
      !limpiar(d.legalName) && "Razón social",
      !limpiar(d.resolutionNumber) && "Nº resolución",
      rangeFrom === null && "Rango desde",
      rangeTo === null && "Rango hasta",
      // Sin ellos la caja no puede anular una venta facturada.
      !limpiar(nx.creditNotePrefix) && "Prefijo de nota crédito",
      !nx.nextCreditNoteNumber && "Próximo número de nota crédito",
    ].filter((x): x is string => Boolean(x));
    if (faltan.length > 0) {
      return c.json({ error: `Para facturar por Nextpyme falta: ${faltan.join(", ")}.` }, 400);
    }
    // El token viaja en cada factura: por http iría en claro.
    if (!/^https:\/\//i.test(nextpymeBaseUrl!)) {
      return c.json({ error: "La URL de la API de Nextpyme tiene que empezar con https://." }, 400);
    }
  }

  // La numeración nunca retrocede: con prefijo nuevo arranca en el rango
  // declarado; con el mismo prefijo continúa tras el último documento emitido.
  const lastDocument = await prisma.dianElectronicDocument.findFirst({
    where: { workshopId: id, prefix: resolutionPrefix },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  // Un próximo número pedido a mano sirve para continuar una resolución que
  // el taller ya venía usando en otro sistema; igual nunca retrocede.
  const nextInvoiceNumber =
    rangeFrom === null
      ? current?.nextInvoiceNumber ?? null
      : Math.max(
          rangeFrom,
          d.nextInvoiceNumber ?? 0,
          current?.resolutionPrefix === resolutionPrefix ? current?.nextInvoiceNumber ?? 0 : 0,
          (lastDocument?.number ?? 0) + 1,
        );
  if (nextInvoiceNumber !== null && rangeTo !== null && nextInvoiceNumber > rangeTo + 1) {
    return c.json({ error: `El próximo número (${nextInvoiceNumber}) queda fuera del rango, que llega a ${rangeTo}.` }, 400);
  }

  // Lo mismo con las notas crédito: con el mismo prefijo, no se vuelve a un
  // número ya usado.
  const creditNotePrefix = limpiar(nx?.creditNotePrefix);
  const nextCreditNoteNumber = nx
    ? Math.max(
        nx.nextCreditNoteNumber ?? 1,
        current?.creditNotePrefix === creditNotePrefix ? current?.nextCreditNoteNumber ?? 0 : 0,
      )
    : null;

  // Si cambia cualquier cosa con la que se pide el token, el que está cacheado
  // deja de servir. Borrarlo es obligatorio: si no, el monolito seguiría
  // facturando con las credenciales viejas hasta que expire.
  const cambioDeCredenciales =
    d.provider !== current?.provider ||
    (fx !== null &&
      (fx.providerEnvironment !== (current?.providerEnvironment ?? null) ||
        limpiar(fx.factusClientId) !== current?.factusClientId ||
        limpiar(fx.factusUsername) !== current?.factusUsername ||
        factusSecret !== null ||
        factusPassword !== null));

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
    provider: d.provider,
    // El ambiente solo tiene sentido con proveedor tecnológico. Dejarlo puesto
    // con "motordesk" haría creer que la vía directa tiene sandbox.
    providerEnvironment: fx ? fx.providerEnvironment : nx ? nx.providerEnvironment : null,
    // Pasar a otro proveedor no borra lo de Factus: volver no obliga a pedirle
    // las credenciales al taller otra vez. Solo se escriben si se eligió Factus.
    ...(fx
      ? {
          factusClientId: limpiar(fx.factusClientId),
          factusUsername: limpiar(fx.factusUsername),
          factusNumberingRangeId: fx.factusNumberingRangeId ?? null,
          factusSupportRangeId: fx.factusSupportRangeId ?? null,
          factusCreditNoteRangeId: fx.factusCreditNoteRangeId ?? null,
        }
      : {}),
    // Igual con Nextpyme: pasar a otro proveedor no borra su URL ni su token.
    ...(nx
      ? {
          nextpymeBaseUrl,
          nextpymeTestSetId: limpiar(nx.nextpymeTestSetId),
          creditNotePrefix,
          nextCreditNoteNumber,
        }
      : {}),
    ...(cambioDeCredenciales
      ? { factusAccessToken: null, factusRefreshToken: null, factusTokenExpiresAt: null }
      : {}),
  };

  try {
    await prisma.workshopDianConfig.upsert({
      where: { workshopId: id },
      create: {
        workshopId: id,
        ...datos,
        technicalKeyEncrypted: claveTecnica ? encryptJson({ value: claveTecnica }) : null,
        // Cifrados como cadena suelta, no envueltos en `{ value }`: es la forma
        // que espera `credencialesDe` en el monolito.
        factusClientSecretEnc: factusSecret ? encryptJson(factusSecret) : null,
        factusPasswordEnc: factusPassword ? encryptJson(factusPassword) : null,
        // Cadena suelta, como los de Factus: es lo que espera el monolito.
        nextpymeTokenEnc: nextpymeToken ? encryptJson(nextpymeToken) : null,
      },
      update: {
        ...datos,
        ...(claveTecnica ? { technicalKeyEncrypted: encryptJson({ value: claveTecnica }) } : {}),
        ...(factusSecret ? { factusClientSecretEnc: encryptJson(factusSecret) } : {}),
        ...(factusPassword ? { factusPasswordEnc: encryptJson(factusPassword) } : {}),
        ...(nextpymeToken ? { nextpymeTokenEnc: encryptJson(nextpymeToken) } : {}),
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo guardar la configuración DIAN" }, 400);
  }

  // Con Factus en producción, el emisor no se teclea: se lee de Factus, que es
  // quien factura, y se guarda para el encabezado de los comprobantes. En
  // sandbox no: las credenciales son de la cuenta compartida de Factus y los
  // comprobantes del taller saldrían a nombre de Factus.
  let emisor: ReturnType<typeof compararEmisor> | null = null;
  let avisoEmisor: string | null = null;
  if (fx && fx.providerEnvironment === "production") {
    const guardada = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });
    const clientSecret = decryptJson<string>(guardada?.factusClientSecretEnc);
    const password = decryptJson<string>(guardada?.factusPasswordEnc);
    const empresa =
      guardada?.factusClientId && guardada.factusUsername && clientSecret && password
        ? await empresaDeFactus({
            ambiente: "production",
            clientId: guardada.factusClientId,
            clientSecret,
            username: guardada.factusUsername,
            password,
          })
        : null;
    if (empresa) {
      await prisma.workshopDianConfig.update({
        where: { workshopId: id },
        data: {
          documentType: "31",
          documentNumber: empresa.nit,
          dv: empresa.dv,
          legalName: empresa.nombre || null,
          personType: empresa.tipoPersona,
        },
      });
      const taller = await prisma.workshop.findUnique({ where: { id }, select: { taxId: true } });
      emisor = compararEmisor(empresa, taller?.taxId ?? null, "production");
    } else {
      avisoEmisor = "No se pudo leer de Factus a nombre de quién factura: el emisor quedó como estaba.";
    }
  }

  const cfg = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });
  return c.json({ ...sinSecretos(cfg!), emisor, avisoEmisor: avisoEmisor ?? emisor?.aviso ?? null });
});

/**
 * El emisor que dice Factus contra el número que el taller registró en su
 * Configuración (el del encabezado de sus comprobantes).
 *
 * Con Factus el NIT de la factura es el de la empresa dueña de las
 * credenciales; MotorDesk no lo manda. Si no coincide con el del taller, o se
 * pegaron las credenciales de otro taller o el taller tiene mal su número, y
 * hay que saberlo antes de la primera factura.
 *
 * El número del taller puede venir con o sin DV, con puntos o guiones.
 */
export function compararEmisor(empresa: EmpresaFactus, taxIdDelTaller: string | null, ambiente: string) {
  const delTaller = (taxIdDelTaller ?? "").replace(/\D/g, "");
  const coincide = delTaller
    ? delTaller === empresa.nit || delTaller === `${empresa.nit}${empresa.dv ?? ""}`
    : null;
  const nitLegible = `${empresa.nit}${empresa.dv ? `-${empresa.dv}` : ""}`;
  let aviso: string | null = null;
  if (ambiente !== "production") {
    aviso =
      `En sandbox las credenciales son de la cuenta compartida de Factus (${nitLegible}, ${empresa.nombre}): ` +
      "el emisor del taller no se toma de ahí. Se tomará al guardar con credenciales de producción.";
  } else if (coincide === null) {
    aviso = `El taller no tiene número de identificación en su Configuración. Factus factura a nombre de ${nitLegible} (${empresa.nombre}).`;
  } else if (!coincide) {
    aviso =
      `Estas credenciales son de ${nitLegible} (${empresa.nombre}), pero el taller registró ${taxIdDelTaller}. ` +
      "Revisa que no sean las credenciales de otro taller antes de facturar.";
  }
  return { empresa, nit: nitLegible, coincide, aviso };
}

// POST /talleres/:id/dian/probar — Factus: pide token y lista sus rangos.
// Nextpyme: valida el token y coteja el catálogo de unidades.
//
// Se prueba **antes** de guardar: unas credenciales con un carácter de más se
// ven bien en el formulario y fallan el día que el taller intenta facturar,
// delante del cliente. Los campos de secreto que lleguen vacíos se reemplazan
// por los guardados, para poder reprobar sin volver a teclearlos.
const probarSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("factus"),
    providerEnvironment: z.enum(["sandbox", "production"]).default("sandbox"),
    factusClientId: z.string().trim().optional().nullable(),
    factusUsername: z.string().trim().optional().nullable(),
    factusClientSecret: z.string().trim().optional().nullable(),
    factusPassword: z.string().trim().optional().nullable(),
  }),
  z.object({
    provider: z.literal("nextpyme"),
    nextpymeBaseUrl: z.string().trim().optional().nullable(),
    nextpymeToken: z.string().trim().optional().nullable(),
  }),
]);

talleresRoutes.post("/:id/dian/probar", async (c) => {
  const id = BigInt(c.req.param("id"));
  const cuerpo = await c.req.json().catch(() => null);
  // Sin proveedor es Factus, que era el único que se probaba.
  const parsed = probarSchema.safeParse(
    cuerpo && typeof cuerpo === "object" && !("provider" in cuerpo) ? { ...cuerpo, provider: "factus" } : cuerpo,
  );
  if (!parsed.success) return c.json({ error: primerError(parsed.error) }, 400);
  const d = parsed.data;

  const cfg = await prisma.workshopDianConfig.findUnique({ where: { workshopId: id } });

  if (d.provider === "nextpyme") {
    const baseUrl = limpiar(d.nextpymeBaseUrl) ?? cfg?.nextpymeBaseUrl ?? null;
    const token = limpiar(d.nextpymeToken) ?? decryptJson<string>(cfg?.nextpymeTokenEnc);
    if (!baseUrl || !token) return c.json({ ok: false, error: "Faltan la URL o el token de Nextpyme para probar." });
    if (!/^https:\/\//i.test(baseUrl)) {
      return c.json({ ok: false, error: "La URL de la API de Nextpyme tiene que empezar con https://." });
    }
    return c.json(await probarConexionNextpyme({ baseUrl, token }));
  }

  const clientId = limpiar(d.factusClientId) ?? cfg?.factusClientId ?? null;
  const username = limpiar(d.factusUsername) ?? cfg?.factusUsername ?? null;
  const clientSecret = limpiar(d.factusClientSecret) ?? decryptJson<string>(cfg?.factusClientSecretEnc);
  const password = limpiar(d.factusPassword) ?? decryptJson<string>(cfg?.factusPasswordEnc);

  if (!clientId || !username || !clientSecret || !password) {
    return c.json({ ok: false, error: "Faltan credenciales de Factus para probar." });
  }

  const r = await probarConexion({
    ambiente: d.providerEnvironment,
    clientId,
    clientSecret,
    username,
    password,
  });
  if (!r.ok || !r.empresa) return c.json(r);
  const taller = await prisma.workshop.findUnique({ where: { id }, select: { taxId: true } });
  return c.json({ ...r, emisor: compararEmisor(r.empresa, taller?.taxId ?? null, d.providerEnvironment) });
});

// Los respaldos viven en /backups (ver routes/backups.ts). Se deja el redirect
// para no romper a quien todavía llame la ruta vieja del panel.
talleresRoutes.post("/:id/backups", (c) =>
  c.redirect(`/api/backups/taller/${c.req.param("id")}`, 308),
);
