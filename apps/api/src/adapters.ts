import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Redis from "ioredis";
import {
  createApiToken,
  createDelivery,
  createGmailAppPasswordSender,
  getAccountDelivery,
  getAccountSender,
  getSenderCredentials,
  listAccountApiTokens,
  listAccountSenders,
  markDeliveryFailed,
  revokeAccountApiToken,
  updateAccountApiToken,
  updateGmailAppPasswordSender,
  verifyApiToken,
  type Database,
} from "@sendplug/database";
import { AccountApiConflictError, type AccountApiDependencies, type AccountIdentity } from "./account-api";
import { createDurableDeliveryService, type DeliveryQueue, type DeliveryRecord, type DeliveryRouteDependencies } from "./delivery";
import type { LocalAuthDependencies, LocalAuthIdentity } from "./local-auth";
import { createRedisSendRateLimiter } from "./send-rate-limit";

function dates<T extends { createdAt: Date; updatedAt: Date }>(value: T) {
  return { ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() };
}

function cookie(request: Request, name: string): string | null {
  const item = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
}

export function createSessionResolver(redis: Pick<Redis, "get">, secure: boolean, sessionSecret: string) {
  return async (request: Request): Promise<LocalAuthIdentity | null> => {
    const raw = cookie(request, secure ? "__Host-sendplug_local_session" : "sendplug_local_session");
    if (!raw) return null;
    const digest = createHmac("sha256", sessionSecret).update(raw).digest("hex");
    const serialized = await redis.get(`sendplug:local-auth:session:${digest}`);
    if (!serialized) return null;
    try {
      const value = JSON.parse(serialized) as LocalAuthIdentity;
      return value?.accountId && value.user?.id && value.user.email ? value : null;
    } catch { return null; }
  };
}

export function createLocalAuthStore(database: Database): LocalAuthDependencies["store"] {
  return {
    async findLocalCredential(email) {
      const found = await database.localIdentity.findUnique({
        where: { email },
        include: { user: { include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } } } },
      });
      const membership = found?.user.memberships[0];
      return found && membership ? {
        passwordHash: found.passwordHash,
        identity: {
          accountId: membership.accountId,
          user: { id: found.user.id, email: found.user.email, name: found.user.name },
          role: membership.role.toLowerCase(),
        },
      } : null;
    },
    async createLocalIdentity({ email, name, passwordHash }) {
      const suffix = randomUUID().replaceAll("-", "");
      try {
        return await database.$transaction(async (tx) => {
          const account = await tx.account.create({ data: { id: `account_${suffix}`, name: `${name}'s SendPlug` } });
          const user = await tx.user.create({ data: {
            id: `user_${suffix}`, provider: "local", providerSubject: email, email, name, lastLoginAt: new Date(),
            localIdentity: { create: { email, passwordHash } },
          } });
          const membership = await tx.membership.create({ data: { accountId: account.id, userId: user.id, role: "OWNER" } });
          return { accountId: account.id, user: { id: user.id, email: user.email, name: user.name }, role: membership.role.toLowerCase() };
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") return null;
        throw error;
      }
    },
  };
}

