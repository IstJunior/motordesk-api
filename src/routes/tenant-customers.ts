import { Hono } from "hono";
import type { Prisma } from "@prisma/client";
import {
  requireActiveWorkshop,
  requireWorkshop,
  requireWorkshopRole,
} from "../auth/workshop.js";
import { prisma } from "../lib/db.js";

export const tenantCustomersRoutes = new Hono();
tenantCustomersRoutes.use("*", requireWorkshop);
tenantCustomersRoutes.use("*", requireActiveWorkshop);
tenantCustomersRoutes.use(
  "*",
  requireWorkshopRole(
    "workshop_admin",
    "workshop_manager",
    "workshop_receptionist",
    "workshop_viewer",
  ),
);

function customerId(raw: string | undefined): bigint | null {
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

function customerScope(workshopId: bigint): Prisma.UserWhereInput {
  return {
    deletedAt: null,
    isSuperAdmin: false,
    workshops: {
      none: {
        workshopId,
        role: { not: "client" },
      },
    },
    OR: [
      { workshops: { some: { workshopId, role: "client" } } },
      { appointments: { some: { workshopId, deletedAt: null } } },
    ],
  };
}

tenantCustomersRoutes.get("/", async (c) => {
  const workshop = c.get("workshop");
  const query = (c.req.query("q") ?? "").trim();
  const customers = await prisma.user.findMany({
    where: {
      AND: [
        customerScope(workshop.id),
        ...(query
          ? [{
              OR: [
                { name: { contains: query, mode: "insensitive" as const } },
                { email: { contains: query, mode: "insensitive" as const } },
                { phone: { contains: query, mode: "insensitive" as const } },
              ],
            }]
          : []),
      ],
    },
    take: 100,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
      appointments: {
        where: { workshopId: workshop.id, deletedAt: null },
        orderBy: { scheduledAt: "desc" },
        take: 1,
        select: { scheduledAt: true },
      },
      _count: {
        select: {
          appointments: {
            where: { workshopId: workshop.id, deletedAt: null },
          },
          vehicles: {
            where: {
              deletedAt: null,
              appointments: { some: { workshopId: workshop.id, deletedAt: null } },
            },
          },
        },
      },
    },
  });

  const rows = customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    appointmentsCount: customer._count.appointments,
    vehiclesCount: customer._count.vehicles,
    lastAppointment: customer.appointments[0]?.scheduledAt ?? null,
  }));
  rows.sort((a, b) => {
    const aTime = a.lastAppointment?.getTime() ?? 0;
    const bTime = b.lastAppointment?.getTime() ?? 0;
    return bTime - aTime || a.name.localeCompare(b.name);
  });
  return c.json(rows);
});

tenantCustomersRoutes.get("/:id", async (c) => {
  const workshop = c.get("workshop");
  const id = customerId(c.req.param("id"));
  if (!id) return c.json({ error: "Cliente inválido" }, 400);

  const customer = await prisma.user.findFirst({
    where: {
      id,
      ...customerScope(workshop.id),
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
      emailVerifiedAt: true,
      vehicles: {
        where: {
          deletedAt: null,
          appointments: { some: { workshopId: workshop.id, deletedAt: null } },
        },
        orderBy: { id: "desc" },
        select: {
          id: true,
          type: true,
          brand: true,
          model: true,
          year: true,
          licensePlate: true,
          color: true,
          vin: true,
          kilometers: true,
          engineType: true,
          transmission: true,
          isActive: true,
        },
      },
      appointments: {
        where: { workshopId: workshop.id, deletedAt: null },
        orderBy: { scheduledAt: "desc" },
        take: 100,
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          totalAmount: true,
          paymentStatus: true,
          vehicle: {
            select: {
              id: true,
              brand: true,
              model: true,
              licensePlate: true,
            },
          },
          service: { select: { id: true, name: true } },
          appointmentServices: {
            select: { service: { select: { id: true, name: true } } },
          },
          technician: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!customer) return c.json({ error: "Cliente no encontrado" }, 404);

  return c.json({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    emailVerifiedAt: customer.emailVerifiedAt,
    vehicles: customer.vehicles,
    appointments: customer.appointments.map((appointment) => ({
      id: appointment.id,
      scheduledAt: appointment.scheduledAt,
      status: appointment.status,
      totalAmount: appointment.totalAmount,
      paymentStatus: appointment.paymentStatus,
      vehicle: appointment.vehicle,
      services: [
        ...appointment.appointmentServices.map((entry) => entry.service),
        ...(!appointment.appointmentServices.length && appointment.service
          ? [appointment.service]
          : []),
      ],
      technician: appointment.technician,
    })),
  });
});
