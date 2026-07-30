import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "./index";

export type ApiTokenIdentity = {
  sub: string;
  purpose: "api_token";
  tokenId: string;
  senderId: string;
  accountId: string;
  scopes: string[];
};

export function tokenDigest(token: string, pepper: Uint8Array): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

function matchesDigest(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createApiToken(
  database: Database,
  accountId: string,
  input: { name: string; scopes: string[]; senderId: string },
  pepper: Uint8Array,
) {
  const sender = await database.sender.findFirst({
    where: { id: input.senderId, accountId },
    select: { id: true },
  });
  if (!sender) throw new Error("Sender not found");

  const id = randomUUID().replaceAll("-", "");
  const prefix = `smtp_${id.slice(0, 8)}`;
  const raw = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const token = await database.apiToken.create({
    data: {
      id,
      name: input.name.trim(),
      prefix,
      tokenHash: tokenDigest(raw, pepper),
      scopes: [...new Set(input.scopes)].sort(),
      senderId: sender.id,
    },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      senderId: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return { token, raw };
}

export function listAccountApiTokens(database: Database, accountId: string) {
  return database.apiToken.findMany({
    where: { sender: { accountId } },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      senderId: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateAccountApiToken(
  database: Database,
  accountId: string,
  tokenId: string,
  input: { name?: string; scopes?: string[]; senderId?: string },
) {
  const existing = await database.apiToken.findFirst({
    where: { id: tokenId, sender: { accountId } },
    select: { id: true },
  });
  if (!existing) throw new Error("API token not found");
  if (input.senderId) {
    const sender = await database.sender.findFirst({ where: { id: input.senderId, accountId }, select: { id: true } });
    if (!sender) throw new Error("Sender not found");
  }
  return database.apiToken.update({
    where: { id: existing.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.scopes === undefined ? {} : { scopes: [...new Set(input.scopes)].sort() }),
      ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
    },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      senderId: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
}

export async function revokeAccountApiToken(
  database: Database,
  accountId: string,
  tokenId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await database.apiToken.updateMany({
    where: { id: tokenId, sender: { accountId }, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count > 0;
}

export async function verifyApiToken(
  database: Database,
  raw: string,
  pepper: Uint8Array,
): Promise<ApiTokenIdentity | null> {
  if (!raw.startsWith("smtp_") || raw.split("_").length < 3) return null;
  const prefix = raw.split("_", 3).slice(0, 2).join("_");
  const digest = tokenDigest(raw, pepper);
  const candidates = await database.apiToken.findMany({
    where: { prefix, revokedAt: null, sender: { active: true } },
    include: { sender: { select: { accountId: true } } },
  });
  const matched = candidates.find((candidate) => matchesDigest(candidate.tokenHash, digest));
  if (!matched?.senderId || !matched.sender) return null;

  await database.apiToken.update({ where: { id: matched.id }, data: { lastUsedAt: new Date() } });
  return {
    sub: matched.name,
    purpose: "api_token",
    tokenId: matched.id,
    senderId: matched.senderId,
    accountId: matched.sender.accountId,
    scopes: matched.scopes,
  };
}
