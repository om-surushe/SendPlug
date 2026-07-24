import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(key: Uint8Array): Buffer {
  const bytes = Buffer.from(key);
  if (bytes.length !== 32) throw new Error("Provider encryption key must be 32 bytes");
  return bytes;
}

export function encryptProviderToken(token: string, key: Uint8Array, context: string): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptProviderToken(payload: Uint8Array, key: Uint8Array, context: string): string {
  const bytes = Buffer.from(payload);
  if (bytes.length <= 1 + IV_BYTES + TAG_BYTES || bytes[0] !== VERSION) {
    throw new Error("Invalid encrypted provider token");
  }
  const iv = bytes.subarray(1, 1 + IV_BYTES);
  const tag = bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
