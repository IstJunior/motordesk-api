// Plantillas de arranque: catálogo de servicios + checklist de cada servicio que
// se siembra al crear un taller. Equivale a `lib/plantillas.ts` de SmartPOS.
//
// Un taller recién creado con cero servicios no se puede usar (no se puede
// agendar un turno sin servicio), así que el alta lo deja operativo desde el
// primer minuto. Todo es editable después desde el panel del taller.
//
// Precios en COP, alineados con el catálogo que ya usan los talleres sembrados.
// Solo se declara el precio de auto y/o moto; los demás tipos de vehículo se
// derivan con los multiplicadores de abajo, que es como está el catálogo actual
// (SUV = auto × 1.15).
import type { TipoTaller } from "./workshop-types.js";

export type ServicioPlantilla = {
  nombre: string;
  duracionMin: number;
  // Precio base. `auto` cubre carro y derivados; `moto` cubre moto/atv/emoto.
  auto?: number;
  moto?: number;
  // Texto suelto = paso obligatorio (así nacieron los catálogos de autos).
  checklist: (string | { paso: string; obligatorio: boolean })[];
};

// Derivación de precios por tipo de vehículo a partir del precio de auto.
const FACTOR = {
  suv: 1.15,
  pickup: 1.15,
  van: 1.2,
  truck: 1.35,
  electric: 1.1,
} as const;

const CHECKLIST_GENERICO = [
  "Inspección visual general",
  "Ejecución del servicio según procedimiento del taller",
  "Control de calidad y pruebas funcionales",
  "Registro de observaciones y recomendaciones",
];

// --- Motos -----------------------------------------------------------------

