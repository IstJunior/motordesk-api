import type { R2Object } from "./r2.js";

export interface R2Manual {
  id: string;
  key: string;
  title: string;
  brand: string;
  model: string;
  year: number | null;
  category: string;
  fileSize: number;
  lastModified: Date;
  internalId: string;
}

export function parseR2Manual(object: R2Object): R2Manual | null {
  const { key } = object;
  if (!key.toLowerCase().endsWith(".pdf")) return null;

  const parts = key.split("/");
  if (parts.length < 4 || parts[0] !== "Manuales Colombia Top") return null;

  const brand = parts[1] || "Desconocido";
  const modelFolder = parts[2] || "";
  const filename = parts[parts.length - 1] || "";
  const nameWithoutExtension = filename.replace(/\.pdf$/i, "");
  const segments = nameWithoutExtension.split(" - ");
  const internalId = segments[0]?.trim() || "";

  let year: number | null = null;
  const lastSegment = segments[segments.length - 1]?.trim() || "";
  if (/^\d{4}$/.test(lastSegment)) year = Number(lastSegment);

  const workshopIndex = segments.findIndex((segment) => segment.trim().toLowerCase() === "taller");
  const modelFromFilename = workshopIndex > 1 ? segments.slice(1, workshopIndex).join(" - ").trim() : "";
  const model = modelFromFilename || modelFolder;

  return {
    id: key,
    key,
    title: `${model} - Taller${year ? ` ${year}` : ""}`,
    brand,
    model,
    year,
    category: "Taller",
    fileSize: object.size,
    lastModified: object.lastModified,
    internalId,
  };
}
