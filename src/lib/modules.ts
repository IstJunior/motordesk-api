// Sistema de módulos por taller. El superadmin activa/desactiva; el tenant respeta.
// Solo son toggleables los módulos que el proveedor decide comercialmente o que
// dependen de una configuración externa; el resto del producto es core y viaja
// siempre encendido (como en SmartPOS, que solo tiene tres flags).

// Módulos toggleables (los que el superadmin puede prender/apagar por taller).
export const MODULOS = [
  "inventario",
  "facturacion_electronica",
  "pagos",
  "sedes", // multi-sucursal
] as const;

export type Modulo = (typeof MODULOS)[number];

// Módulos core: SIEMPRE activos, no se togglean (no aparecen en enabled_modules).
export const MODULOS_CORE = [
  "turnos",
  "checklists",
  "analisis_ia",
  "manuales",
  "catalogo_vehiculos",
  "tecnicos",
  "reportes",
  "clientes",
  "servicios",
  "usuarios",
  "configuracion",
  "personalizacion",
  "horarios",
] as const;

// Etiquetas para pintar los toggles en el panel.
export const ETIQUETA_MODULO: Record<Modulo, string> = {
  inventario: "Inventario",
  facturacion_electronica: "Facturación electrónica (DIAN)",
  pagos: "Pagos en línea",
  sedes: "Sedes (multi-sucursal)",
};

// Default: todos los toggleables encendidos, inventario incluido.
export function modulosPorDefecto(): Record<Modulo, boolean> {
  return Object.fromEntries(MODULOS.map((m) => [m, true])) as Record<Modulo, boolean>;
}

// Normaliza el JSON almacenado (enabled_modules) a un mapa completo con defaults.
// Las claves de la lista anterior (turnos, ventas, reportes…) se descartan.
export function normalizarModulos(raw: unknown): Record<Modulo, boolean> {
  const base = modulosPorDefecto();
  if (raw && typeof raw === "object") {
    for (const m of MODULOS) {
      const v = (raw as Record<string, unknown>)[m];
      if (typeof v === "boolean") base[m] = v;
    }
  }
  return base;
}

export function esModuloValido(m: string): m is Modulo {
  return (MODULOS as readonly string[]).includes(m);
}
