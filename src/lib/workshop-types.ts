// Tipos de taller. Portado del monolito (`src/lib/workshop-types.ts`) para que
// el alta desde el panel produzca exactamente los mismos valores que produce el
// registro público mientras ambos convivan.

export const TIPOS_TALLER = [
  {
    value: "vehicle",
    label: "Taller vehicular",
    vehicleTypes: ["car", "suv", "pickup", "truck", "van", "electric"],
  },
  {
    value: "motorcycle",
    label: "Taller de motos",
    vehicleTypes: ["motorcycle", "emoto", "atv"],
  },
  {
    value: "mixed_vehicle",
    label: "Autos y motos",
    vehicleTypes: [
      "car",
      "motorcycle",
      "suv",
      "pickup",
      "truck",
      "van",
      "electric",
      "emoto",
      "atv",
    ],
  },
  {
    value: "electric",
    label: "Taller eléctrico",
    vehicleTypes: ["electric", "emoto", "escooter"],
  },
  { value: "specialized", label: "Taller especializado", vehicleTypes: [] },
] as const;

export type TipoTaller = (typeof TIPOS_TALLER)[number]["value"];

const VALORES = new Set<string>(TIPOS_TALLER.map((t) => t.value));

export function normalizarTipoTaller(valor: unknown): TipoTaller {
  return typeof valor === "string" && VALORES.has(valor) ? (valor as TipoTaller) : "mixed_vehicle";
}

export function tiposVehiculoPorDefecto(valor: unknown): string[] {
  const tipo = normalizarTipoTaller(valor);
  return [...(TIPOS_TALLER.find((t) => t.value === tipo)?.vehicleTypes ?? [])];
}

// Etiquetas en español de los tipos de vehículo. Mismo mapa que el informe de
// turno del monolito (`src/lib/appointment-report.ts`), para que el taller lea
// lo mismo en el correo y en el PDF.
const ETIQUETAS_VEHICULO: Record<string, string> = {
  motorcycle: "Motocicleta",
  car: "Automóvil",
  suv: "SUV / Camioneta",
  truck: "Camión",
  pickup: "Pickup",
  van: "Furgoneta / Van",
  atv: "ATV / Cuatrimoto",
  electric: "Vehículo eléctrico",
  escooter: "Scooter eléctrico",
  emoto: "Moto eléctrica",
};

export function etiquetaVehiculo(valor: string): string {
  return ETIQUETAS_VEHICULO[valor] ?? valor;
}

export function etiquetaTipoTaller(valor: unknown): string {
  const tipo = normalizarTipoTaller(valor);
  return TIPOS_TALLER.find((t) => t.value === tipo)?.label ?? tipo;
}