// COPIA de motordesk/src/lib/servicios-de-arranque.ts (SERVICIOS_MOTO), que es
// lo que siembra el registro público. Si cambia uno, cambia el otro. Sin precio:
// el precio de la mano de obra lo pone el taller en el turno. De dónde sale el
// catálogo, en el archivo del monolito.
const MOTO: ServicioPlantilla[] = [
  {
    nombre: "Cambio de aceite y filtro",
    duracionMin: 30,
    checklist: [
      { paso: "Confirmar en el manual la viscosidad y la cantidad de aceite", obligatorio: false },
      { paso: "Drenar el aceite con el motor tibio", obligatorio: false },
      { paso: "Cambiar el filtro de aceite (o limpiar la malla) y la arandela del tapón", obligatorio: false },
      { paso: "Apretar el tapón de drenaje al torque del manual", obligatorio: true },
      { paso: "Llenar y verificar el nivel en la mirilla o la varilla", obligatorio: true },
      { paso: "Revisar que no queden fugas con el motor encendido", obligatorio: true },
      { paso: "Anotar el kilometraje del próximo cambio", obligatorio: false },
    ],
  },
  {
    nombre: "Mantenimiento general",
    duracionMin: 180,
    checklist: [
      { paso: "Inspección general y prueba de ruta de entrada", obligatorio: false },
      { paso: "Cambio de aceite de motor y filtro", obligatorio: false },
      { paso: "Sincronización: limpieza de carburador o cuerpo de aceleración, bujía y filtro de aire", obligatorio: false },
      { paso: "Calibración de válvulas según el manual", obligatorio: false },
      { paso: "Mantenimiento de frenos: mordazas, pastillas o bandas y líquido", obligatorio: true },
      { paso: "Mantenimiento del kit de arrastre: limpieza, tensión y lubricación", obligatorio: false },
      { paso: "Lubricación de guayas (clutch, acelerador y freno)", obligatorio: false },
      { paso: "Engrase de bujes de la tijera y revisión de rodamientos de las ruedas", obligatorio: false },
      { paso: "Revisión de cunas de dirección y suspensión delantera", obligatorio: false },
      { paso: "Revisión del sistema eléctrico: luces, pito, batería y carga", obligatorio: false },
      { paso: "Ajuste de pernos del motor y del chasis", obligatorio: false },
      { paso: "Presión y desgaste de las llantas", obligatorio: false },
      { paso: "Lavado de la moto", obligatorio: false },
      { paso: "Prueba de ruta final", obligatorio: true },
    ],
  },
  {
    nombre: "Sincronización",
    duracionMin: 90,
    checklist: [
      { paso: "Diagnóstico de entrada: encendido, ralentí y respuesta al acelerar", obligatorio: false },
      { paso: "Lavado del carburador o limpieza del cuerpo de aceleración e inyector", obligatorio: false },
      { paso: "Limpieza o cambio del filtro de aire", obligatorio: false },
      { paso: "Revisión o cambio de la bujía y del capuchón", obligatorio: false },
      { paso: "Calibración de válvulas con el motor frío, según el manual", obligatorio: false },
      { paso: "Revisión de bobina y sistema de encendido", obligatorio: false },
      { paso: "Ajuste de ralentí y de la mezcla", obligatorio: false },
      { paso: "Prueba de ruta final", obligatorio: true },
    ],
  },
  {
    nombre: "Mantenimiento de frenos",
    duracionMin: 60,
    checklist: [
      { paso: "Prueba de frenado y tacto de manigueta y pedal", obligatorio: false },
      { paso: "Desmonte y limpieza de mordazas, o de bandas y campana en freno de tambor", obligatorio: false },
      { paso: "Medir el desgaste de pastillas o bandas y el estado del disco", obligatorio: false },
      { paso: "Limpieza y lubricación de pasadores y guías", obligatorio: false },
      { paso: "Revisión de mangueras, nivel y color del líquido de frenos", obligatorio: false },
      { paso: "Cambio del líquido y purga si está oscuro o lleva más de dos años", obligatorio: false },
      { paso: "Ajuste del recorrido del freno trasero", obligatorio: false },
      { paso: "Prueba de ruta con frenado de los dos frenos", obligatorio: true },
    ],
  },
  {
    nombre: "Cambio de pastillas de freno",
    duracionMin: 30,
    checklist: [
      { paso: "Medir el espesor de las pastillas y revisar el disco", obligatorio: false },
      { paso: "Desmontar la mordaza y limpiarla", obligatorio: false },
      { paso: "Recoger los pistones y revisar que no estén pegados", obligatorio: false },
      { paso: "Instalar las pastillas nuevas con su lámina antirruido", obligatorio: false },
      { paso: "Apretar la mordaza al torque del manual", obligatorio: true },
      { paso: "Bombear la manigueta o el pedal hasta recuperar el tacto", obligatorio: true },
      { paso: "Revisar el nivel del líquido de frenos", obligatorio: false },
      { paso: "Prueba de frenado", obligatorio: true },
    ],
  },
  {
    nombre: "Mantenimiento de kit de arrastre",
    duracionMin: 30,
    checklist: [
      { paso: "Revisar el desgaste de cadena, piñón y corona", obligatorio: false },
      { paso: "Limpiar la cadena con desengrasante", obligatorio: false },
      { paso: "Tensionar la cadena con la holgura del manual", obligatorio: false },
      { paso: "Verificar la alineación con las marcas de los dos tensores", obligatorio: false },
      { paso: "Lubricar la cadena", obligatorio: false },
      { paso: "Apretar el eje trasero al torque del manual", obligatorio: true },
      { paso: "Revisar el freno trasero después del ajuste", obligatorio: true },
    ],
  },
  {
    nombre: "Cambio de kit de arrastre",
    duracionMin: 60,
    checklist: [
      { paso: "Confirmar la referencia del kit (paso, eslabones y dientes)", obligatorio: false },
      { paso: "Desmontar la rueda trasera, el piñón y la corona", obligatorio: false },
      { paso: "Limpiar la tijera, la tapa del piñón y las partes", obligatorio: false },
      { paso: "Montar el kit completo: cadena, piñón y corona", obligatorio: false },
      { paso: "Asegurar el candado o remachar la cadena", obligatorio: false },
      { paso: "Tensionar con la holgura del manual y alinear la rueda", obligatorio: false },
      { paso: "Apretar el eje y los pernos de la corona al torque del manual", obligatorio: true },
      { paso: "Ajustar el freno trasero y hacer prueba de ruta", obligatorio: true },
    ],
  },
  {
    nombre: "Mantenimiento de cunas de dirección",
    duracionMin: 90,
    checklist: [
      { paso: "Revisar holgura y dureza de la dirección con la rueda delantera en el aire", obligatorio: false },
      { paso: "Bajar la rueda delantera y las barras", obligatorio: false },
      { paso: "Desmontar la tija y sacar las cunas", obligatorio: false },
      { paso: "Limpiar las pistas y revisar si están marcadas", obligatorio: false },
      { paso: "Cambiar las cunas si están marcadas (el juego completo, arriba y abajo)", obligatorio: false },
      { paso: "Engrasar y montar", obligatorio: false },
      { paso: "Ajustar la precarga: sin holgura y con giro libre", obligatorio: true },
      { paso: "Prueba de ruta: dirección sin golpeteo ni vibración al frenar", obligatorio: true },
    ],
  },
  {
    nombre: "Mantenimiento de suspensión delantera",
    duracionMin: 120,
    checklist: [
      { paso: "Revisar fugas en las barras y el estado de los guardapolvos", obligatorio: false },
      { paso: "Aflojar los tapones de vaciado y bajar las barras", obligatorio: false },
      { paso: "Drenar el aceite hidráulico y sacar el resorte", obligatorio: false },
      { paso: "Revisar que la barra no tenga picaduras ni rayas", obligatorio: false },
      { paso: "Cambiar retenedores y guardapolvos (resorte del retenedor hacia la botella)", obligatorio: false },
      { paso: "Llenar con el aceite y la cantidad del manual, bombeando para sacar el aire", obligatorio: false },
      { paso: "Montar las barras a la altura original y apretar las tijas al torque del manual", obligatorio: true },
      { paso: "Prueba de ruta", obligatorio: true },
    ],
  },
  {
    nombre: "Cambio de discos de clutch",
    duracionMin: 120,
    checklist: [
      { paso: "Prueba de patinaje y revisión de los cambios", obligatorio: false },
      { paso: "Drenar el aceite del motor", obligatorio: false },
      { paso: "Desmontar la tapa del clutch", obligatorio: false },
      { paso: "Medir el espesor y el alabeo de los discos y revisar los resortes", obligatorio: false },
      { paso: "Cambiar discos y, si aplica, resortes y empaque de la tapa", obligatorio: false },
      { paso: "Montar la tapa y apretar al torque del manual", obligatorio: true },
      { paso: "Llenar el aceite de motor", obligatorio: false },
      { paso: "Calibrar el juego libre de la guaya del clutch, o cambiarla si está deshilachada", obligatorio: false },
      { paso: "Prueba de ruta: sin patinar y con cambios suaves", obligatorio: true },
    ],
  },
  {
    nombre: "Diagnóstico eléctrico y de carga",
    duracionMin: 60,
    checklist: [
      { paso: "Revisar luces, direccionales, pito y tablero", obligatorio: false },
      { paso: "Medir la batería en reposo", obligatorio: false },
      { paso: "Medir la carga a 3.000–5.000 rpm: debe quedar entre 13,5 y 14,5 V", obligatorio: false },
      { paso: "Medir la salida del estator (corona o bobinas de carga)", obligatorio: false },
      { paso: "Revisar el regulador rectificador", obligatorio: false },
      { paso: "Revisar conectores, tierras y fusibles: sin sulfato ni falsos contactos", obligatorio: false },
      { paso: "Corregir lo encontrado y repetir la medición de carga", obligatorio: true },
    ],
  },
  {
    nombre: "Diagnóstico con escáner",
    duracionMin: 30,
    checklist: [
      { paso: "Conectar el escáner y leer los códigos de falla", obligatorio: false },
      { paso: "Revisar los datos en vivo: sensores, temperatura y voltaje", obligatorio: false },
      { paso: "Contrastar los códigos con los síntomas que reporta el cliente", obligatorio: false },
      { paso: "Borrar los códigos y comprobar si vuelven", obligatorio: false },
      { paso: "Explicar al cliente el diagnóstico y lo que hay que hacer", obligatorio: false },
    ],
  },
  {
    nombre: "Mantenimiento de transmisión de scooter (CVT)",
    duracionMin: 90,
    checklist: [
      { paso: "Retirar la tapa de la transmisión", obligatorio: false },
      { paso: "Medir el ancho de la correa y buscar grietas o cristalización", obligatorio: false },
      { paso: "Revisar que los rodillos del variador no estén planos ni gastados", obligatorio: false },
      { paso: "Revisar las guías del variador y las zapatas y campana del clutch", obligatorio: false },
      { paso: "Limpiar la caja de la transmisión", obligatorio: false },
      { paso: "Cambiar las piezas gastadas, respetando el sentido de giro de la correa", obligatorio: false },
      { paso: "Apretar las tuercas del variador y del clutch al torque del manual", obligatorio: true },
      { paso: "Revisar o cambiar el aceite de la caja de reducción", obligatorio: false },
      { paso: "Prueba de ruta: arranque sin tirones y sin chillido", obligatorio: true },
    ],
  },
  {
    nombre: "Reparación de motor (cabeza de fuerza)",
    duracionMin: 480,
    checklist: [
      { paso: "Diagnóstico: compresión, ruidos y consumo de aceite", obligatorio: false },
      { paso: "Desmontar tapas, culata y cilindro", obligatorio: false },
      { paso: "Revisar cadenilla y tensor, árbol de levas y balancines", obligatorio: false },
      { paso: "Revisar válvulas y sellos de válvula", obligatorio: false },
      { paso: "Medir cilindro, pistón y anillos", obligatorio: false },
      { paso: "Cambiar o rectificar las piezas afectadas", obligatorio: false },
      { paso: "Armar con empaques nuevos y apretar al torque del manual", obligatorio: true },
      { paso: "Sincronizar el tiempo de la distribución", obligatorio: true },
      { paso: "Calibrar válvulas y llenar el aceite", obligatorio: false },
      { paso: "Prueba de ruta y revisión de fugas", obligatorio: true },
    ],
  },
  {
    nombre: "Alistamiento para la revisión técnico-mecánica",
    duracionMin: 60,
    checklist: [
      { paso: "Revisar luces, direccionales, stop y pito", obligatorio: false },
      { paso: "Revisar frenos delantero y trasero", obligatorio: true },
      { paso: "Revisar llantas: labrado y presión", obligatorio: false },
      { paso: "Revisar fugas de aceite, gasolina o líquido de frenos", obligatorio: false },
      { paso: "Revisar la suspensión y la holgura de la dirección", obligatorio: false },
      { paso: "Revisar espejos, placa y escape", obligatorio: false },
      { paso: "Sincronizar si hace falta para pasar la prueba de gases", obligatorio: false },
      { paso: "Lavar la moto", obligatorio: false },
    ],
  },
  {
    nombre: "Despinche o cambio de llanta",
    duracionMin: 30,
    checklist: [
      { paso: "Ubicar el pinchazo y revisar el estado de la llanta", obligatorio: false },
      { paso: "Desmontar la rueda", obligatorio: false },
      { paso: "Parchar o cambiar el neumático o la llanta", obligatorio: false },
      { paso: "Revisar la válvula y el rin", obligatorio: false },
      { paso: "Montar la rueda y apretar el eje al torque del manual", obligatorio: true },
      { paso: "Calibrar la presión según el manual", obligatorio: false },
      { paso: "Revisar el freno y, en la trasera, la tensión de la cadena", obligatorio: true },
    ],
  },
];

