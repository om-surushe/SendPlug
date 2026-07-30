import { describe, expect, test } from "bun:test";
import {
  createAccountApi,
  type AccountStore,
  type ApiTokenRecord,
  type SenderRecord,
} from "../src/account-api";

const password = "abcdefghijklmnop";
const senderA: SenderRecord = {
  id: "sender-a", name: "A sender", email: "a@example.com", smtpHost: "smtp.gmail.com", smtpPort: 587,
  useTls: true, dailyLimit: 400, active: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const senderB: SenderRecord = { ...senderA, id: "sender-b", name: "B sender", email: "b@example.com" };
const tokenA: ApiTokenRecord = {
  id: "token-a", name: "Production", prefix: "smtp_12345678", scopes: ["send"], senderId: senderA.id,
  createdAt: "2026-01-01", lastUsedAt: null, revokedAt: null,
};

function fixture(options: { extraSenders?: number; extraTokens?: number; senderTestAllowed?: boolean } = {}) {
  const senderOwners = new Map([[senderA.id, "account-a"], [senderB.id, "account-b"]]);
  const tokenOwners = new Map([[tokenA.id, "account-a"]]);
  const calls = {
    createdSender: undefined as Parameters<AccountStore["createSender"]>[1] | undefined,
    tested: undefined as Parameters<Parameters<typeof createAccountApi>[0]["senderConnection"]["test"]>[0] | undefined,
    createdToken: undefined as Parameters<AccountStore["createToken"]>[1] | undefined,
    updatedToken: undefined as Parameters<AccountStore["updateToken"]>[2] | undefined,
    deletedSenders: 0,
    revokedTokens: 0,
    recentCampaignAccounts: [] as string[],
    suppressionAccounts: [] as string[],
  };
  const byId = (id: string) => id === senderA.id ? senderA : id === senderB.id ? senderB : null;
  const store: AccountStore = {
    async dashboard() { return { senders: 1, tokens: 1, suppressed: 2, campaigns: 3, sent: 4, failed: 5 }; },
    async recentCampaigns(accountId, limit) {
      calls.recentCampaignAccounts.push(accountId);
      return [{ id: "campaign-a", name: "Legacy", senderId: senderA.id, subject: "Hi", status: "completed", total: limit, sent: 4, failed: 1, createdAt: "2026-01-01" }];
    },
    async listSenders(accountId) {
      return [senderA, senderB]
        .filter((sender) => senderOwners.get(sender.id) === accountId)
        .concat(Array.from({ length: accountId === "account-a" ? options.extraSenders ?? 0 : 0 }, (_, index) => ({ ...senderA, id: `extra-${index}` })))
        .map((sender) => ({ ...sender, appPassword: password }));
    },
    async getSender(accountId, senderId) { return senderOwners.get(senderId) === accountId ? byId(senderId) : null; },
    async getSenderCredentials(accountId, senderId) {
      const sender = senderOwners.get(senderId) === accountId ? byId(senderId) : null;
      return sender ? { email: sender.email, appPassword: password } : null;
    },
    async createSender(accountId, input) {
      calls.createdSender = input;
      senderOwners.set("created", accountId);
      return { ...senderA, id: "created", name: input.name, email: input.email, dailyLimit: input.dailyLimit, appPassword: password };
    },
    async updateSender(accountId, senderId, input) {
      const sender = senderOwners.get(senderId) === accountId ? byId(senderId) : null;
      return sender ? { ...sender, ...input } : null;
    },
    async deleteSender(accountId, senderId) {
      if (senderOwners.get(senderId) !== accountId) return false;
      calls.deletedSenders += 1;
      return true;
    },
    async listTokens(accountId) {
      return tokenOwners.get(tokenA.id) === accountId
        ? [{ ...tokenA, tokenHash: "stored-secret", token: "stored-raw" }, ...Array.from({ length: options.extraTokens ?? 0 }, (_, index) => ({ ...tokenA, id: `extra-token-${index}` }))]
        : [];
    },
    async getToken(accountId, tokenId) { return tokenOwners.get(tokenId) === accountId ? tokenA : null; },
    async createToken(accountId, input) {
      calls.createdToken = input;
      tokenOwners.set("created-token", accountId);
      return { token: { ...tokenA, id: "created-token", senderId: input.senderId, scopes: input.scopes }, rawToken: "smtp_once_only" };
    },
    async updateToken(accountId, tokenId, input) {
      if (tokenOwners.get(tokenId) !== accountId) return null;
      calls.updatedToken = input;
      return { ...tokenA, name: input.name, senderId: input.senderId, scopes: input.scopes };
    },
    async revokeToken(accountId, tokenId) {
      if (tokenOwners.get(tokenId) !== accountId) return false;
      calls.revokedTokens += 1;
      return true;
    },
    async listSuppressions(accountId) {
      calls.suppressionAccounts.push(accountId);
      return [{ email: `${accountId}@example.com`, reason: "unsubscribed", createdAt: "2026-01-01" }];
    },
  };
  const app = createAccountApi({
    identity: {
      async authenticate(request) {
        const accountId = request.headers.get("x-account");
        return accountId ? { accountId, recoveryAdmin: request.headers.get("x-recovery") === "true" } : null;
      },
    },
    store,
    senderConnection: { async test(input) { calls.tested = input; } },
    senderTestRateLimit: { async check() {
      return options.senderTestAllowed === false
        ? { allowed: false as const, retryAfterSeconds: 30 }
        : { allowed: true as const };
    } },
  });
  const request = (path: string, options: { method?: string; body?: unknown; account?: string | null; recovery?: boolean } = {}) => {
    const headers = new Headers();
    if (options.account !== null) headers.set("x-account", options.account ?? "account-a");
    if (options.recovery) headers.set("x-recovery", "true");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return app.handle(new Request(`http://localhost${path}`, {
      ...(options.method ? { method: options.method } : {}),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }));
  };
  return { request, calls };
}

const senderBody = { name: " Gmail sender ", email: "FOUNDER@EXAMPLE.COM", appPassword: "abcd efgh ijkl mnop", dailyLimit: 300 };
const tokenBody = { name: "App", senderId: senderA.id, scopes: ["status", "send"] };

describe("account API authentication and account ownership", () => {
  test("requires an injected authenticated identity", async () => {
    const { request } = fixture();
    const response = await request("/api/v1/senders", { account: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });

  test("scopes sender reads and mutations to the identity account", async () => {
    const { request, calls } = fixture();
    expect(await (await request("/api/v1/senders", { account: "account-b" })).json()).toEqual([senderB]);
    expect((await request(`/api/v1/senders/${senderA.id}`, { method: "DELETE", account: "account-b" })).status).toBe(404);
    expect((await request(`/api/v1/senders/${senderA.id}/test`, { method: "POST", account: "account-b" })).status).toBe(404);
    expect(calls.deletedSenders).toBe(0);
    expect(calls.tested).toBeUndefined();
  });

  test("rejects cross-account token sender binding", async () => {
    const { request, calls } = fixture();
    const response = await request("/api/v1/tokens", {
      method: "POST", account: "account-b", body: { ...tokenBody, senderId: senderA.id, scopes: ["send"] },
    });
    expect(response.status).toBe(400);
    expect(calls.createdToken).toBeUndefined();
  });

  test("hides foreign token IDs for updates and revocation", async () => {
    const { request, calls } = fixture();
    expect((await request(`/api/v1/tokens/${tokenA.id}`, { method: "PUT", account: "account-b", body: tokenBody })).status).toBe(404);
    expect((await request(`/api/v1/tokens/${tokenA.id}`, { method: "DELETE", account: "account-b" })).status).toBe(404);
    expect(calls.updatedToken).toBeUndefined();
    expect(calls.revokedTokens).toBe(0);
  });
});

describe("Gmail sender administration", () => {
  test("normalizes a 16-character App Password and fixes Gmail STARTTLS settings", async () => {
    const { request, calls } = fixture();
    const response = await request("/api/v1/senders", { method: "POST", body: senderBody });
    expect(response.status).toBe(201);
    expect(calls.createdSender).toEqual({
      name: "Gmail sender", email: "founder@example.com", appPassword: password, dailyLimit: 300,
      smtpHost: "smtp.gmail.com", smtpPort: 587, useTls: true,
    });
    expect(JSON.stringify(await response.json())).not.toContain(password);
  });

  test("rejects an App Password that is not 16 characters after normalization", async () => {
    const { request, calls } = fixture();
    const response = await request("/api/v1/senders", { method: "POST", body: { ...senderBody, appPassword: "too short" } });
    expect(response.status).toBe(422);
    expect(calls.createdSender).toBeUndefined();
  });

  test("caps senders per account", async () => {
    const { request, calls } = fixture({ extraSenders: 4 });
    expect((await request("/api/v1/senders", { method: "POST", body: senderBody })).status).toBe(429);
    expect(calls.createdSender).toBeUndefined();
  });

  test("rate limits Gmail connection tests per account", async () => {
    const { request, calls } = fixture({ senderTestAllowed: false });
    const response = await request(`/api/v1/senders/${senderA.id}/test`, { method: "POST" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(calls.tested).toBeUndefined();
  });

  test("tests owned credentials without returning or reflecting the secret", async () => {
    const { request, calls } = fixture();
    const response = await request(`/api/v1/senders/${senderA.id}/test`, { method: "POST" });
    expect(calls.tested).toEqual({
      email: senderA.email, appPassword: password, smtpHost: "smtp.gmail.com", smtpPort: 587, startTls: true,
    });
    expect(await response.json()).toEqual({ status: "connected" });
  });
});

describe("tokens, suppressions, and hosted campaign restrictions", () => {
  test("shows raw token only on creation and keeps rotation manual", async () => {
    const { request, calls } = fixture();
    const created = await request("/api/v1/tokens", { method: "POST", body: tokenBody });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "created-token", token: "smtp_once_only", scopes: ["send", "status"] });

    const listed = await (await request("/api/v1/tokens")).json();
    expect(JSON.stringify(listed)).not.toContain("smtp_once_only");
    expect(JSON.stringify(listed)).not.toContain("stored-secret");
    expect(JSON.stringify(listed)).not.toContain("stored-raw");
    const updated = await (await request(`/api/v1/tokens/${tokenA.id}`, { method: "PUT", body: { ...tokenBody, scopes: ["status"] } })).json();
    expect(updated).not.toHaveProperty("token");
    expect(calls.updatedToken).toEqual({ name: "App", senderId: senderA.id, scopes: ["status"] });
    expect(calls.revokedTokens).toBe(0);
  });

  test("caps active API tokens per account", async () => {
    const { request, calls } = fixture({ extraTokens: 19 });
    expect((await request("/api/v1/tokens", { method: "POST", body: tokenBody })).status).toBe(429);
    expect(calls.createdToken).toBeUndefined();
  });

  test("reads suppressions only for the authenticated account", async () => {
    const { request, calls } = fixture();
    expect(await (await request("/api/v1/suppressions", { account: "account-b" })).json()).toEqual([
      { email: "account-b@example.com", reason: "unsubscribed", createdAt: "2026-01-01" },
    ]);
    expect(calls.suppressionAccounts).toEqual(["account-b"]);
  });

  test("only exposes campaign dashboard data to the recovery administrator", async () => {
    const { request, calls } = fixture();
    expect(await (await request("/api/v1/dashboard")).json()).toEqual({
      senders: 1, tokens: 1, suppressed: 2, sent: 4, failed: 5,
    });
    expect(calls.recentCampaignAccounts).toEqual([]);

    expect(await (await request("/api/v1/dashboard", { recovery: true })).json()).toMatchObject({
      campaigns: 3, sent: 4, failed: 5, recentCampaigns: [{ id: "campaign-a" }],
    });
    expect(calls.recentCampaignAccounts).toEqual(["account-a"]);
  });

  test("forbids campaign launch in the hosted account API", async () => {
    const { request } = fixture();
    const response = await request("/api/v1/campaigns/campaign-a/start", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Campaign launch is not available in the hosted service" });
  });
});
