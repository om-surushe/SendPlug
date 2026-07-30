import { Elysia, t } from "elysia";

const GMAIL_SMTP = { smtpHost: "smtp.gmail.com", smtpPort: 587, useTls: true } as const;
const TOKEN_SCOPES = ["send", "status"] as const;
const MAX_SENDERS_PER_ACCOUNT = 5;
const MAX_ACTIVE_TOKENS_PER_ACCOUNT = 20;

export type AccountIdentity = { accountId: string; recoveryAdmin: boolean };

export type AccountIdentityProvider = {
  authenticate(request: Request): Promise<AccountIdentity | null>;
};

export type SenderRecord = {
  id: string;
  name: string;
  email: string;
  smtpHost: "smtp.gmail.com";
  smtpPort: 587;
  useTls: true;
  dailyLimit: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  senderId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type SuppressionRecord = { email: string; reason: string; createdAt: string };
export type CampaignSummary = {
  id: string;
  name: string;
  senderId: string;
  subject: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  createdAt: string;
};

export type AccountStore = {
  dashboard(accountId: string): Promise<{
    senders: number;
    tokens: number;
    suppressed: number;
    campaigns: number;
    sent: number;
    failed: number;
  }>;
  recentCampaigns(accountId: string, limit: number): Promise<CampaignSummary[]>;
  listSenders(accountId: string): Promise<SenderRecord[]>;
  getSender(accountId: string, senderId: string): Promise<SenderRecord | null>;
  getSenderCredentials(accountId: string, senderId: string): Promise<{ email: string; appPassword: string } | null>;
  createSender(accountId: string, input: {
    name: string;
    email: string;
    appPassword: string;
    dailyLimit: number;
    smtpHost: "smtp.gmail.com";
    smtpPort: 587;
    useTls: true;
  }): Promise<SenderRecord>;
  updateSender(accountId: string, senderId: string, input: {
    name: string;
    email: string;
    appPassword?: string;
    dailyLimit: number;
    active: boolean;
    smtpHost: "smtp.gmail.com";
    smtpPort: 587;
    useTls: true;
  }): Promise<SenderRecord | null>;
  deleteSender(accountId: string, senderId: string): Promise<boolean>;
  listTokens(accountId: string): Promise<ApiTokenRecord[]>;
  getToken(accountId: string, tokenId: string): Promise<ApiTokenRecord | null>;
  createToken(accountId: string, input: { name: string; senderId: string; scopes: TokenScope[] }): Promise<{
    token: ApiTokenRecord;
    rawToken: string;
  }>;
  updateToken(accountId: string, tokenId: string, input: {
    name: string;
    senderId: string;
    scopes: TokenScope[];
  }): Promise<ApiTokenRecord | null>;
  revokeToken(accountId: string, tokenId: string): Promise<boolean>;
  listSuppressions(accountId: string): Promise<SuppressionRecord[]>;
};

export type SenderConnectionTester = {
  test(input: {
    email: string;
    appPassword: string;
    smtpHost: "smtp.gmail.com";
    smtpPort: 587;
    startTls: true;
  }): Promise<void>;
};

export type AccountApiDependencies = {
  identity: AccountIdentityProvider;
  store: AccountStore;
  senderConnection: SenderConnectionTester;
  senderTestRateLimit: {
    check(accountId: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
  };
};

export class AccountApiConflictError extends Error {}

const senderCreateSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  email: t.String({ format: "email" }),
  appPassword: t.String({ minLength: 1, maxLength: 128 }),
  dailyLimit: t.Optional(t.Number({ minimum: 1, maximum: 2000 })),
});
const senderUpdateSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  email: t.String({ format: "email" }),
  appPassword: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  dailyLimit: t.Optional(t.Number({ minimum: 1, maximum: 2000 })),
  active: t.Optional(t.Boolean()),
});
const tokenSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  senderId: t.String({ minLength: 1 }),
  scopes: t.Array(t.Union([t.Literal("send"), t.Literal("status")]), { minItems: 1, maxItems: 2 }),
});

