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
// Lleva también cómo quedó registrado el taller (tipo, vehículos, contacto).
// El dueño no vio la pantalla del alta, así que es la primera oportunidad de
// que revise esos datos y avise si alguno está mal.

function appOrigin(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://motordesk.nexcoreia.com";
  return raw.replace(/\/+$/, "");
}

export type PerfilTaller = {
  /** Etiqueta ya legible: "Taller de motos". */
  tipo?: string | null;
  /** Etiquetas ya legibles: ["Motocicleta", "Moto eléctrica"]. */
  vehiculos?: string[] | null;
  ciudad?: string | null;
  direccion?: string | null;
  telefono?: string | null;
};

export type DatosInvitacion = {
  taller: string;
  codigo: string;
  duenoNombre: string;
  duenoEmail: string;
  /** Días de prueba concedidos al dar de alta, si los hay. */
  diasTrial?: number | null;
  /** El superadmin asignó una contraseña al crear el taller. */
  conAcceso: boolean;
  /**
   * Contraseña inicial, para que el dueño entre directo sin pasos previos.
   * Va escrita en el correo: es una decisión deliberada de que el acceso sea
   * inmediato, a cambio de que la clave quede en un buzón. Por eso el mensaje
   * insiste en cambiarla al entrar. Si no se manda, el correo cae en el enlace
   * de un solo uso para definirla.
   */
  password?: string | null;
  /** Cómo quedó registrado el taller, para que el dueño lo revise. */
  perfil?: PerfilTaller | null;
  /**
   * Destinatario alternativo. Sirve para que el proveedor se mande una copia y
   * vea cómo le va a llegar al taller antes de mandársela de verdad. El cuerpo
   * es el mismo: los datos del correo siguen siendo los del dueño.
   */
  enviarA?: string | null;
};

export type ResultadoInvitacion =
  | { enviada: true; a: string }
  | { enviada: false; motivo: string };

function limpio(valor: string | null | undefined): string | null {
  const texto = (valor ?? "").trim();
  return texto.length > 0 ? texto : null;
}

export async function enviarInvitacionTaller(datos: DatosInvitacion): Promise<ResultadoInvitacion> {
  if (!(await correoDisponible())) {
    const faltan = await faltantesCorreo();
    return { enviada: false, motivo: `Correo sin configurar en Sistema → Correo saliente: falta ${faltan.join(", ")}.` };
  }

  const login = `${appOrigin()}/login`;
  const password = limpio(datos.password);

  // Sin contraseña no hay forma de entrar, así que se genera el enlace de un
  // solo uso. Con contraseña no hace falta pedirlo: sería un paso de más.
  const enlace = password ? null : await enlaceDefinirPassword(datos.duenoEmail, `${appOrigin()}/restablecer`);

  const acceso: Array<[string, string]> = [["Correo", datos.duenoEmail]];
  if (password) acceso.push(["Contraseña", password]);
  if (datos.diasTrial && datos.diasTrial > 0) {
    acceso.push(["Prueba gratis", `${datos.diasTrial} días`]);
  }

  const perfil: Array<[string, string]> = [];
  const p = datos.perfil;
  if (p) {
    if (limpio(p.tipo)) perfil.push(["Tipo de taller", limpio(p.tipo)!]);
    if (p.vehiculos && p.vehiculos.length > 0) perfil.push(["Vehículos que atiende", p.vehiculos.join(", ")]);
    if (limpio(p.ciudad)) perfil.push(["Ciudad", limpio(p.ciudad)!]);
    if (limpio(p.direccion)) perfil.push(["Dirección", limpio(p.direccion)!]);
    if (limpio(p.telefono)) perfil.push(["Teléfono", limpio(p.telefono)!]);
  }
  perfil.push(["Responsable", datos.duenoNombre]);

  const blocks = [
    paragraph(`Hola ${datos.duenoNombre},`),
    paragraph(
      `Te damos la bienvenida a MotorDesk. Creamos la cuenta de ${datos.taller} y ya está lista para que entres: ` +
        "aquí vas a manejar los turnos, el historial de tus clientes, el inventario y los cobros, todo en un solo lugar.",
    ),

    paragraph("Estos son tus datos para entrar:"),
    dataTable(acceso),
    password
      ? note("Cambia esta contraseña apenas entres, desde tu perfil. Mientras siga escrita en este correo, cualquiera que lo abra puede usarla.")
      : enlace
        ? paragraph("Para empezar, define tu contraseña con el botón de abajo. El enlace es de un solo uso.")
        : note(
            "Para entrar por primera vez, usa “¿Olvidaste tu contraseña?” en la pantalla de acceso " +
              "con este mismo correo. Te llegará un enlace para definirla.",
          ),

    codeBox("Código de tu taller", datos.codigo),
    paragraph("Guarda este código: identifica a tu taller, es único y no cambia. Tu equipo lo necesita para entrar."),

    paragraph("Así quedó registrado tu taller:"),
    dataTable(perfil),
    paragraph("Si algo de esto no está bien, lo puedes corregir tú mismo en Ajustes, o respondernos este correo."),

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
    to: limpio(datos.enviarA) ?? datos.duenoEmail,
    subject: `Bienvenido a MotorDesk — ${datos.taller} ya está listo`,
    html: renderEmail({
      heading: `${datos.taller} ya está en MotorDesk`,
      preheader: password
        ? "Tu taller está creado. Entra con el correo y la contraseña de adentro."
        : "Tu taller está creado. Define tu contraseña y entra.",
      blocks,
      cta: enlace ? { label: "Definir mi contraseña", url: enlace } : { label: "Entrar a mi taller", url: login },
      footerNote: "Si no esperabas este correo, escríbenos respondiendo a este mensaje.",
    }),
  });

  return { enviada: true, a: limpio(datos.enviarA) ?? datos.duenoEmail };
}
