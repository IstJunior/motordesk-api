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
  checklist: string[];
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

const MOTO: ServicioPlantilla[] = [
  {
    nombre: "Cambio de aceite y filtro",
    duracionMin: 30,
    moto: 48000,
    checklist: [
      "Drenar aceite con motor a temperatura de servicio",
      "Reemplazar filtro y arandela del tapón",
      "Instalar aceite con la viscosidad recomendada",
      "Verificar fugas y nivel final",
      "Registrar kilometraje del próximo cambio",
    ],
  },
  {
    nombre: "Mantenimiento general de moto",
    duracionMin: 60,
    moto: 95000,
    checklist: [
      "Verificar kilometraje y tareas según manual del fabricante",
      "Cambiar aceite de motor y revisar filtro",
      "Inspeccionar estado del filtro de aire",
      "Verificar tensión y lubricación de cadena",
      "Inspeccionar pastillas/zapatas y nivel de líquido de frenos",
      "Revisar presión y desgaste de llantas",
      "Prueba dinámica y registro de observaciones",
    ],
  },
  {
    nombre: "Ajuste y lubricación de cadena",
    duracionMin: 30,
    moto: 35000,
    checklist: [
      "Inspeccionar desgaste de cadena, corona y piñón",
      "Ajustar tensión y alineación",
      "Lubricar con el producto adecuado",
      "Verificar juego y ruidos en prueba dinámica",
    ],
  },
  {
    nombre: "Cambio de pastillas de freno",
    duracionMin: 45,
    moto: 70000,
    checklist: [
      "Inspeccionar espesor de pastillas y estado del disco",
      "Revisar fugas, mangueras y nivel de líquido",
      "Purgar y renovar líquido si aplica",
      "Verificar tacto de maneta y frenado en prueba dinámica",
    ],
  },
  {
    nombre: "Sincronización y carburación",
    duracionMin: 90,
    moto: 120000,
    checklist: [
      "Diagnóstico inicial (ralentí, respuesta y ruidos)",
      "Revisar y limpiar el sistema de admisión",
      "Revisar sistema de combustible (inyector o carburador)",
      "Revisar o ajustar válvulas según especificación",
      "Revisar bujía y reemplazar si aplica",
      "Sincronizar y ajustar ralentí",
      "Prueba dinámica final",
    ],
  },
  {
    nombre: "Cambio de bujía",
    duracionMin: 20,
    moto: 28000,
    checklist: [
      "Retirar y evaluar color y desgaste de la bujía",
      "Verificar calibración del electrodo",
      "Instalar bujía nueva con el torque correcto",
      "Verificar encendido y respuesta",
    ],
  },
  {
    nombre: "Regulación de válvulas",
    duracionMin: 120,
    moto: 150000,
    checklist: [
      "Medir holguras con el motor frío",
      "Ajustar según especificación del fabricante",
      "Reensamblar con el torque correcto",
      "Verificar sonido de válvulas y rendimiento",
    ],
  },
  {
    nombre: "Diagnóstico eléctrico",
    duracionMin: 45,
    moto: 50000,
    checklist: [
      "Medir voltaje en reposo y en marcha",
      "Verificar regulador/rectificador y alternador",
      "Inspeccionar conectores, tierras y sulfatación",
      "Corregir hallazgos y validar carga final",
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
