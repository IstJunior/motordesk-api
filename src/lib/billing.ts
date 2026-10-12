// Acciones de suscripción del control-plane (superadmin). Port del
// `src/lib/billing/subscription-service.ts` del monolito, recortado a lo que
// necesita el panel: activar/registrar pago, trial, gracia, suspender, cancelar.
// Misma DB, mismas semánticas de estado → el monolito y la API coinciden.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

type Tx = Prisma.TransactionClient;

export const SUBSCRIPTION_STATUS = {
  TRIALING: "trialing",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  SUSPENDED: "suspended",
  CANCELED: "canceled",
} as const;

// Campos denormalizados del taller (gating rápido).
export const WORKSHOP_STATUS = {
  TRIAL: "trial",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  SUSPENDED: "suspended",
  CANCELED: "canceled",
} as const;

export const BILLING_PROVIDER_MERCADO_PAGO = "mercado_pago";
export const BILLING_PROVIDER_EPAYCO = "epayco";
const COLLECTION_MODE_AUTOMATIC = "automatic";
const COLLECTION_MODE_MANUAL = "manual";
export const DEFAULT_PLAN_CODE = "motordesk-monthly";

const MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN ?? "";

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

export function addBillingMonths(date: Date, months: number): Date {
  if (!Number.isInteger(months) || months <= 0) {
    throw new Error("El intervalo de facturación debe ser un entero positivo de meses.");
  }
  const result = new Date(date.getTime());
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const ultimoDia = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, ultimoDia));
  return result;
}

function isFutureOrNow(date: Date | null | undefined, now = new Date()): boolean {
  return !!date && date.getTime() >= now.getTime();
}

function collectionModeForProvider(provider: string): string {
  return provider === BILLING_PROVIDER_MERCADO_PAGO ? COLLECTION_MODE_AUTOMATIC : COLLECTION_MODE_MANUAL;
}

function workshopStateFor(
  sub: { status: string; currentPeriodEnd: Date | null; graceEndsAt: Date | null; trialEndsAt: Date | null },
  now: Date,
): { subscriptionStatus: string; isActive: boolean } {
  switch (sub.status) {
    case SUBSCRIPTION_STATUS.TRIALING:
      return { subscriptionStatus: WORKSHOP_STATUS.TRIAL, isActive: isFutureOrNow(sub.trialEndsAt, now) };
    case SUBSCRIPTION_STATUS.ACTIVE:
      return { subscriptionStatus: WORKSHOP_STATUS.ACTIVE, isActive: isFutureOrNow(sub.currentPeriodEnd, now) };
    case SUBSCRIPTION_STATUS.PAST_DUE:
      return { subscriptionStatus: WORKSHOP_STATUS.PAST_DUE, isActive: isFutureOrNow(sub.graceEndsAt, now) };
    case SUBSCRIPTION_STATUS.SUSPENDED:
      return { subscriptionStatus: WORKSHOP_STATUS.SUSPENDED, isActive: false };
    case SUBSCRIPTION_STATUS.CANCELED:
      return { subscriptionStatus: WORKSHOP_STATUS.CANCELED, isActive: isFutureOrNow(sub.currentPeriodEnd, now) };
    default:
      return { subscriptionStatus: WORKSHOP_STATUS.SUSPENDED, isActive: false };
  }
}

async function syncWorkshopFromSubscription(tx: Tx, subscriptionId: bigint, now = new Date()) {
  const sub = await tx.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return;
  const state = workshopStateFor(sub, now);
  await tx.workshop.update({
    where: { id: sub.workshopId },
    data: {
      subscriptionStatus: state.subscriptionStatus,
      isActive: state.isActive,
      trialEndsAt: sub.trialEndsAt,
      updatedAt: now,
    },
  });
}

