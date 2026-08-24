import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

export interface R2Object {
  key: string;
  size: number;
  lastModified: Date;
}

const R2_ENV_KEYS = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;

let client: S3Client | null = null;

export function r2Configured(): boolean {
  return R2_ENV_KEYS.every((key) => Boolean(process.env[key]));
}

function required(key: (typeof R2_ENV_KEYS)[number]): string {
  const value = process.env[key];
  if (!value) throw new Error(`Falta la variable ${key}`);
  return value;
}

function getClient(): S3Client {
  if (client) return client;
  const config: S3ClientConfig = {
    region: "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  };
  client = new S3Client(config);
  return client;
}

export async function listR2Objects(prefix: string): Promise<R2Object[]> {
  if (!r2Configured()) throw new Error("R2 no está configurado");
  const objects: R2Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await getClient().send(
      new ListObjectsV2Command({
        Bucket: required("R2_BUCKET_NAME"),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      objects.push({
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified ?? new Date(0),
      });
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

export async function uploadR2Object(key: string, body: Buffer, contentType: string): Promise<string> {
  if (!r2Configured()) throw new Error("R2 no está configurado");
  await getClient().send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET_NAME"),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

// Sube un stream cuyo tamaño ya se conoce (p.ej. el dump de pg_dump ya escrito
// en disco). PutObject exige ContentLength cuando el body no es un Buffer.
export async function uploadR2Stream(
  key: string,
  body: Readable,
  contentLength: number,
  contentType = "application/octet-stream",
): Promise<string> {
  if (!r2Configured()) throw new Error("R2 no está configurado");
  await getClient().send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET_NAME"),
      Key: key,
      Body: body,
      ContentLength: contentLength,
      ContentType: contentType,
    }),
  );
  return key;
}

// Descarga un objeto como stream (para reenviarlo al panel sin cargarlo entero).
export async function getR2Stream(key: string): Promise<{ body: Readable; size: number }> {
  if (!r2Configured()) throw new Error("R2 no está configurado");
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: required("R2_BUCKET_NAME"), Key: key }),
  );
  if (!res.Body) throw new Error(`El objeto ${key} no tiene contenido`);
  return { body: res.Body as Readable, size: res.ContentLength ?? 0 };
}

export async function getR2Buffer(key: string): Promise<Buffer> {
  const { body } = await getR2Stream(key);
  const partes: Buffer[] = [];
  for await (const trozo of body) partes.push(Buffer.from(trozo as Buffer));
  return Buffer.concat(partes);
}

export async function deleteR2Object(key: string): Promise<void> {
  if (!r2Configured()) throw new Error("R2 no está configurado");
  await getClient().send(
    new DeleteObjectCommand({ Bucket: required("R2_BUCKET_NAME"), Key: key }),
  );
}
