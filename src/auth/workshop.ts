import type { Context, Next } from "hono";
import { prisma } from "../lib/db.js";
import { billingAccess, type BillingAccess } from "../lib/billing-access.js";
import { normalizarModulos, type Modulo } from "../lib/modules.js";

export type WorkshopContext = {
  id: bigint;
  code: string | null;
  slug: string;
  name: string;
  role: string;
  isOwner: boolean;
  whatsappSession: string | null;
  modules: Record<Modulo, boolean>;
  billing: BillingAccess;
};

// Resuelve el taller exclusivamente desde las membresías del usuario. Si tiene
// varias, la SPA debe enviar X-Workshop-Id; el cliente nunca puede autodeclarar
// acceso a un taller que no aparece en workshop_user.
export async function requireWorkshop(c: Context, next: Next) {
  const user = c.get("user");
  if (!user) return c.json({ error: "No autenticado" }, 401);
  if (user.workshops.length === 0) return c.json({ error: "Sin taller asignado" }, 403);

  const requested = c.req.header("X-Workshop-Id")?.trim();
  let membership = user.workshops.length === 1 ? user.workshops[0] : undefined;
  if (requested) {
    if (!/^\d+$/.test(requested)) return c.json({ error: "Taller inválido" }, 400);
    membership = user.workshops.find((entry) => entry.workshopId === BigInt(requested));
  }
  if (!membership) {
    return c.json(
      { error: "Debes seleccionar un taller", code: "WORKSHOP_REQUIRED" },
      user.workshops.length > 1 ? 409 : 403,
    );
  }

  const workshop = await prisma.workshop.findFirst({
    where: { id: membership.workshopId, deletedAt: null },
    select: {
      id: true,
      code: true,
      slug: true,
      name: true,
      isActive: true,
      subscriptionStatus: true,
      enabledModules: true,
      whatsappSession: true,
      subscription: {
        select: {
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          graceEndsAt: true,
          cancelAtPeriodEnd: true,
        },
      },
    },
  });
  if (!workshop) return c.json({ error: "Taller no encontrado" }, 404);

  c.set("workshop", {
    id: workshop.id,
    code: workshop.code,
    slug: workshop.slug,
    name: workshop.name,
    role: membership.role,
    isOwner: membership.isOwner,
    whatsappSession: workshop.whatsappSession,
    modules: normalizarModulos(workshop.enabledModules),
    billing: billingAccess(workshop, workshop.subscription),
  });
  await next();
}

export async function requireActiveWorkshop(c: Context, next: Next) {
  const workshop = c.get("workshop");
  if (!workshop) return c.json({ error: "Taller no resuelto" }, 500);
  if (!workshop.billing.allowed) {
    return c.json(
      {
        error: workshop.billing.message ?? "El taller no tiene acceso",
        code: "WORKSHOP_ACCESS_BLOCKED",
        state: workshop.billing.state,
      },
      403,
    );
  }
  await next();
}

export function requireWorkshopRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const workshop = c.get("workshop");
    if (!workshop) return c.json({ error: "Taller no resuelto" }, 500);
    if (!roles.includes(workshop.role)) return c.json({ error: "Sin permiso" }, 403);
    await next();
  };
}

export function requireWorkshopModule(module: Modulo) {
  return async (c: Context, next: Next) => {
    const workshop = c.get("workshop");
    if (!workshop) return c.json({ error: "Taller no resuelto" }, 500);
    if (!workshop.modules[module]) return c.json({ error: "Módulo no habilitado", module }, 403);
    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    workshop: WorkshopContext;
  }
}
