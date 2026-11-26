// Copia oculta de todo el correo que sale de MotorDesk.
//
// Todo correo del sistema —a talleres, a clientes, a superadmin— lleva copia
// oculta a support@, para tener en un buzón lo que se le dijo a cada quien
// (pedido del 2026-11-26). Se aplica en el único punto de salida
// (`enviarConConfig`, src/lib/email.ts). Copia de
// src/lib/correo/copia-oculta.ts del monolito: si cambia uno, cambia el otro.
//
// `EMAIL_COPIA_OCULTA` cambia la dirección; vacía, la apaga. Si el correo ya va
// para esa dirección no se repite.

const POR_DEFECTO = "support@nexcoreia.cloud";

export function copiaOcultaPara(destinatario: string): string[] {
  const copia = (process.env.EMAIL_COPIA_OCULTA ?? POR_DEFECTO).trim();
  if (!copia) return [];
  return destinatario.trim().toLowerCase() === copia.toLowerCase() ? [] : [copia];
}
