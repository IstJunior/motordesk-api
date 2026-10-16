// Días hábiles en Colombia, para el plazo de retracto.
//
// El módulo de facturación electrónica se activa cuando termina el retracto
// (Ley 1480, art. 47: cinco días hábiles desde el pago). Contar días corridos
// lo activaría antes de tiempo cualquier semana con festivo, y ahí MotorDesk
// ya habría comprado en el proveedor un paquete que el taller todavía puede
// devolver.
//
// Las fechas van como día calendario puro (medianoche UTC), igual que las
// columnas `@db.Date`: así la zona horaria del proceso no corre un día.

const DIA = 24 * 60 * 60 * 1000;

function utc(anio: number, mes: number, dia: number): Date {
  return new Date(Date.UTC(anio, mes - 1, dia));
}

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
function pascua(anio: number): Date {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(anio, mes, dia);
}

/** Ley Emiliani: el festivo que no cae lunes se pasa al lunes siguiente. */
function alLunes(fecha: Date): Date {
  const dow = fecha.getUTCDay();
  return dow === 1 ? fecha : new Date(fecha.getTime() + ((8 - dow) % 7) * DIA);
}

function sumar(fecha: Date, dias: number): Date {
  return new Date(fecha.getTime() + dias * DIA);
}

const cache = new Map<number, Set<string>>();

/** Los festivos de un año, como "AAAA-MM-DD". */
export function festivosDeColombia(anio: number): Set<string> {
  const guardado = cache.get(anio);
  if (guardado) return guardado;
  const p = pascua(anio);
  const dias = [
    // Fijos.
    utc(anio, 1, 1),
    utc(anio, 5, 1),
    utc(anio, 7, 20),
    utc(anio, 8, 7),
    utc(anio, 12, 8),
    utc(anio, 12, 25),
    // Trasladables al lunes.
    alLunes(utc(anio, 1, 6)),
    alLunes(utc(anio, 3, 19)),
    alLunes(utc(anio, 6, 29)),
    alLunes(utc(anio, 8, 15)),
    alLunes(utc(anio, 10, 12)),
    alLunes(utc(anio, 11, 1)),
    alLunes(utc(anio, 11, 11)),
    // Semana Santa.
    sumar(p, -3),
    sumar(p, -2),
    // Móviles por Pascua, ya en lunes: Ascensión, Corpus Christi, Sagrado Corazón.
    sumar(p, 43),
    sumar(p, 64),
    sumar(p, 71),
  ];
  const r = new Set(dias.map(iso));
  cache.set(anio, r);
  return r;
}

export function iso(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/** "AAAA-MM-DD" → día calendario a medianoche UTC. */
export function deIso(texto: string): Date {
  const [a, m, d] = texto.split("-").map(Number);
  return utc(a!, m!, d!);
}

export function esHabil(fecha: Date): boolean {
  const dow = fecha.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !festivosDeColombia(fecha.getUTCFullYear()).has(iso(fecha));
}

/** El enésimo día hábil después de `fecha` (sin contarla). */
export function sumarDiasHabiles(fecha: Date, n: number): Date {
  let r = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  let contados = 0;
  while (contados < n) {
    r = sumar(r, 1);
    if (esHabil(r)) contados++;
  }
  return r;
}

/**
 * Desde qué día se puede activar algo pagado en `pagadoEl`.
 *
 * El retracto dura los cinco días hábiles siguientes al pago, **incluido el
 * quinto**: activar ese mismo día le recortaría horas al taller. Se activa el
 * día hábil siguiente.
 */
export function activableDesde(pagadoEl: Date, diasDeRetracto = 5): Date {
  return sumarDiasHabiles(pagadoEl, diasDeRetracto + 1);
}

/** Hoy en Bogotá, como día calendario. */
export function hoyEnBogota(ahora = new Date()): Date {
  const texto = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(ahora);
  return deIso(texto);
}
