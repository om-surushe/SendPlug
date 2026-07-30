import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from "node:crypto";
import type { Database } from "./index";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_BYTES = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizedEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error("A valid email address is required");
  return normalized;
}

function derivePassword(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derived) => (error ? reject(error) : resolve(Buffer.from(derived))),
    );
  });
}

export async function hashLocalPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("Password must contain at least 8 characters");
  const salt = randomBytes(16);
  const digest = await derivePassword(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltValue, digestValue, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || extra || !n || !r || !p || !saltValue || !digestValue) return false;
  if (Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_R || Number(p) !== SCRYPT_P) return false;

  try {
    const expected = Buffer.from(digestValue, "base64url");
    if (expected.length !== SCRYPT_BYTES) return false;
    const actual = await derivePassword(password, Buffer.from(saltValue, "base64url"));
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export type LocalIdentityInput = {
  email: string;
  password: string;
  name?: string;
  accountName?: string;
};

export async function createLocalIdentity(database: Database, input: LocalIdentityInput) {
  const email = normalizedEmail(input.email);
  const name = input.name?.trim() || email;
  const passwordHash = await hashLocalPassword(input.password);
  const suffix = randomUUID().replaceAll("-", "");

  return database.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: {
        id: `account_${suffix}`,
        name: input.accountName?.trim() || (name === email ? "My SendPlug account" : `${name}'s SendPlug`),
      },
    });
    const user = await tx.user.create({
      data: {
        id: `user_${suffix}`,
        provider: "local",
        providerSubject: email,
        email,
        name,
        lastLoginAt: new Date(),
        localIdentity: { create: { email, passwordHash } },
      },
    });
    await tx.membership.create({ data: { accountId: account.id, userId: user.id, role: "OWNER" } });
    return { accountId: account.id, user };
  });
}

export async function authenticateLocalIdentity(database: Database, emailInput: string, password: string) {
  const email = normalizedEmail(emailInput);
  const identity = await database.localIdentity.findUnique({
    where: { email },
    include: { user: { include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } } } },
  });
  if (!identity || !(await verifyLocalPassword(password, identity.passwordHash))) return null;
  const membership = identity.user.memberships[0];
  if (!membership) return null;
  const user = await database.user.update({
    where: { id: identity.userId },
    data: { lastLoginAt: new Date() },
  });
  return { accountId: membership.accountId, user };
}

export function sessionTokenDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createAccountSession(
  database: Database,
  identity: { accountId: string; userId: string },
  options: { now?: Date; ttlMs?: number } = {},
) {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
  const raw = `session_${randomBytes(32).toString("base64url")}`;
  const session = await database.accountSession.create({
    data: {
      id: randomUUID().replaceAll("-", ""),
      tokenHash: sessionTokenDigest(raw),
      accountId: identity.accountId,
      userId: identity.userId,
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  });
  return { raw, session };
}

export async function getAccountSession(database: Database, raw: string, now = new Date()) {
  if (!raw.startsWith("session_")) return null;
  const session = await database.accountSession.findUnique({
    where: { tokenHash: sessionTokenDigest(raw) },
    include: { membership: { include: { user: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  await database.accountSession.update({ where: { id: session.id }, data: { lastUsedAt: now } });
  return {
    sessionId: session.id,
    accountId: session.accountId,
    user: session.membership.user,
    expiresAt: session.expiresAt,
  };
}

export async function revokeAccountSession(database: Database, raw: string, now = new Date()): Promise<boolean> {
  const result = await database.accountSession.updateMany({
    where: { tokenHash: sessionTokenDigest(raw), revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count > 0;
}
