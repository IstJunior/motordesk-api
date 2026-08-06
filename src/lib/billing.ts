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

async function planPorCodigo(code: string, tx: Tx | typeof prisma = prisma) {
  const plan = await tx.subscriptionPlan.findUnique({ where: { code } });
  if (!plan || !plan.isActive) throw new Error(`Plan de suscripción no disponible: ${code}`);
  return plan;
}

// Activa/renueva un periodo pagado sin cobro real (comp o pago manual).
export async function activarSuscripcion(workshopId: bigint, planCode?: string | null) {
  return prisma.$transaction(async (tx) => {
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
    // Reactivar tras una suspensión debe devolver el preapproval de MP a cobro.
    await syncMpPreapproval(sub, "authorized");
    return sub;
  });
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

  return prisma.$transaction(async (tx) => {
    const base = existing.trialEndsAt && existing.trialEndsAt > now ? existing.trialEndsAt : now;
    const sub = await tx.subscription.update({
      where: { workshopId },
      data: { status: SUBSCRIPTION_STATUS.TRIALING, trialEndsAt: addDays(base, days), graceEndsAt: null },
    });
    await syncWorkshopFromSubscription(tx, sub.id, now);
    return sub;
  });
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