export async function recoveryIdentity(database: Database, email: string, password: string, configured: { email: string; password: string }) {
  const left = Buffer.from(password); const right = Buffer.from(configured.password);
  if (email !== configured.email || left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const user = await database.user.findFirst({
    where: { email: configured.email, provider: "recovery" },
    include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const membership = user?.memberships[0];
  return user && membership ? {
    accountId: membership.accountId,
    user: { id: user.id, email: user.email, name: user.name },
    role: membership.role.toLowerCase(),
    recovery: true,
  } : null;
}

function senderRecord(sender: Awaited<ReturnType<typeof getAccountSender>>) {
  if (!sender) return null;
  return {
    id: sender.id, name: sender.name, email: sender.email,
    smtpHost: "smtp.gmail.com" as const, smtpPort: 587 as const, useTls: true as const,
    dailyLimit: sender.dailyLimit, active: sender.active,
    createdAt: sender.createdAt.toISOString(), updatedAt: sender.updatedAt.toISOString(),
  };
}

export function createAccountDependencies(input: {
  database: Database;
  resolveIdentity(request: Request): Promise<LocalAuthIdentity | null>;
  encryptionKey: Uint8Array;
  legacyFernetKey: string;
  tokenPepper: Uint8Array;
  testSender(input: { email: string; appPassword: string }): Promise<void>;
}): Omit<AccountApiDependencies, "senderTestRateLimit"> {
  const { database } = input;
  return {
    identity: { async authenticate(request) {
      const value = await input.resolveIdentity(request);
      return value ? { accountId: value.accountId, recoveryAdmin: Boolean(value.recovery) } satisfies AccountIdentity : null;
    } },
    senderConnection: { test: ({ email, appPassword }) => input.testSender({ email, appPassword }) },
    store: {
      async dashboard(accountId) {
        const [senders, tokens, suppressed, campaigns, sent, failed] = await Promise.all([
          database.sender.count({ where: { accountId, active: true } }),
          database.apiToken.count({ where: { sender: { accountId }, revokedAt: null } }),
          database.suppression.count({ where: { accountId } }),
          database.campaign.count({ where: { sender: { accountId } } }),
          database.delivery.count({ where: { accountId, status: "SENT" } }),
          database.delivery.count({ where: { accountId, status: "FAILED" } }),
        ]);
        return { senders, tokens, suppressed, campaigns, sent, failed };
      },
      async recentCampaigns(accountId, limit) {
        const rows = await database.campaign.findMany({ where: { sender: { accountId } }, orderBy: { createdAt: "desc" }, take: limit });
        return rows.map((row) => ({ ...row, senderId: row.senderId, status: row.status.toLowerCase(), createdAt: row.createdAt.toISOString() }));
      },
      async listSenders(accountId) { return (await listAccountSenders(database, accountId, true)).map((row) => senderRecord(row)!); },
      async getSender(accountId, senderId) { return senderRecord(await getAccountSender(database, accountId, senderId)); },
      async getSenderCredentials(accountId, senderId) {
        const value = await getSenderCredentials(database, accountId, senderId, { encryptionKey: input.encryptionKey, legacyFernetKey: input.legacyFernetKey });
        return value ? { email: value.username, appPassword: value.password } : null;
      },
      async createSender(accountId, value) {
        try { return senderRecord(await createGmailAppPasswordSender(database, accountId, value, input.encryptionKey))!; }
        catch (error) { if ((error as { code?: string }).code === "P2002") throw new AccountApiConflictError("Sender already exists"); throw error; }
      },
      async updateSender(accountId, senderId, value) {
        try { return senderRecord(await updateGmailAppPasswordSender(database, accountId, senderId, value, input.encryptionKey)); }
        catch (error) { if ((error as { code?: string }).code === "P2002") throw new AccountApiConflictError("Sender already exists"); if ((error as Error).message === "Sender not found") return null; throw error; }
      },
      async deleteSender(accountId, senderId) { return (await database.sender.updateMany({ where: { id: senderId, accountId }, data: { active: false } })).count > 0; },
      async listTokens(accountId) { return (await listAccountApiTokens(database, accountId)).map((row) => ({ ...row, senderId: row.senderId!, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null, scopes: row.scopes.filter((s): s is "send" | "status" => s === "send" || s === "status") })); },
      async getToken(accountId, tokenId) {
        const row = await database.apiToken.findFirst({ where: { id: tokenId, sender: { accountId } } });
        return row?.senderId ? { ...row, senderId: row.senderId, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null, scopes: row.scopes.filter((s): s is "send" | "status" => s === "send" || s === "status") } : null;
      },
      async createToken(accountId, value) { const created = await createApiToken(database, accountId, value, input.tokenPepper); return { token: { ...created.token, senderId: created.token.senderId!, createdAt: created.token.createdAt.toISOString(), lastUsedAt: created.token.lastUsedAt?.toISOString() ?? null, revokedAt: created.token.revokedAt?.toISOString() ?? null, scopes: created.token.scopes.filter((s): s is "send" | "status" => s === "send" || s === "status") }, rawToken: created.raw }; },
      async updateToken(accountId, tokenId, value) { try { const row = await updateAccountApiToken(database, accountId, tokenId, value); return { ...row, senderId: row.senderId!, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null, scopes: row.scopes.filter((s): s is "send" | "status" => s === "send" || s === "status") }; } catch (error) { if ((error as Error).message === "API token not found") return null; throw error; } },
      async revokeToken(accountId, tokenId) { return revokeAccountApiToken(database, accountId, tokenId); },
      async listSuppressions(accountId) { return (await database.suppression.findMany({ where: { accountId }, orderBy: { createdAt: "desc" } })).map((row) => ({ email: row.email, reason: row.reason, createdAt: row.createdAt.toISOString() })); },
    },
  };
}

function deliveryRecord(row: { messageId: string; accountId: string; senderId: string; recipients: string[]; subject: string; status: string; error: string | null; details: unknown; createdAt: Date; updatedAt: Date }): DeliveryRecord {
  return { ...row, status: row.status.toLowerCase() as DeliveryRecord["status"] };
}

export function createDeliveryDependencies(input: {
  database: Database;
  queue: DeliveryQueue;
  redis: Redis;
  tokenPepper: Uint8Array;
  burstLimit: number;
  burstWindowSeconds: number;
}): DeliveryRouteDependencies {
  const store = {
    async create(value: Parameters<ReturnType<typeof createDurableDeliveryService>["createAndEnqueue"]>[0]) {
      const row = await createDelivery(input.database, value.accountId, {
        senderId: value.senderId,
        recipients: [...value.to, ...value.cc, ...value.bcc],
        subject: value.subject,
        details: { to: value.to, cc: value.cc, bcc: value.bcc },
      });
      return deliveryRecord(row);
    },
    async markFailed(messageId: string, error: string) {
      const row = await input.database.delivery.findUnique({ where: { messageId } });
      if (row) await markDeliveryFailed(input.database, row.accountId, messageId, error, { senderId: row.senderId });
    },
    async find(messageId: string) { const row = await input.database.delivery.findUnique({ where: { messageId } }); return row ? deliveryRecord(row) : null; },
  };
  return {
    async authenticateToken(raw) {
      const identity = await verifyApiToken(input.database, raw, input.tokenPepper);
      if (!identity) return null;
      const sender = await input.database.sender.findUnique({ where: { id: identity.senderId }, select: { email: true } });
      return sender ? { tokenId: identity.tokenId, accountId: identity.accountId, senderId: identity.senderId, senderEmail: sender.email, scopes: identity.scopes } : null;
    },
    delivery: createDurableDeliveryService(store, input.queue),
    rateLimit: createRedisSendRateLimiter(input.redis, { limit: input.burstLimit, windowSeconds: input.burstWindowSeconds }),
  };
}