// --- Autos -----------------------------------------------------------------

const AUTO: ServicioPlantilla[] = [
  {
    nombre: "Cambio de aceite y filtro",
    duracionMin: 45,
    auto: 120000,
    moto: 55000,
    checklist: [
      "Drenar aceite con motor a temperatura de servicio",
      "Reemplazar filtro de aceite y arandela del tapón",
      "Instalar aceite con la viscosidad recomendada",
      "Verificar fugas y nivel final",
      "Registrar kilometraje del próximo cambio",
    ],
  },
  {
    nombre: "Revisión de frenos",
    duracionMin: 60,
    auto: 90000,
    moto: 45000,
    checklist: [
      "Inspeccionar espesor de pastillas y estado de discos",
      "Revisar fugas, mangueras y nivel de líquido",
      "Purgar y renovar líquido si aplica",
      "Verificar freno de mano y frenado en prueba dinámica",
    ],
  },
  {
    nombre: "Alineación y balanceo",
    duracionMin: 60,
    auto: 110000,
    checklist: [
      "Revisar presión y desgaste de las cuatro llantas",
      "Inspeccionar holguras de dirección y suspensión",
      "Balancear ruedas",
      "Alinear según especificación y verificar en prueba dinámica",
    ],
  },
  {
    nombre: "Diagnóstico electrónico",
    duracionMin: 45,
    auto: 80000,
    moto: 50000,
    checklist: [
      "Escaneo de módulos y lectura de códigos",
      "Contrastar códigos con los síntomas reportados",
      "Inspección eléctrica y del sistema de carga",
      "Definir plan de trabajo y prioridad de reparación",
    ],
  },
  {
    nombre: "Mantenimiento preventivo 10.000 km",
    duracionMin: 120,
    auto: 320000,
    moto: 140000,
    checklist: [
      "Verificar kilometraje y tareas según manual del fabricante",
      "Cambiar aceite de motor y filtro",
      "Revisar filtros de aire, cabina y combustible",
      "Inspeccionar frenos, suspensión y dirección",
      "Revisar niveles y estado de correas y mangueras",
      "Revisar presión y desgaste de llantas",
      "Prueba dinámica y registro de observaciones",
    ],
  },
  {
    nombre: "Cambio de filtros",
    duracionMin: 30,
    auto: 85000,
    moto: 40000,
    checklist: [
      "Inspeccionar caja y elementos filtrantes",
      "Reemplazar filtro de aire y de cabina según condición",
      "Verificar sellado y correcta instalación",
      "Prueba de respuesta de aceleración",
    ],
  },
  {
    nombre: "Revisión de niveles",
    duracionMin: 15,
    auto: 35000,
    moto: 20000,
    checklist: [
      "Revisar aceite de motor y de caja",
      "Revisar refrigerante, frenos y dirección hidráulica",
      "Revisar líquido limpiaparabrisas",
      "Reportar fugas o consumos anormales",
    ],
  },
  {
    nombre: "Cambio de batería",
    duracionMin: 30,
    auto: 60000,
    moto: 35000,
    checklist: [
      "Medir voltaje y estado de carga de la batería actual",
      "Verificar alternador y sistema de carga",
      "Instalar batería nueva y limpiar bornes",
      "Validar arranque y carga final",
    ],
  },
];

