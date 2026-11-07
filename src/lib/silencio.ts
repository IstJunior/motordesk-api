// Modo silencio por taller: se registra todo, no sale nada (ni correo, ni
// WhatsApp, ni push). Lo lee el monolito en `src/lib/notificaciones/silencio.ts`
// con esta misma clave; vive en `system_settings` como lista de ids para
// cambiarlo sin desplegar. El monolito lo relee cada 30 s.
//
// Sirve para el taller de demostración mientras se graba o se prueba: los
// avisos se disparan y se anotan igual, pero a ningún cliente le llega nada.
import { prisma } from "./db.js";

export const CLAVE_TALLERES_SILENCIADOS = "notificaciones_silenciadas_talleres";

async function idsSilenciados(): Promise<string[]> {
  const fila = await prisma.systemSetting.findUnique({ where: { key: CLAVE_TALLERES_SILENCIADOS }, select: { value: true } });
  return Array.isArray(fila?.value) ? fila.value.map(String) : [];
}

export async function tallerSilenciado(id: bigint): Promise<boolean> {
  return (await idsSilenciados()).includes(id.toString());
}

/**
 * Enciende o apaga el silencio de un taller.
 *
 * Lee y escribe la lista en una transacción con la fila bloqueada: dos cambios
 * a la vez sobre talleres distintos no se pisan.
 */
export async function silenciarTaller(id: bigint, silenciado: boolean): Promise<boolean> {
  const clave = id.toString();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO system_settings (key, value, created_at, updated_at)
      VALUES (${CLAVE_TALLERES_SILENCIADOS}, '[]'::jsonb, now(), now())
      ON CONFLICT (key) DO NOTHING`;
    const [fila] = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM system_settings WHERE key = ${CLAVE_TALLERES_SILENCIADOS} FOR UPDATE`;
    const ids = new Set(Array.isArray(fila?.value) ? fila.value.map(String) : []);
    if (silenciado) ids.add(clave);
    else ids.delete(clave);
    await tx.systemSetting.update({
      where: { key: CLAVE_TALLERES_SILENCIADOS },
      data: { value: [...ids], updatedAt: new Date() },
    });
  });
  return tallerSilenciado(id);
}
