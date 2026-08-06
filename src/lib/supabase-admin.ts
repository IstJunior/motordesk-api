// Administración de cuentas en Supabase Auth (GoTrue) con la service role key.
// Se habla con la API REST directamente para no arrastrar supabase-js.

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";

export function supabaseAdminDisponible(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

// Variables que faltan para poder gestionar contraseñas, para poder decirlo en
// el panel en vez de dejar el campo gris sin explicación.
export function faltantesSupabaseAdmin(): string[] {
  const faltan: string[] = [];
  if (!SUPABASE_URL) faltan.push("SUPABASE_URL");
  if (!SERVICE_KEY) faltan.push("SUPABASE_SERVICE_ROLE_KEY");
  return faltan;
}

function exigirConfig() {
  if (!supabaseAdminDisponible()) {
    throw new Error(
      "Falta SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_URL) en la API para crear cuentas de acceso.",
    );
  }
}

async function admin<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  exigirConfig();
  const res = await fetch(`${SUPABASE_URL}/auth/v1${ruta}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const texto = await res.text();
  const data = texto ? JSON.parse(texto) : null;
  if (!res.ok) {
    const mensaje = data?.msg || data?.message || data?.error_description || `Supabase ${res.status}`;
    throw new Error(mensaje);
  }
  return data as T;
}

type AuthUser = { id: string; email?: string | null };

export async function buscarAuthUserPorEmail(email: string): Promise<string | null> {
  const normalizado = email.trim().toLowerCase();
  if (!normalizado) return null;
  for (let page = 1; page <= 10; page++) {
    const data = await admin<{ users?: AuthUser[] }>(`/admin/users?page=${page}&per_page=1000`);
    const usuarios = data.users ?? [];
    const hallado = usuarios.find((u) => u.email?.toLowerCase() === normalizado);
    if (hallado) return hallado.id;
    if (usuarios.length < 1000) return null;
  }
  return null;
}

// Crea la cuenta de acceso o actualiza su contraseña si ya existía.
// Devuelve el uid de Supabase.
export async function crearOActualizarAuthUser(input: {
  email: string;
  password: string;
  name: string;
}): Promise<string> {
  const existente = await buscarAuthUserPorEmail(input.email);
  if (existente) {
    const data = await admin<{ id?: string }>(`/admin/users/${existente}`, {
      method: "PUT",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { name: input.name },
      }),
    });
    return data.id ?? existente;
  }

  const data = await admin<{ id: string }>("/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { name: input.name },
    }),
  });
  return data.id;
}

// Cambia el correo de acceso. Si la cuenta aún no existe en Supabase no hay
// nada que mover: se creará con el correo nuevo al asignarle contraseña.
export async function actualizarEmailAuth(
  emailActual: string,
  emailNuevo: string,
  nombre: string,
): Promise<void> {
  const uid = await buscarAuthUserPorEmail(emailActual);
  if (!uid) return;
  await admin(`/admin/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({
      email: emailNuevo,
      email_confirm: true,
      user_metadata: { name: nombre },
    }),
  });
}