// --- Eléctricos ------------------------------------------------------------

const ELECTRICO: ServicioPlantilla[] = [
  {
    nombre: "Diagnóstico de sistema eléctrico",
    duracionMin: 60,
    auto: 95000,
    moto: 55000,
    checklist: [
      "Lectura de códigos del sistema de tracción",
      "Medir voltaje y aislamiento del pack de baterías",
      "Inspeccionar cableado de alta tensión y conectores",
      "Definir plan de trabajo y prioridad de reparación",
    ],
  },
  {
    nombre: "Revisión de batería de tracción",
    duracionMin: 90,
    auto: 160000,
    moto: 90000,
    checklist: [
      "Medir capacidad y estado de salud (SOH) del pack",
      "Verificar balanceo entre celdas o módulos",
      "Revisar sistema de refrigeración del pack",
      "Registrar mediciones y recomendaciones",
    ],
  },
  {
    nombre: "Mantenimiento de sistema de carga",
    duracionMin: 60,
    auto: 110000,
    moto: 60000,
    checklist: [
      "Inspeccionar puerto de carga y estado de contactos",
      "Probar carga en AC y validar corriente",
      "Revisar cargador de a bordo y protecciones",
      "Prueba funcional de carga completa",
    ],
  },
  {
    nombre: "Revisión de frenos regenerativos",
    duracionMin: 60,
    auto: 100000,
    moto: 55000,
    checklist: [
      "Verificar funcionamiento de la regeneración",
      "Inspeccionar pastillas y discos (desgaste desigual por bajo uso)",
      "Revisar nivel y estado del líquido de frenos",
      "Prueba dinámica con y sin regeneración",
    ],
  },
];

