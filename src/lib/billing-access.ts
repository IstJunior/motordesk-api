type WorkshopLike = {
  subscriptionStatus: string | null;
  isActive: boolean;
};

type SubscriptionLike = {
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
} | null;

export type BillingAccess = {
  allowed: boolean;
  state: "trial" | "active" | "grace" | "canceling" | "suspended" | "canceled" | "expired";
  message: string | null;
};

function vigente(fecha: Date | null, now: Date): boolean {
  return Boolean(fecha && fecha.getTime() >= now.getTime());
}

function fecha(fechaValor: Date | null): string {
  return fechaValor ? fechaValor.toLocaleDateString("es-CO") : "";
}

// Misma regla de acceso que conserva el monolito durante la transición.
export function billingAccess(
  workshop: WorkshopLike,
  subscription: SubscriptionLike,
  now = new Date(),
): BillingAccess {
  if (!workshop.isActive) {
    return { allowed: false, state: "suspended", message: "El taller está suspendido." };
  }

  if (subscription) {
    if (subscription.status === "trialing" && vigente(subscription.trialEndsAt, now)) {
      return { allowed: true, state: "trial", message: null };
    }
    if (subscription.status === "active" && vigente(subscription.currentPeriodEnd, now)) {
      return {
        allowed: true,
        state: subscription.cancelAtPeriodEnd ? "canceling" : "active",
        message: subscription.cancelAtPeriodEnd
          ? `Tu suscripción se cancelará el ${fecha(subscription.currentPeriodEnd)}.`
          : null,
      };
    }
    if (subscription.status === "past_due" && vigente(subscription.graceEndsAt, now)) {
      return {
        allowed: true,
        state: "grace",
        message: `El pago está vencido. El acceso continúa hasta el ${fecha(subscription.graceEndsAt)}.`,
      };
    }
    if (subscription.status === "canceled" && vigente(subscription.currentPeriodEnd, now)) {
      return {
        allowed: true,
        state: "canceling",
        message: `Tu suscripción está cancelada; el acceso termina el ${fecha(subscription.currentPeriodEnd)}.`,
      };
    }
    if (subscription.status === "canceled") {
      return { allowed: false, state: "canceled", message: "La suscripción del taller fue cancelada." };
    }
    if (subscription.status === "suspended" || subscription.status === "past_due") {
      return { allowed: false, state: "suspended", message: "La suscripción del taller está suspendida." };
    }
    return { allowed: false, state: "expired", message: "El periodo de la suscripción del taller venció." };
  }

  if (workshop.subscriptionStatus === "active") return { allowed: true, state: "active", message: null };
  if (workshop.subscriptionStatus === "trial") return { allowed: true, state: "trial", message: null };
  if (workshop.subscriptionStatus === "canceled") {
    return { allowed: false, state: "canceled", message: "La suscripción del taller fue cancelada." };
  }
  return { allowed: false, state: "suspended", message: "La suscripción del taller está suspendida." };
}
