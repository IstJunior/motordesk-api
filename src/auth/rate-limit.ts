// Rate-limit en memoria para la superficie pública de la API: el login del
// superadmin (fuerza bruta contra la credencial) y el chat de leads (que escribe
// en la base sin autenticación).
//
// Suficiente mientras la API corra en una sola instancia. Si se escala a varias,
// el contador tiene que mudarse a Redis o el límite se multiplica por instancia.
import type { Context, Next } from "hono";

interface Cubeta {
  conteo: number;
  reinicioEn: number; // epoch ms
}

const cubetas = new Map<string, Cubeta>();

// Limpieza perezosa: purga cubetas vencidas cada tanto para no crecer sin fin.
let ultimaPurga = Date.now();
function purgar(ahora: number) {
  if (ahora - ultimaPurga < 60_000) return;
  ultimaPurga = ahora;
  for (const [k, v] of cubetas) if (v.reinicioEn <= ahora) cubetas.delete(k);
}

// IP del cliente detrás del proxy (Traefik/Coolify ponen X-Forwarded-For).
function ipCliente(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "desconocida";
}

export type OpcionesRateLimit = {
  max?: number;
  ventanaMs?: number;
  // Cuenta solo las respuestas de error (>= 400). Para el login: así el
  // superadmin puede entrar y salir las veces que quiera sin gastar cupo, y solo
  // los intentos fallidos acercan al bloqueo.
  soloErrores?: boolean;
  // Identificador extra para que variar la IP no evada el límite.
  clave?: (c: Context) => string;
};

export function rateLimit(opts: OpcionesRateLimit = {}) {
  const max = opts.max ?? 8;
  const ventanaMs = opts.ventanaMs ?? 15 * 60_000;

  return async (c: Context, next: Next) => {
    const ahora = Date.now();
    purgar(ahora);

    const extra = opts.clave ? opts.clave(c) : "";
    const k = `${ipCliente(c)}|${c.req.path}|${extra}`;
    const b = cubetas.get(k);
    const vigente = b && b.reinicioEn > ahora ? b : null;

    if (vigente && vigente.conteo >= max) {
      const seg = Math.ceil((vigente.reinicioEn - ahora) / 1000);
      c.header("Retry-After", String(seg));
      return c.json(
        { error: `Demasiados intentos. Espera ${Math.ceil(seg / 60)} min e inténtalo de nuevo.` },
        429,
      );
    }

    await next();

    if (opts.soloErrores && c.res.status < 400) return;

    if (vigente) vigente.conteo++;
    else cubetas.set(k, { conteo: 1, reinicioEn: ahora + ventanaMs });
  };
}

// Solo para pruebas: vacía los contadores.
export function reiniciarRateLimit(): void {
  cubetas.clear();
}