// --- Selección por tipo de taller ------------------------------------------

// Une catálogos sin repetir nombre: el primero que aparece manda. Para un taller
// mixto, la versión de auto (que ya trae precio de moto) gana sobre la de moto.
function unir(...catalogos: ServicioPlantilla[][]): ServicioPlantilla[] {
  const vistos = new Set<string>();
  const salida: ServicioPlantilla[] = [];
  for (const catalogo of catalogos) {
    for (const s of catalogo) {
      const clave = s.nombre.toLowerCase();
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      salida.push(s);
    }
  }
  return salida;
}

export function plantillaDeTaller(tipo: TipoTaller): ServicioPlantilla[] {
  switch (tipo) {
    case "motorcycle":
      return MOTO;
    case "vehicle":
      return AUTO;
    case "mixed_vehicle":
      return unir(AUTO, MOTO);
    case "electric":
      return ELECTRICO;
    case "specialized":
      // Sin catálogo propio: un servicio genérico para poder agendar desde ya.
      return [
        {
          nombre: "Servicio general",
          duracionMin: 60,
          auto: 90000,
          moto: 50000,
          checklist: CHECKLIST_GENERICO,
        },
      ];
  }
}

// Precios por columna de la tabla `services` a partir de la plantilla.
export function preciosDe(s: ServicioPlantilla) {
  const auto = s.auto ?? 0;
  const moto = s.moto ?? 0;
  const derivar = (factor: number) => (auto > 0 ? Math.round(auto * factor) : 0);

  return {
    priceCar: auto,
    priceMotorcycle: moto,
    priceSuv: derivar(FACTOR.suv),
    priceTruck: derivar(FACTOR.truck),
    pricePickup: derivar(FACTOR.pickup),
    priceVan: derivar(FACTOR.van),
    priceElectric: derivar(FACTOR.electric),
    priceAtv: moto,
    priceEscooter: moto,
  };
}

// Cuántos servicios sembraría cada tipo (para pintarlo en el formulario).
export function resumenPlantillas(): { tipo: TipoTaller; servicios: number }[] {
  return (["vehicle", "motorcycle", "mixed_vehicle", "electric", "specialized"] as const).map(
    (tipo) => ({ tipo, servicios: plantillaDeTaller(tipo).length }),
  );
}
