import { beforeEach, describe, expect, test } from "bun:test";
import {
  createDeliveryRoutes,
  createDurableDeliveryService,
  type DeliveryInput,
  type DeliveryRecord,
  type DeliveryStore,
  type DeliveryTokenIdentity,
} from "../src/delivery";
import { createRedisSendRateLimiter } from "../src/send-rate-limit";

const token: DeliveryTokenIdentity = {
  tokenId: "token-1",
  accountId: "account-1",
  senderId: "sender-1",
  senderEmail: "sender@example.com",
  scopes: ["send", "status"],
};

function record(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    messageId: "message-1@sendplug",
    accountId: "account-1",
    senderId: "sender-1",
    recipients: ["recipient@example.com"],
    subject: "Hello",
    status: "queued",
    error: null,
    details: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function setup(options: {
  identity?: DeliveryTokenIdentity | null;
  scopes?: string[];
  rateLimit?: { allowed: true } | { allowed: false; retryAfterSeconds: number };
  queueFails?: boolean;
  status?: DeliveryRecord | null;
} = {}) {
  const created: DeliveryInput[] = [];
  const enqueued: Array<DeliveryInput & { messageId: string }> = [];
  const failed: Array<{ messageId: string; error: string }> = [];
  const store: DeliveryStore = {
    async create(input) {
      created.push(input);
      return record({
        accountId: input.accountId,
        senderId: input.senderId,
        recipients: input.to,
        subject: input.subject,
      });
    },
    async markFailed(messageId, error) {
      failed.push({ messageId, error });
    },
    async find() {
      return options.status === undefined ? record() : options.status;
    },
  };
  const delivery = createDurableDeliveryService(store, {
    async enqueue(input) {
      if (options.queueFails) throw new Error("redis offline: secret details");
      enqueued.push(input);
    },
  });
  const identity = options.identity === undefined
    ? { ...token, scopes: options.scopes ?? token.scopes }
    : options.identity;
  const app = createDeliveryRoutes({
    async authenticateToken(raw) {
      return raw === "valid-token" ? identity : null;
    },
    delivery,
    rateLimit: { async check() { return options.rateLimit ?? { allowed: true }; } },
  });
  return { app, created, enqueued, failed };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

const nativePayload = {
  to: ["recipient@example.com"],
  subject: "Hello",
  body: "Plain text",
  html: "<p>Hello</p>",
};

describe("native delivery API", () => {
  test("creates one durable delivery and returns the existing 202 shape", async () => {
    const api = setup();
    const response = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify(nativePayload),
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "queued",
      message_id: "message-1@sendplug",
      sender_id: "sender-1",
    });
    expect(api.created).toEqual([{
      accountId: "account-1",
      senderId: "sender-1",
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Plain text",
      html: "<p>Hello</p>",
    }]);
    expect(api.enqueued[0]?.messageId).toBe("message-1@sendplug");
  });

  test("keeps the legacy send alias on the same service", async () => {
    const api = setup();
    const response = await api.app.handle(request("/send-email", {
      method: "POST",
      body: JSON.stringify(nativePayload),
    }));
    expect(response.status).toBe(202);
    expect(api.created).toHaveLength(1);
  });

  test("requires a valid sender-scoped token and send scope", async () => {
    const missing = setup();
    const missingResponse = await missing.app.handle(new Request("http://localhost/api/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nativePayload),
    }));
    expect(missingResponse.status).toBe(401);

    const wrongScope = setup({ scopes: ["status"] });
    expect((await wrongScope.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify(nativePayload),
    }))).status).toBe(403);

    const wrongSender = setup();
    expect((await wrongSender.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ ...nativePayload, sender_id: "sender-2" }),
    }))).status).toBe(403);
    expect(wrongSender.created).toHaveLength(0);
  });

  test("enforces exactly one recipient and at most ten cc/bcc recipients", async () => {
    const api = setup();
    const tooManyTo = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ ...nativePayload, to: ["one@example.com", "two@example.com"] }),
    }));
    const tooManyCc = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({
        ...nativePayload,
        cc: Array.from({ length: 11 }, (_, index) => `cc${index}@example.com`),
      }),
    }));
    expect(tooManyTo.status).toBe(422);
    expect(tooManyCc.status).toBe(422);
    expect(api.created).toHaveLength(0);
  });

  test("rejects message content larger than one megabyte", async () => {
    const api = setup();
    const response = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify({ ...nativePayload, body: "x".repeat(1_000_001) }),
    }));
    expect(response.status).toBe(422);
    expect(api.created).toHaveLength(0);
  });

  test("returns Retry-After when the sender burst is exhausted", async () => {
    const api = setup({ rateLimit: { allowed: false, retryAfterSeconds: 17 } });
    const response = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify(nativePayload),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(api.created).toHaveLength(0);
  });

  test("durably marks a created delivery failed before returning queue 503", async () => {
    const api = setup({ queueFails: true });
    const response = await api.app.handle(request("/api/v1/send", {
      method: "POST",
      body: JSON.stringify(nativePayload),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Delivery queue unavailable" });
    expect(api.failed).toEqual([{ messageId: "message-1@sendplug", error: "Queue unavailable" }]);
  });
});

describe("Resend compatibility", () => {
  test("accepts the current official Resend SDK-shaped payload and ignores display name", async () => {
    const api = setup();
    // Shape emitted by resend.emails.send({ from, to, subject, html }).
    const payload = {
      from: "Acme <sender@example.com>",
      to: ["delivered@resend.dev"],
      subject: "hello world",
      html: "<strong>it works!</strong>",
    };
    const response = await api.app.handle(request("/emails", {
      method: "POST",
      body: JSON.stringify(payload),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "message-1@sendplug" });
    expect(api.created[0]).toMatchObject({
      senderId: "sender-1",
      to: ["delivered@resend.dev"],
      body: "",
      html: "<strong>it works!</strong>",
    });
  });

  test("accepts text and string recipient forms", async () => {
    const api = setup();
    const response = await api.app.handle(request("/emails", {
      method: "POST",
      body: JSON.stringify({
        from: "sender@example.com",
        to: "recipient@example.com",
        cc: "copy@example.com",
        subject: "Plain",
        text: "Hello",
      }),
    }));
    expect(response.status).toBe(200);
    expect(api.created[0]).toMatchObject({
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      body: "Hello",
      html: null,
    });
  });

  test("rejects a from address not bound to the token", async () => {
    const api = setup();
    const response = await api.app.handle(request("/emails", {
      method: "POST",
      body: JSON.stringify({
        from: "Other <other@example.com>",
        to: ["recipient@example.com"],
        subject: "Spoof",
        text: "No",
      }),
    }));
    expect(response.status).toBe(403);
    expect(api.created).toHaveLength(0);
  });

  test("requires text or html and preserves recipient limits", async () => {
    const api = setup();
    const noContent = await api.app.handle(request("/emails", {
      method: "POST",
      body: JSON.stringify({
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Missing",
      }),
    }));
    const tooManyBcc = await api.app.handle(request("/emails", {
      method: "POST",
      body: JSON.stringify({
        from: "sender@example.com",
        to: ["recipient@example.com"],
        bcc: Array.from({ length: 11 }, (_, index) => `bcc${index}@example.com`),
        subject: "Too many",
        text: "Hello",
      }),
    }));
    expect(noContent.status).toBe(422);
    expect(tooManyBcc.status).toBe(422);
  });
});

describe("delivery status", () => {
  test("returns authorized status from native and legacy aliases without accountId", async () => {
    for (const path of ["/api/v1/emails/message-1%40sendplug", "/emails/message-1%40sendplug"]) {
      const api = setup();
      const response = await api.app.handle(request(path));
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        status: "queued",
        message_id: "message-1@sendplug",
        sender_id: "sender-1",
        to: ["recipient@example.com"],
      });
      expect(body.accountId).toBeUndefined();
    }
  });

  test("conceals missing and cross-account or cross-sender delivery existence", async () => {
    for (const status of [
      null,
      record({ accountId: "account-2" }),
      record({ senderId: "sender-2" }),
    ]) {
      const api = setup({ status });
      const response = await api.app.handle(request("/api/v1/emails/message-1"));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Email not found" });
    }
  });

  test("requires status scope", async () => {
    const api = setup({ scopes: ["send"] });
    expect((await api.app.handle(request("/api/v1/emails/message-1"))).status).toBe(403);
  });
});

describe("Redis send burst limiter", () => {
  test("uses one atomic fixed-window script and rounds Retry-After up", async () => {
    const calls: unknown[][] = [];
    const redis = {
      async eval(...args: unknown[]) {
        calls.push(args);
        return [6, 1_001];
      },
    };
    const limiter = createRedisSendRateLimiter(redis, { limit: 5, windowSeconds: 10 });
    expect(await limiter.check("sender-1")).toEqual({ allowed: false, retryAfterSeconds: 2 });
    expect(calls[0]?.slice(1)).toEqual([1, "sendplug:send-rate:sender-1", 10_000]);
  });

  test("rejects invalid configuration and malformed Redis results", async () => {
    expect(() => createRedisSendRateLimiter({ eval: async () => [] }, { limit: 0, windowSeconds: 1 })).toThrow();
    const limiter = createRedisSendRateLimiter({ eval: async () => "bad" }, { limit: 1, windowSeconds: 1 });
    await expect(limiter.check("sender-1")).rejects.toThrow("Invalid Redis rate-limit response");
  });
});
