import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

function decodeUrlBase64(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

/** Decrypts Python cryptography.fernet tokens used by the legacy SMTP service. */
export function decryptLegacyAppPassword(token: string, encodedKey: string): string {
  const key = decodeUrlBase64(encodedKey.trim());
  const payload = decodeUrlBase64(token);
  if (key.length !== 32 || payload.length < 73 || payload[0] !== 0x80) throw new Error("Invalid encrypted credential");

  const signed = payload.subarray(0, -32);
  const signature = payload.subarray(-32);
  const expected = createHmac("sha256", key.subarray(0, 16)).update(signed).digest();
  if (!timingSafeEqual(signature, expected)) throw new Error("Invalid encrypted credential");

  try {
    const decipher = createDecipheriv("aes-128-cbc", key.subarray(16), payload.subarray(9, 25));
    return Buffer.concat([decipher.update(payload.subarray(25, -32)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Invalid encrypted credential");
  }
}