// Empuja la decisión local al preapproval de Mercado Pago para que deje (o
// vuelva) a cobrar la tarjeta. Best-effort: el estado local ya está commiteado.
async function syncMpPreapproval(
  sub: { provider: string; mpPreapprovalId: string | null },
  status: "cancelled" | "paused" | "authorized",
) {
  if (sub.provider !== BILLING_PROVIDER_MERCADO_PAGO || !sub.mpPreapprovalId) return;
  if (!MP_TOKEN) {
    console.error("[billing/mp] falta MERCADO_PAGO_ACCESS_TOKEN — preapproval sin sincronizar", {
      preapprovalId: sub.mpPreapprovalId,
      status,
    });
    return;
  }
  try {
    const res = await fetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(sub.mpPreapprovalId)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${MP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`MP ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error("[billing/mp] preapproval status sync falló", {
      preapprovalId: sub.mpPreapprovalId,
      status,
      error: err instanceof Error ? err.message : err,
    });
  }
}

// Mercado Pago no deja mover la fecha del próximo cobro (el PUT acepta
// `start_date`, `next_payment_date` y `free_trial`, responde 200 y no cambia
// nada; probado el 2026-10-12). Lo que sí respeta es la pausa. Así que, cuando
// el superadmin extiende la prueba o regala un periodo, si MP iba a cobrar
// antes de la nueva fecha se pausa la suscripción y se anota en
// `metadata.mpReanudarEl` cuándo reanudarla. La cobranza diaria del monolito
// (src/lib/billing/cobro-aplazado.ts) la reanuda ese día y MP cobra.
//
// Devuelve un aviso para el superadmin si no se pudo: en ese caso MP cobra en
// su fecha original.
const TOLERANCIA_COBRO_MS = 60 * 60 * 1000;

async function mp<T>(ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.mercadopago.com${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${MP_TOKEN}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`MP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function metadataComoObjeto(metadata: Prisma.JsonValue | null): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

export async function alinearCobroMp(subscriptionId: bigint, primerCobro: Date): Promise<string | null> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.provider !== BILLING_PROVIDER_MERCADO_PAGO || !sub.mpPreapprovalId) return null;
  if (!MP_TOKEN) return "Falta MERCADO_PAGO_ACCESS_TOKEN: Mercado Pago cobrará en su fecha original.";

  const id = encodeURIComponent(sub.mpPreapprovalId);
  try {
    const actual = await mp<{ status?: string; next_payment_date?: string }>(`/preapproval/${id}`);
    if (actual.status === "cancelled") {
      return "La suscripción en Mercado Pago está cancelada: el taller tendrá que registrar de nuevo su tarjeta.";
    }
    const siguiente = actual.next_payment_date ? new Date(actual.next_payment_date) : null;
    const cobraAntes = !siguiente || siguiente.getTime() < primerCobro.getTime() - TOLERANCIA_COBRO_MS;
    const metadata = metadataComoObjeto(sub.metadata);

    if (cobraAntes) {
      if (actual.status !== "paused") {
        await mp(`/preapproval/${id}`, { method: "PUT", body: JSON.stringify({ status: "paused" }) });
      }
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { metadata: { ...metadata, mpReanudarEl: primerCobro.toISOString() } as Prisma.InputJsonValue },
      });
    } else {
      // MP ya cobra en la fecha o después: no hace falta pausa.
      if (actual.status === "paused") {
        await mp(`/preapproval/${id}`, { method: "PUT", body: JSON.stringify({ status: "authorized" }) });
      }
      if ("mpReanudarEl" in metadata) {
        const { mpReanudarEl: _quitada, ...resto } = metadata;
        void _quitada;
        await prisma.subscription.update({ where: { id: sub.id }, data: { metadata: resto as Prisma.InputJsonValue } });
      }
    }
    return null;
  } catch (err) {
    console.error("[billing/mp] no se pudo aplazar el cobro", {
      preapprovalId: sub.mpPreapprovalId,
      primerCobro: primerCobro.toISOString(),
      error: err instanceof Error ? err.message : err,
    });
    return "No se pudo aplazar el cobro en Mercado Pago: cobrará en su fecha original. Intenta de nuevo.";
  }
}

async function planPorCodigo(code: string, tx: Tx | typeof prisma = prisma) {
  const plan = await tx.subscriptionPlan.findUnique({ where: { code } });
  if (!plan || !plan.isActive) throw new Error(`Plan de suscripción no disponible: ${code}`);
  return plan;
}

// Activa/renueva un periodo pagado sin cobro real (comp o pago manual).
export async function activarSuscripcion(workshopId: bigint, planCode?: string | null) {
  const sub = await prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({ where: { workshopId }, include: { plan: true } });
    const plan = planCode
      ? await planPorCodigo(planCode, tx)
      : existing?.plan ?? (await planPorCodigo(DEFAULT_PLAN_CODE, tx));
    const now = new Date();
    const provider = existing?.provider ?? BILLING_PROVIDER_EPAYCO;
    const data = {
      planId: plan.id,
      provider,
      collectionMode: collectionModeForProvider(provider),
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: addBillingMonths(now, plan.intervalMonths),
      graceEndsAt: null,
      trialEndsAt: null,
      lastPaymentAt: now,
    };
    const sub = await tx.subscription.upsert({
      where: { workshopId },
      create: { workshopId, ...data },
      update: data,
    });
    await syncWorkshopFromSubscription(tx, sub.id, now);
    return sub;
  });
  // El periodo se regaló: MP tiene que volver a cobrar (si estaba suspendida)
  // pero recién cuando termine, no en su fecha de siempre.
  const aviso = await alinearCobroMp(sub.id, sub.currentPeriodEnd!);
  return { sub, aviso };
}

