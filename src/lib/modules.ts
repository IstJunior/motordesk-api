// Sistema de módulos por taller. El superadmin activa/desactiva; el tenant respeta.
// Reemplaza el premium-features del monolito (que solo tenía `inventory`).

// Módulos toggleables (los que el superadmin puede prender/apagar por taller).
export const MODULOS = [
  "turnos", // agenda / turnos / citas
  "inventario",
  "ventas", // POS
  "facturacion_electronica",
  "pagos",
  "analisis_ia",
  "checklists",
  "manuales",
  "catalogo_vehiculos",
  "sedes", // multi-sucursal
  "tecnicos",
  "reportes",
] as const;

export type Modulo = (typeof MODULOS)[number];

// Módulos core: SIEMPRE activos, no se togglean (no aparecen en enabled_modules).
export const MODULOS_CORE = [
  "clientes",
  "servicios",
  "usuarios",
  "configuracion",
  "personalizacion",
  "horarios",
] as const;

// Default: todos los toggleables encendidos al crear/backfill un taller.
export function modulosPorDefecto(): Record<Modulo, boolean> {
  return Object.fromEntries(MODULOS.map((m) => [m, true])) as Record<Modulo, boolean>;
}

// Normaliza el JSON almacenado (enabled_modules) a un mapa completo con defaults.
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
