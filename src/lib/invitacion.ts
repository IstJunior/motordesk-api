import { enviarCorreo, correoDisponible, faltantesCorreo } from "./email.js";
import { bulletList, codeBox, dataTable, note, paragraph, renderEmail } from "./email-template.js";
import { enlaceDefinirPassword } from "./supabase-admin.js";

// Invitación al taller que el proveedor da de alta.
//
// Es un correo distinto al que recibe un taller que se registró solo. Aquel
// confirma un pago que la persona acaba de hacer; este llega sin que nadie lo
// esté esperando, así que tiene que presentarse: qué es MotorDesk, por qué le
// escribimos y qué hacer ahora.
//
// Nunca lleva la contraseña escrita. Aunque el superadmin haya asignado una al
// crear el taller, mandarla por correo la deja en un buzón para siempre; en su
// lugar va un enlace de un solo uso para que el dueño defina la suya.

function appOrigin(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://motordesk.nexcoreia.com";
  return raw.replace(/\/+$/, "");
}

export type DatosInvitacion = {
  taller: string;
  codigo: string;
  duenoNombre: string;
  duenoEmail: string;
  /** Días de prueba concedidos al dar de alta, si los hay. */
  diasTrial?: number | null;
  /** El superadmin asignó una contraseña al crear el taller. */
  conAcceso: boolean;
};

export type ResultadoInvitacion =
  | { enviada: true; a: string }
  | { enviada: false; motivo: string };

export async function enviarInvitacionTaller(datos: DatosInvitacion): Promise<ResultadoInvitacion> {
  if (!(await correoDisponible())) {
    const faltan = await faltantesCorreo();
    return { enviada: false, motivo: `Correo sin configurar en Sistema → Correo saliente: falta ${faltan.join(", ")}.` };
  }

  const login = `${appOrigin()}/login`;
  const enlace = await enlaceDefinirPassword(datos.duenoEmail, `${appOrigin()}/restablecer`);

  const datosAcceso: Array<[string, string]> = [
    ["Taller", datos.taller],
    ["Correo de acceso", datos.duenoEmail],
  ];
  if (datos.diasTrial && datos.diasTrial > 0) {
    datosAcceso.push(["Prueba gratis", `${datos.diasTrial} días`]);
  }

  const blocks = [
    paragraph(`Hola ${datos.duenoNombre},`),
    paragraph(
      "Te damos la bienvenida a MotorDesk. Creamos la cuenta de tu taller y ya está lista para que entres: " +
        "aquí vas a manejar los turnos, el historial de tus clientes, el inventario y los cobros, todo en un solo lugar.",
    ),
    dataTable(datosAcceso),
    codeBox("Código de tu taller", datos.codigo),
    paragraph("Guarda este código: identifica a tu taller, es único y no cambia. Tu equipo lo necesita para entrar."),
    enlace
      ? paragraph("Para empezar, define tu contraseña con el botón de abajo. El enlace es de un solo uso.")
      : note(
          "Para entrar por primera vez, usa “¿Olvidaste tu contraseña?” en la pantalla de acceso " +
            "con este mismo correo. Te llegará un enlace para definirla.",
        ),
    paragraph("Cuando entres, lo primero que te va a servir:"),
    bulletList([
      "Revisa los servicios y precios que dejamos cargados y ajústalos a los tuyos",
      "Agrega a tus técnicos y dales su usuario",
      "Define tus horarios de atención",
      "Comparte tu página pública para que tus clientes reserven en línea",
    ]),
    paragraph("Si algo no cuadra o necesitas una mano para arrancar, responde a este correo y te ayudamos."),
  ];

  await enviarCorreo({
    to: datos.duenoEmail,
    subject: `Bienvenido a MotorDesk — ${datos.taller} ya está listo`,
    html: renderEmail({
      heading: `${datos.taller} ya está en MotorDesk`,
      preheader: "Tu taller está creado. Define tu contraseña y entra.",
      blocks,
      cta: enlace ? { label: "Definir mi contraseña", url: enlace } : { label: "Ir a MotorDesk", url: login },
      footerNote: "Si no esperabas este correo, escríbenos respondiendo a este mensaje.",
    }),
  });

  return { enviada: true, a: datos.duenoEmail };
}
