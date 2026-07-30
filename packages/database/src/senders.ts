import { createDecipheriv, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "./index";
import { decryptProviderToken, encryptProviderToken } from "./provider-crypto";

export const GMAIL_SMTP = { host: "smtp.gmail.com", port: 587, useTls: true } as const;

const publicSenderSelect = {
  id: true,
  accountId: true,
  gmailConnectionId: true,
  name: true,
  email: true,
  smtpHost: true,
  smtpPort: true,
  useTls: true,
  dailyLimit: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error("A valid sender email is required");
  return normalized;
}

function normalizeAppPassword(value: string): string {
  const password = value.replaceAll(/\s/g, "");
  if (!/^[a-z0-9]{16}$/i.test(password)) throw new Error("Gmail App Password must be 16 letters or digits");
  return password;
}

function encryptedAppPassword(value: string, key: Uint8Array, senderId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encryptProviderToken(value, key, `sender:${senderId}:app-password`));
}

function dailyLimit(value: number | undefined): number {
  const result = value ?? 400;
  if (!Number.isInteger(result) || result < 1) throw new RangeError("dailyLimit must be a positive integer");
  return result;
}

export type GmailAppPasswordSenderInput = {
  name: string;
  email: string;
  appPassword: string;
  dailyLimit?: number;
};

export async function createGmailAppPasswordSender(
  database: Database,
  accountId: string,
  input: GmailAppPasswordSenderInput,
  encryptionKey: Uint8Array,
) {
  const id = `sender_${randomUUID().replaceAll("-", "")}`;
  const password = normalizeAppPassword(input.appPassword);
  return database.sender.create({
    data: {
      id,
      accountId,
      name: input.name.trim() || normalizeEmail(input.email),
      email: normalizeEmail(input.email),
      encryptedAppPassword: encryptedAppPassword(password, encryptionKey, id),
      smtpHost: GMAIL_SMTP.host,
      smtpPort: GMAIL_SMTP.port,
      useTls: GMAIL_SMTP.useTls,
      dailyLimit: dailyLimit(input.dailyLimit),
    },
    select: publicSenderSelect,
  });
}

export function listAccountSenders(database: Database, accountId: string, includeInactive = false) {
  return database.sender.findMany({
    where: { accountId, ...(includeInactive ? {} : { active: true }) },
    select: publicSenderSelect,
    orderBy: { createdAt: "desc" },
  });
}

export function getAccountSender(database: Database, accountId: string, senderId: string) {
  return database.sender.findFirst({ where: { id: senderId, accountId }, select: publicSenderSelect });
}

export type UpdateGmailAppPasswordSenderInput = {
  name?: string;
  email?: string;
  appPassword?: string;
  dailyLimit?: number;
  active?: boolean;
};

export async function updateGmailAppPasswordSender(
  database: Database,
  accountId: string,
  senderId: string,
  input: UpdateGmailAppPasswordSenderInput,
  encryptionKey: Uint8Array,
) {
  const sender = await database.sender.findFirst({ where: { id: senderId, accountId }, select: { id: true } });
  if (!sender) throw new Error("Sender not found");
  return database.sender.update({
    where: { id: sender.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.email === undefined ? {} : { email: normalizeEmail(input.email) }),
      ...(input.appPassword === undefined
        ? {}
        : {
            encryptedAppPassword: encryptedAppPassword(normalizeAppPassword(input.appPassword), encryptionKey, sender.id),
          }),
      ...(input.dailyLimit === undefined ? {} : { dailyLimit: dailyLimit(input.dailyLimit) }),
      ...(input.active === undefined ? {} : { active: input.active }),
      smtpHost: GMAIL_SMTP.host,
      smtpPort: GMAIL_SMTP.port,
      useTls: GMAIL_SMTP.useTls,
    },
    select: publicSenderSelect,
  });
}

// Sender history and deliveries retain their foreign keys, so DELETE is an archive operation.
export async function deleteAccountSender(database: Database, accountId: string, senderId: string) {
  const result = await database.sender.updateMany({ where: { id: senderId, accountId }, data: { active: false } });
  return result.count > 0;
}

function legacyKeyBytes(key: string | Uint8Array): Buffer {
  const value = typeof key === "string" ? Buffer.from(key, "base64url") : Buffer.from(key);
  if (value.length !== 32) throw new Error("Legacy Fernet key must decode to 32 bytes");
  return value;
}

export function decryptLegacyFernet(token: string, key: string | Uint8Array): string {
  const payload = Buffer.from(token, "base64url");
  if (payload.length < 73 || payload[0] !== 0x80) throw new Error("Invalid legacy Fernet secret");
  const signed = payload.subarray(0, -32);
  const signature = payload.subarray(-32);
  const keyBytes = legacyKeyBytes(key);
  const actual = createHmac("sha256", keyBytes.subarray(0, 16)).update(signed).digest();
  if (!timingSafeEqual(signature, actual)) throw new Error("Invalid legacy Fernet secret");
  const decipher = createDecipheriv("aes-128-cbc", keyBytes.subarray(16), payload.subarray(9, 25));
  return Buffer.concat([decipher.update(payload.subarray(25, -32)), decipher.final()]).toString("utf8");
}

export type SenderSecretKeys = {
  encryptionKey?: Uint8Array;
  legacyFernetKey?: string | Uint8Array;
};

export async function getSenderCredentials(
  database: Database,
  accountId: string,
  senderId: string,
  keys: SenderSecretKeys,
) {
  const sender = await database.sender.findFirst({
    where: { id: senderId, accountId, active: true },
    select: {
      id: true,
      email: true,
      smtpHost: true,
      smtpPort: true,
      useTls: true,
      encryptedAppPassword: true,
      legacyEncryptedSecret: true,
    },
  });
  if (!sender) return null;

  let password: string;
  if (sender.encryptedAppPassword) {
    if (!keys.encryptionKey) throw new Error("Provider encryption key is required");
    password = decryptProviderToken(sender.encryptedAppPassword, keys.encryptionKey, `sender:${sender.id}:app-password`);
  } else if (sender.legacyEncryptedSecret) {
    if (!keys.legacyFernetKey) throw new Error("Legacy Fernet key is required");
    password = decryptLegacyFernet(sender.legacyEncryptedSecret, keys.legacyFernetKey);
  } else {
    throw new Error("Sender has no SMTP secret");
  }

  return {
    senderId: sender.id,
    username: sender.email,
    password,
    host: sender.smtpHost,
    port: sender.smtpPort,
    useTls: sender.useTls,
  };
}

export async function getAccountDashboard(database: Database, accountId: string, recentLimit = 10) {
  const limit = Math.max(0, Math.min(100, Math.trunc(recentLimit)));
  const [account, activeSenders, activeTokens, deliveryGroups, recentDeliveries] = await Promise.all([
    database.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, createdAt: true } }),
    database.sender.count({ where: { accountId, active: true } }),
    database.apiToken.count({ where: { sender: { accountId }, revokedAt: null } }),
    database.delivery.groupBy({ by: ["status"], where: { accountId }, _count: { _all: true } }),
    database.delivery.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        messageId: true,
        senderId: true,
        recipients: true,
        subject: true,
        status: true,
        error: true,
        details: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  if (!account) return null;
  const deliveries = { QUEUED: 0, SENDING: 0, SENT: 0, FAILED: 0 };
  for (const group of deliveryGroups) deliveries[group.status] = group._count._all;
  return { account, activeSenders, activeTokens, deliveries, recentDeliveries };
}
