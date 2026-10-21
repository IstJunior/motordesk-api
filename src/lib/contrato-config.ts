import { prisma } from "./db.js";

// Los datos del prestador para el contrato de los talleres, en
// `system_settings` bajo `contrato_taller`: la misma clave y forma que lee el
// monolito (`src/lib/legal/firma-electronica.ts`). Sin fila, las variables
// CONTRATO_* del entorno.

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

export const CLAVE_CONTRATO = "contrato_taller";
export const MAX_BYTES_FIRMA = 400 * 1024;

/** Los mismos de `TIPOS_DE_DOCUMENTO` en el monolito (`contrato-taller.ts`). */
export const TIPOS_DE_DOCUMENTO = ["CC", "CE", "PPT", "PA"] as const;
export type TipoDeDocumento = (typeof TIPOS_DE_DOCUMENTO)[number];

// Antes no se guardaba el tipo: lo que había era una cédula.
function tipoDe(v: unknown): TipoDeDocumento {
  return TIPOS_DE_DOCUMENTO.find((t) => t === v) ?? "CC";
}

type ConfigContrato = {
  nombre: string;
  tipoDocumento: TipoDeDocumento;
  documento: string;
  direccion: string;
  firmaPng: string | null;
};

/** Si están el nombre y el documento: sin ellos nadie puede firmar. */
export async function prestadorCompleto(): Promise<boolean> {
  const { config } = await configContrato();
  return Boolean(config.nombre && config.documento);
}

export async function configContrato(): Promise<{ config: ConfigContrato; guardado: boolean }> {
  const fila = await prisma.systemSetting.findUnique({ where: { key: CLAVE_CONTRATO } });
  const v = fila?.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const g = v as Record<string, unknown>;
    return {
      guardado: true,
      config: {
        nombre: texto(g.nombre),
        tipoDocumento: tipoDe(g.tipoDocumento),
        documento: texto(g.documento),
        direccion: texto(g.direccion),
        firmaPng: texto(g.firmaPng) || null,
      },
    };
  }
  // Sin fila: lo que hoy tiene el entorno, para que guardar no apague nada.
  return {
    guardado: false,
    config: {
      nombre: process.env.CONTRATO_PRESTADOR_NOMBRE?.trim() ?? "",
      tipoDocumento: tipoDe(process.env.CONTRATO_PRESTADOR_DOC_TIPO?.trim()),
      documento: process.env.CONTRATO_PRESTADOR_DOCUMENTO?.trim() ?? "",
      direccion: process.env.CONTRATO_PRESTADOR_DIRECCION?.trim() ?? "",
      firmaPng: process.env.CONTRATO_PRESTADOR_FIRMA_PNG?.trim() || null,
    },
  };
}