// Extiende (o concede) trial N días desde el mayor entre hoy y el fin actual.
export async function extenderTrial(workshopId: bigint, days = 15) {
  const existing = await prisma.subscription.findUnique({ where: { workshopId } });
  const now = new Date();

  if (!existing) {
    // Sin fila de suscripción: cae a los campos denormalizados del taller.
    const w = await prisma.workshop.findUnique({ where: { id: workshopId }, select: { trialEndsAt: true } });
    const base = w?.trialEndsAt && w.trialEndsAt > now ? w.trialEndsAt : now;
    await prisma.workshop.update({
      where: { id: workshopId },
      data: {
        subscriptionStatus: WORKSHOP_STATUS.TRIAL,
        isActive: true,
        trialEndsAt: addDays(base, days),
        updatedAt: now,
      },
    });
    return null;
  }

  // Se extiende desde lo que el taller ya tiene: el fin de la prueba o, si está
  // pagando, el fin del periodo pagado. Antes se contaba solo desde la prueba,
  // y «extender 15 días» a un taller con 20 días pagados le quitaba 5.
  const tieneHasta = [existing.trialEndsAt, existing.currentPeriodEnd]
    .filter((d): d is Date => !!d && d > now)
    .reduce((max, d) => (d > max ? d : max), now);
  const trialEndsAt = addDays(tieneHasta, days);
  // Con la fecha nueva vuelve a tocar el aviso de «tu prueba termina pronto».
  const metadata = metadataComoObjeto(existing.metadata);
  const reminders = { ...metadataComoObjeto((metadata.reminders ?? null) as Prisma.JsonValue) };
  delete reminders.trial_ending;

  const sub = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.update({
      where: { workshopId },
      data: {
        status: SUBSCRIPTION_STATUS.TRIALING,
        trialEndsAt,
        graceEndsAt: null,
        metadata: { ...metadata, reminders } as Prisma.InputJsonValue,
      },
    });
    await syncWorkshopFromSubscription(tx, sub.id, now);
    return sub;
  });
  // Con tarjeta, el cobro se corre a la nueva fecha.
  const aviso = await alinearCobroMp(sub.id, trialEndsAt);
  return { sub, aviso };
}

// Periodo de gracia: past_due con N días desde hoy.
export async function darGracia(workshopId: bigint, days = 5) {
  const existing = await prisma.subscription.findUnique({ where: { workshopId } });
  if (!existing) return null;
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const sub = await tx.subscription.update({
      where: { workshopId },
      data: { status: SUBSCRIPTION_STATUS.PAST_DUE, graceEndsAt: addDays(now, days) },
    });
    await syncWorkshopFromSubscription(tx, sub.id, now);
    return sub;
  });
}

export async function suspenderSuscripcion(workshopId: bigint) {
  const existing = await prisma.subscription.findUnique({ where: { workshopId } });
  if (!existing) {
    await prisma.workshop.update({
      where: { id: workshopId },
      data: { subscriptionStatus: WORKSHOP_STATUS.SUSPENDED, isActive: false, updatedAt: new Date() },
    });
    return null;
  }
  const sub = await prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.update({
      where: { workshopId },
      data: { status: SUBSCRIPTION_STATUS.SUSPENDED },
    });
    await syncWorkshopFromSubscription(tx, updated.id);
    return updated;
  });
  // Suspender debe cortar el cobro automático de MP mientras dure la suspensión.
  await syncMpPreapproval(sub, "paused");
  return sub;
}

// Cancelación inmediata (hard cancel del superadmin).
export async function cancelarSuscripcion(workshopId: bigint) {
  const existing = await prisma.subscription.findUnique({ where: { workshopId } });
  if (!existing) return null;
  const sub = await prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.update({
      where: { workshopId },
      data: { status: SUBSCRIPTION_STATUS.CANCELED, cancelAtPeriodEnd: true, canceledAt: new Date() },
    });
    await syncWorkshopFromSubscription(tx, updated.id);
    return updated;
  });
  await syncMpPreapproval(sub, "cancelled");
  return sub;
}

export function listarPlanes() {
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, code: true, name: true, amount: true, currency: true, intervalMonths: true },
  });
}
