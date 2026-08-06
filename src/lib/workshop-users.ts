// Usuarios del taller (staff). Mismo modelo que el monolito: `users` global +
// membresía en `workshop_user` con rol. El acceso se hace con Supabase Auth:
// si el proveedor define una contraseña se crea la cuenta ahí mismo; si no, el
// registro queda enlazado por correo y la persona la define al entrar.

import { prisma } from "./db.js";
import { crearOActualizarAuthUser, supabaseAdminDisponible } from "./supabase-admin.js";

export { supabaseAdminDisponible };

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

export type ResultadoAlta = {
  // creado: cuenta nueva · agregado: la cuenta existía y entra al taller
  // actualizado: ya pertenecía al taller (se ajusta el rol / la contraseña)
  estado: "creado" | "agregado" | "actualizado";
  accesoCreado: boolean;
};

export async function agregarUsuario(
  workshopId: bigint,
  datos: { nombre: string; email: string; role: string; password?: string },
): Promise<ResultadoAlta> {
  const email = datos.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("Correo inválido.");
  if (!esRolValido(datos.role)) throw new Error("Rol inválido.");
  const password = datos.password?.trim() || "";
  if (password && password.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres.");
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (user?.isSuperAdmin) throw new Error("No puedes asignar un superadmin a un taller.");

  const yaExistia = Boolean(user);
  const nombre = datos.nombre.trim() || user?.name || email;

  if (!user) {
    const now = new Date();
    user = await prisma.user.create({
      data: { name: nombre, email, password: "", createdAt: now, updatedAt: now },
    });
  } else if (user.deletedAt) {
    user = await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
  }

  const membresia = await prisma.workshopUser.findUnique({
    where: { userId_workshopId: { userId: user.id, workshopId } },
    select: { id: true },
  });

  // La contraseña vive en Supabase Auth, no en la tabla `users`.
  let accesoCreado = false;
  if (password) {
    try {
      const authUid = await crearOActualizarAuthUser({ email, password, name: nombre });
      await prisma.user.update({
        where: { id: user.id },
        data: { authId: authUid, emailVerifiedAt: new Date(), name: nombre },
      });
      accesoCreado = true;
    } catch (e) {
      // Si la cuenta es nueva y no se pudo crear el acceso, no dejar el registro a medias.
      if (!yaExistia && !membresia) {
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      }
      throw e;
    }
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

  return {
    estado: membresia ? "actualizado" : yaExistia ? "agregado" : "creado",
    accesoCreado,
  };
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

// Cambia (o crea) la contraseña de acceso de un usuario del taller, incluido el
// dueño. La contraseña vive en Supabase Auth.
export async function cambiarPassword(workshopId: bigint, membresiaId: bigint, password: string) {
  const clave = password.trim();
  if (clave.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");

  const membresia = await prisma.workshopUser.findFirst({
    where: { id: membresiaId, workshopId },
    select: { user: { select: { id: true, name: true, email: true, isSuperAdmin: true } } },
  });
  if (!membresia) throw new Error("Usuario no pertenece al taller.");
  if (membresia.user.isSuperAdmin) throw new Error("No puedes cambiar la contraseña de un superadmin.");

  const authUid = await crearOActualizarAuthUser({
    email: membresia.user.email,
    password: clave,
    name: membresia.user.name,
  });
  await prisma.user.update({
    where: { id: membresia.user.id },
    data: { authId: authUid, emailVerifiedAt: new Date() },
  });
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
