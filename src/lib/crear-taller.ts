// Alta de taller desde el panel del proveedor.
//
// Replica la semántica de `src/lib/signup/create-workshop.ts` del monolito
// (slug único, código T-0001 desde la secuencia de Postgres, dueño con rol
// workshop_admin, horarios por defecto) y añade lo que el registro público no
// hace: sembrar el catálogo de servicios y sus checklists, y dejar el taller
// activo con trial en vez de suspendido a la espera del pago.
import { prisma } from "./db.js";
import { extenderTrial } from "./billing.js";
import { agregarUsuario } from "./workshop-users.js";
import { normalizarTipoTaller, tiposVehiculoPorDefecto, type TipoTaller } from "./workshop-types.js";
import { plantillaDeTaller, preciosDe } from "./plantillas.js";
import { modulosPorDefecto } from "./modules.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugificar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 45);
}

async function slugUnico(nombre: string): Promise<string> {
  const base = slugificar(nombre) || `taller-${Date.now()}`;
  for (let i = 0; i < 25; i++) {
    const candidato = i === 0 ? base : `${base}-${i + 1}`;
    const existe = await prisma.workshop.findUnique({
      where: { slug: candidato },
      select: { id: true },
    });
    if (!existe) return candidato;
  }
  return `${base}-${Math.floor(Date.now() / 1000)}`;
}

// Código de taller (T-0001) desde `workshop_code_seq`. El correlativo no se
// reusa aunque el taller se elimine, igual que en el registro público.
async function codigoTaller(tx: { $queryRawUnsafe: <T>(sql: string) => Promise<T> }): Promise<string> {
  const filas = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('workshop_code_seq') AS n`);
  return `T-${String(Number(filas[0]!.n)).padStart(4, "0")}`;
}

const HORARIO_POR_DEFECTO = [
  { dia: "sunday", abre: "08:00:00", cierra: "18:00:00", cerrado: true },
  { dia: "monday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
  { dia: "tuesday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
  { dia: "wednesday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
  { dia: "thursday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
  { dia: "friday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
  { dia: "saturday", abre: "08:00:00", cierra: "18:00:00", cerrado: false },
] as const;

export type DatosNuevoTaller = {
  nombre: string;
  email: string;
  tipo?: string;
  telefono?: string | null;
  ciudad?: string | null;
  direccion?: string | null;
  // Dueño. Si no se manda `duenoEmail`, se usa el correo del taller.
  duenoNombre: string;
  duenoEmail?: string | null;
  duenoPassword?: string | null;
  // Días de trial al crear (0 = sin trial, queda suspendido).
  diasTrial?: number;
  // Sembrar catálogo de servicios + checklists.
  sembrarPlantillas?: boolean;
};

export type ResultadoAlta = {
  id: string;
  nombre: string;
  slug: string;
  code: string;
  tipo: TipoTaller;
  servicios: number;
  checklists: number;
  accesoCreado: boolean;
  duenoEmail: string;
};

export async function crearTaller(datos: DatosNuevoTaller): Promise<ResultadoAlta> {
  const nombre = datos.nombre.trim();
  if (nombre.length < 2) throw new Error("El nombre del taller es obligatorio.");

  const email = datos.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("El correo del taller no es válido.");

  const duenoEmail = (datos.duenoEmail?.trim() || email).toLowerCase();
  if (!EMAIL_RE.test(duenoEmail)) throw new Error("El correo del dueño no es válido.");

  const duenoNombre = datos.duenoNombre.trim();
  if (duenoNombre.length < 2) throw new Error("El nombre del dueño es obligatorio.");

  const yaExiste = await prisma.workshop.findUnique({ where: { email }, select: { id: true } });
  if (yaExiste) throw new Error(`Ya hay un taller registrado con el correo ${email}.`);

  const tipo = normalizarTipoTaller(datos.tipo);
  const slug = await slugUnico(nombre);
  const ahora = new Date();

  const taller = await prisma.$transaction(async (tx) => {
    const code = await codigoTaller(tx);
    const w = await tx.workshop.create({
      data: {
        name: nombre,
        slug,
        code,
        email,
        phone: datos.telefono?.trim() || null,
        city: datos.ciudad?.trim() || null,
        address: datos.direccion?.trim() || null,
        country: "CO",
        workshopType: tipo,
        vehicleTypes: tiposVehiculoPorDefecto(tipo),
        enabledModules: modulosPorDefecto(),
        // El trial se aplica después con la misma función que usa el panel.
        // Hasta entonces queda suspendido: si algo falla, no queda un taller
        // activo a medio construir.
        subscriptionStatus: "suspended",
        isActive: false,
        createdAt: ahora,
        updatedAt: ahora,
      },
      select: { id: true, code: true, slug: true, name: true },
    });

    // Horarios por defecto (lunes a sábado 8-18, domingo cerrado).
    for (const h of HORARIO_POR_DEFECTO) {
      await tx.$executeRawUnsafe(
        `INSERT INTO workshop_schedules
           (workshop_id, day_of_week, opens_at, closes_at, is_closed, created_at, updated_at)
         VALUES ($1, $2, CAST($3 AS time), CAST($4 AS time), $5, now(), now())
         ON CONFLICT (workshop_id, day_of_week) DO NOTHING`,
        w.id,
        h.dia,
        h.abre,
        h.cierra,
        h.cerrado,
      );
    }

    return w;
  });

  // Dueño: reusa el alta de staff, que ya resuelve crear la cuenta en Supabase
  // Auth cuando se da contraseña, o enlazar por correo cuando no.
  const alta = await agregarUsuario(taller.id, {
    nombre: duenoNombre,
    email: duenoEmail,
    role: "workshop_admin",
    password: datos.duenoPassword?.trim() || undefined,
  });
  await prisma.workshopUser.updateMany({
    where: { workshopId: taller.id, user: { email: duenoEmail } },
    data: { isOwner: true },
  });

  // Catálogo de servicios + checklist de cada uno.
  let servicios = 0;
  let checklists = 0;
  if (datos.sembrarPlantillas !== false) {
    for (const s of plantillaDeTaller(tipo)) {
      const servicio = await prisma.service.create({
        data: {
          workshopId: taller.id,
          name: s.nombre,
          durationMinutes: s.duracionMin,
          ...preciosDe(s),
          isActive: true,
          createdAt: ahora,
          updatedAt: ahora,
        },
        select: { id: true },
      });
      servicios++;

      if (s.checklist.length > 0) {
        await prisma.checklistTemplate.create({
          data: {
            workshopId: taller.id,
            serviceId: servicio.id,
            name: s.nombre,
            description: "Plantilla base creada con el taller. Editable desde Checklists.",
            isActive: true,
            items: {
              create: s.checklist.map((label, i) => ({ label, sortOrder: i, required: true })),
            },
          },
        });
        checklists++;
      }
    }
  }

  // Trial (deja el taller activo). Con 0 días se queda suspendido a propósito.
  const dias = datos.diasTrial ?? 15;
  if (dias > 0) await extenderTrial(taller.id, dias);

  return {
    id: taller.id.toString(),
    nombre: taller.name,
    slug: taller.slug,
    code: taller.code ?? "",
    tipo,
    servicios,
    checklists,
    accesoCreado: alta.accesoCreado,
    duenoEmail,
  };
}