function normalizeAppPassword(value: string): string | null {
  const normalized = value.replaceAll(/\s/g, "");
  return normalized.length === 16 ? normalized : null;
}

function normalizedScopes(scopes: TokenScope[]): TokenScope[] {
  return TOKEN_SCOPES.filter((scope) => scopes.includes(scope));
}

function publicSender(sender: SenderRecord): SenderRecord {
  const { id, name, email, smtpHost, smtpPort, useTls, dailyLimit, active, createdAt, updatedAt } = sender;
  return { id, name, email, smtpHost, smtpPort, useTls, dailyLimit, active, createdAt, updatedAt };
}

function publicToken(token: ApiTokenRecord): ApiTokenRecord {
  const { id, name, prefix, scopes, senderId, createdAt, lastUsedAt, revokedAt } = token;
  return { id, name, prefix, scopes, senderId, createdAt, lastUsedAt, revokedAt };
}

function error(set: { status?: number | string }, status: number, message: string) {
  set.status = status;
  return { error: message };
}

export function createAccountApi(dependencies: AccountApiDependencies) {
  async function identity(request: Request, set: { status?: number | string }) {
    const authenticated = await dependencies.identity.authenticate(request);
    if (!authenticated) error(set, 401, "Not authenticated");
    return authenticated;
  }

  return new Elysia({ name: "sendplug-account-api", prefix: "/api/v1" })
    .get("/dashboard", async ({ request, set }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      const dashboard = await dependencies.store.dashboard(owner.accountId);
      if (!owner.recoveryAdmin) {
        return {
          senders: dashboard.senders,
          tokens: dashboard.tokens,
          suppressed: dashboard.suppressed,
          sent: dashboard.sent,
          failed: dashboard.failed,
        };
      }
      return {
        ...dashboard,
        recentCampaigns: await dependencies.store.recentCampaigns(owner.accountId, 5),
      };
    })
    .get("/senders", async ({ request, set }) => {
      const owner = await identity(request, set);
      return owner
        ? (await dependencies.store.listSenders(owner.accountId)).map(publicSender)
        : { error: "Not authenticated" };
    })
    .post("/senders", async ({ request, set, body }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      // ponytail: a per-account count is enough for the hosted beta; add a DB constraint if concurrent creation becomes common.
      if ((await dependencies.store.listSenders(owner.accountId)).length >= MAX_SENDERS_PER_ACCOUNT) {
        return error(set, 429, `Each account can have at most ${MAX_SENDERS_PER_ACCOUNT} senders`);
      }
      const appPassword = normalizeAppPassword(body.appPassword);
      if (!appPassword) return error(set, 422, "Gmail App Password must contain exactly 16 non-whitespace characters");
      try {
        const sender = await dependencies.store.createSender(owner.accountId, {
          name: body.name.trim(),
          email: body.email.trim().toLowerCase(),
          appPassword,
          dailyLimit: body.dailyLimit ?? 400,
          ...GMAIL_SMTP,
        });
        set.status = 201;
        return publicSender(sender);
      } catch (cause) {
        if (cause instanceof AccountApiConflictError) return error(set, 409, cause.message);
        throw cause;
      }
    }, { body: senderCreateSchema })
    .put("/senders/:senderId", async ({ request, set, params, body }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      if (!await dependencies.store.getSender(owner.accountId, params.senderId)) {
        return error(set, 404, "Sender not found");
      }
      const appPassword = body.appPassword === undefined ? undefined : normalizeAppPassword(body.appPassword);
      if (body.appPassword !== undefined && !appPassword) {
        return error(set, 422, "Gmail App Password must contain exactly 16 non-whitespace characters");
      }
      try {
        const updated = await dependencies.store.updateSender(owner.accountId, params.senderId, {
          name: body.name.trim(),
          email: body.email.trim().toLowerCase(),
          ...(appPassword ? { appPassword } : {}),
          dailyLimit: body.dailyLimit ?? 400,
          active: body.active ?? true,
          ...GMAIL_SMTP,
        });
        return updated ? publicSender(updated) : error(set, 404, "Sender not found");
      } catch (cause) {
        if (cause instanceof AccountApiConflictError) return error(set, 409, cause.message);
        throw cause;
      }
    }, { body: senderUpdateSchema })
    .post("/senders/:senderId/test", async ({ request, set, params }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      const credentials = await dependencies.store.getSenderCredentials(owner.accountId, params.senderId);
      if (!credentials) return error(set, 404, "Sender not found");
      const rate = await dependencies.senderTestRateLimit.check(owner.accountId);
      if (!rate.allowed) {
        set.headers["retry-after"] = String(rate.retryAfterSeconds);
        return error(set, 429, "Too many Gmail connection tests");
      }
      try {
        await dependencies.senderConnection.test({
          ...credentials,
          smtpHost: GMAIL_SMTP.smtpHost,
          smtpPort: GMAIL_SMTP.smtpPort,
          startTls: true,
        });
        return { status: "connected" as const };
      } catch {
        return error(set, 400, "Gmail connection failed");
      }
    })
    .delete("/senders/:senderId", async ({ request, set, params }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      if (!await dependencies.store.getSender(owner.accountId, params.senderId)) {
        return error(set, 404, "Sender not found");
      }
      if (!await dependencies.store.deleteSender(owner.accountId, params.senderId)) {
        return error(set, 404, "Sender not found");
      }
      set.status = 204;
    })
    .get("/tokens", async ({ request, set }) => {
      const owner = await identity(request, set);
      return owner
        ? (await dependencies.store.listTokens(owner.accountId)).map(publicToken)
        : { error: "Not authenticated" };
    })
    .post("/tokens", async ({ request, set, body }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      if (!await dependencies.store.getSender(owner.accountId, body.senderId)) {
        return error(set, 400, "Sender not found");
      }
      if ((await dependencies.store.listTokens(owner.accountId)).filter((token) => !token.revokedAt).length >= MAX_ACTIVE_TOKENS_PER_ACCOUNT) {
        return error(set, 429, `Each account can have at most ${MAX_ACTIVE_TOKENS_PER_ACCOUNT} active API tokens`);
      }
      const created = await dependencies.store.createToken(owner.accountId, {
        name: body.name.trim(), senderId: body.senderId, scopes: normalizedScopes(body.scopes),
      });
      set.status = 201;
      return { ...publicToken(created.token), token: created.rawToken };
    }, { body: tokenSchema })
    .put("/tokens/:tokenId", async ({ request, set, params, body }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      if (!await dependencies.store.getToken(owner.accountId, params.tokenId)) {
        return error(set, 404, "API token not found");
      }
      if (!await dependencies.store.getSender(owner.accountId, body.senderId)) {
        return error(set, 400, "Sender not found");
      }
      const updated = await dependencies.store.updateToken(owner.accountId, params.tokenId, {
        name: body.name.trim(), senderId: body.senderId, scopes: normalizedScopes(body.scopes),
      });
      return updated ? publicToken(updated) : error(set, 404, "API token not found");
    }, { body: tokenSchema })
    .delete("/tokens/:tokenId", async ({ request, set, params }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      if (!await dependencies.store.getToken(owner.accountId, params.tokenId)) {
        return error(set, 404, "API token not found");
      }
      if (!await dependencies.store.revokeToken(owner.accountId, params.tokenId)) {
        return error(set, 404, "API token not found");
      }
      set.status = 204;
    })
    .get("/suppressions", async ({ request, set }) => {
      const owner = await identity(request, set);
      return owner ? dependencies.store.listSuppressions(owner.accountId) : { error: "Not authenticated" };
    })
    .post("/campaigns/:campaignId/start", async ({ request, set }) => {
      const owner = await identity(request, set);
      if (!owner) return { error: "Not authenticated" };
      return error(set, 403, "Campaign launch is not available in the hosted service");
    });
}
