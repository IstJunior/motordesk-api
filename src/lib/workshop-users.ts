// Usuarios del taller (staff). Mismo modelo que el monolito: `users` global +
// membresía en `workshop_user` con rol. La contraseña queda vacía: el acceso
// real se hace con Supabase Auth y se enlaza por email en el primer login.

import { prisma } from "./db.js";

export const ROLES_TALLER = [
  { value: "workshop_admin", label: "Administrador" },
  { value: "workshop_manager", label: "Gerente" },
  { value: "workshop_receptionist", label: "Recepcionista" },
  { value: "workshop_technician", label: "Técnico" },
  { value: "workshop_viewer", label: "Solo lectura" },
] as const;

export function esRolValido(role: string): boolean {
  return ROLES_TALLER.some((r) => r.value === role);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// El monolito (Laravel/Spatie) lee `roles`/`model_has_roles` para permisos: se
// mantiene sincronizado mientras ambos convivan. La fuente de verdad del rol es
// `workshop_user`, así que un fallo aquí se registra pero no tumba el alta.
async function sincronizarRolSpatie(userId: bigint, role: string) {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO roles (name, guard_name) VALUES ($1, 'web') ON CONFLICT DO NOTHING`,
      role,
    );
    const filas = await prisma.$queryRawUnsafe<{ id: bigint | number }[]>(
      `SELECT id FROM roles WHERE name = $1`,
      role,
    );
    if (filas.length === 0) return;
    // model_id y role_id son bigint: se pasan como BigInt, no como texto.
    await prisma.$executeRawUnsafe(
      `INSERT INTO model_has_roles (role_id, model_type, model_id) VALUES ($1, 'App\\Models\\User', $2) ON CONFLICT DO NOTHING`,
      BigInt(filas[0].id),
      userId,
    );
  } catch (e) {
    console.error("[usuarios] No se pudo sincronizar el rol Spatie:", e instanceof Error ? e.message : e);
  }
}

export function listarUsuarios(workshopId: bigint) {
  return prisma.workshopUser.findMany({
    where: { workshopId },
    select: {
      id: true,
      role: true,
      isOwner: true,
      user: { select: { id: true, name: true, email: true, deletedAt: true } },
    },
    orderBy: [{ isOwner: "desc" }, { id: "asc" }],
  });
}

export async function agregarUsuario(
  workshopId: bigint,
  datos: { nombre: string; email: string; role: string },
) {
  const email = datos.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("Correo inválido.");
  if (!esRolValido(datos.role)) throw new Error("Rol inválido.");

  let user = await prisma.user.findUnique({ where: { email } });
  if (user?.isSuperAdmin) throw new Error("No puedes asignar un superadmin a un taller.");
  if (!user) {
    const now = new Date();
    user = await prisma.user.create({
      data: {
        name: datos.nombre.trim() || email,
        email,
        password: "",
        createdAt: now,
        updatedAt: now,
      },
    });
  } else if (user.deletedAt) {
    user = await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
  }

  await prisma.workshopUser.upsert({
    where: { userId_workshopId: { userId: user.id, workshopId } },
    create: {
      workshopId,
      userId: user.id,
      role: datos.role,
      isOwner: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    update: { role: datos.role, updatedAt: new Date() },
  });
  await sincronizarRolSpatie(user.id, datos.role);
  return user;
}

export async function cambiarRol(workshopId: bigint, membresiaId: bigint, role: string) {
  if (!esRolValido(role)) throw new Error("Rol inválido.");
  const membresia = await prisma.workshopUser.findFirst({
    where: { id: membresiaId, workshopId },
    select: { id: true, userId: true, isOwner: true },
  });
  if (!membresia) throw new Error("Usuario no pertenece al taller.");
  await prisma.workshopUser.update({
    where: { id: membresia.id },
    data: { role, updatedAt: new Date() },
  });
  await sincronizarRolSpatie(membresia.userId, role);
}

export async function quitarUsuario(workshopId: bigint, membresiaId: bigint) {
  const membresia = await prisma.workshopUser.findFirst({
    where: { id: membresiaId, workshopId },
    select: { id: true, isOwner: true },
  });
  if (!membresia) throw new Error("Usuario no pertenece al taller.");
  if (membresia.isOwner) throw new Error("No puedes quitar al dueño del taller.");
  await prisma.workshopUser.delete({ where: { id: membresia.id } });
}
