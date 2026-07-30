import { Elysia, t } from "elysia";
import type { SendRateLimiter } from "./send-rate-limit";

export type DeliveryTokenIdentity = {
  tokenId: string;
  accountId: string;
  senderId: string;
  senderEmail: string;
  scopes: string[];
};

export type DeliveryInput = {
  accountId: string;
  senderId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html: string | null;
};

export type DeliveryRecord = {
  messageId: string;
  accountId: string;
  senderId: string;
  recipients: string[];
  subject: string;
  status: "queued" | "sending" | "sent" | "failed";
  error: string | null;
  details: unknown | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type DeliveryStore = {
  create(input: DeliveryInput): Promise<DeliveryRecord>;
  markFailed(messageId: string, error: string): Promise<void>;
  find(messageId: string): Promise<DeliveryRecord | null>;
};

export type DeliveryQueue = {
  enqueue(input: DeliveryInput & { messageId: string }): Promise<void>;
};

export type DeliveryService = {
  createAndEnqueue(input: DeliveryInput): Promise<DeliveryRecord>;
  find(messageId: string): Promise<DeliveryRecord | null>;
};

export class DeliveryQueueUnavailableError extends Error {}

export function createDurableDeliveryService(
  store: DeliveryStore,
  queue: DeliveryQueue,
): DeliveryService {
  return {
    async createAndEnqueue(input) {
      const delivery = await store.create(input);
      try {
        await queue.enqueue({ ...input, messageId: delivery.messageId });
      } catch {
        await store.markFailed(delivery.messageId, "Queue unavailable");
        throw new DeliveryQueueUnavailableError("Queue unavailable");
      }
      return delivery;
    },
    find(messageId) {
      return store.find(messageId);
    },
  };
}

export type DeliveryRouteDependencies = {
  authenticateToken(rawToken: string): Promise<DeliveryTokenIdentity | null>;
  delivery: DeliveryService;
  rateLimit: SendRateLimiter;
};

const email = t.String({ format: "email", maxLength: 320 });
const recipients = t.Array(email, { maxItems: 10 });
const content = t.String({ maxLength: 1_000_000 });

const nativeBody = t.Object({
  to: t.Array(email, { minItems: 1, maxItems: 1 }),
  cc: t.Optional(recipients),
  bcc: t.Optional(recipients),
  subject: t.String({ minLength: 1, maxLength: 998 }),
  body: t.Optional(content),
  html: t.Optional(t.Union([content, t.Null()])),
  sender_id: t.Optional(t.String({ minLength: 1 })),
});

const resendRecipient = t.Union([email, t.Array(email, { minItems: 1, maxItems: 1 })]);
const resendRecipients = t.Union([email, recipients]);
const resendBody = t.Object({
  from: t.String({ minLength: 3, maxLength: 500 }),
  to: resendRecipient,
  cc: t.Optional(resendRecipients),
  bcc: t.Optional(resendRecipients),
  subject: t.String({ minLength: 1, maxLength: 998 }),
  text: t.Optional(content),
  html: t.Optional(content),
});

type RouteSet = { status?: number | string; headers: Record<string, string | number> };

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function emailFrom(value: string): string | null {
  const trimmed = value.trim();
  const angleAddress = trimmed.match(/<([^<>]+)>\s*$/)?.[1]?.trim();
  const address = angleAddress ?? trimmed;
  return address.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)
    ? address.toLowerCase()
    : null;
}

function asArray(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function publicStatus(delivery: DeliveryRecord) {
  return {
    status: delivery.status,
    message_id: delivery.messageId,
    to: delivery.recipients,
    subject: delivery.subject,
    sender_id: delivery.senderId,
    created_at: new Date(delivery.createdAt).toISOString(),
    updated_at: new Date(delivery.updatedAt).toISOString(),
    error: delivery.error,
    details: delivery.details,
  };
}

export function createDeliveryRoutes(dependencies: DeliveryRouteDependencies) {
  async function identity(request: Request, scope: "send" | "status", set: RouteSet) {
    const raw = bearerToken(request);
    const authenticated = raw ? await dependencies.authenticateToken(raw) : null;
    if (!authenticated) {
      set.status = 401;
      return { error: "Invalid or missing API token" } as const;
    }
    if (!authenticated.scopes.includes(scope)) {
      set.status = 403;
      return { error: `API token lacks ${scope} scope` } as const;
    }
    return authenticated;
  }

  async function submit(
    token: DeliveryTokenIdentity,
    input: Omit<DeliveryInput, "accountId" | "senderId">,
    set: RouteSet,
  ) {
    let limited;
    try {
      limited = await dependencies.rateLimit.check(token.senderId);
    } catch {
      set.status = 503;
      return { error: "Rate limiter unavailable" } as const;
    }
    if (!limited.allowed) {
      set.status = 429;
      set.headers["retry-after"] = String(limited.retryAfterSeconds);
      return { error: "Send rate limit exceeded" } as const;
    }
    try {
      return { delivery: await dependencies.delivery.createAndEnqueue({
        ...input,
        accountId: token.accountId,
        senderId: token.senderId,
      }) };
    } catch (error) {
      if (error instanceof DeliveryQueueUnavailableError) {
        set.status = 503;
        return { error: "Delivery queue unavailable" } as const;
      }
      throw error;
    }
  }

  async function sendNative({ body, request, set }: { body: typeof nativeBody.static; request: Request; set: RouteSet }) {
    const token = await identity(request, "send", set);
    if ("error" in token) return token;
    if (body.sender_id && body.sender_id !== token.senderId) {
      set.status = 403;
      return { error: "API token is restricted to another sender" };
    }
    const delivery = await submit(token, {
      to: body.to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject,
      body: body.body ?? "",
      html: body.html ?? null,
    }, set);
    if ("error" in delivery) return delivery;
    set.status = 202;
    return { status: "queued", message_id: delivery.delivery.messageId, sender_id: token.senderId } as const;
  }

  async function sendResend({ body, request, set }: { body: typeof resendBody.static; request: Request; set: RouteSet }) {
    const token = await identity(request, "send", set);
    if ("error" in token) return token;
    const senderEmail = emailFrom(body.from);
    if (!senderEmail) {
      set.status = 422;
      return { error: "from must contain one email address" };
    }
    if (senderEmail !== token.senderEmail.toLowerCase()) {
      set.status = 403;
      return { error: "API token is restricted to another sender" };
    }
    if (body.text === undefined && body.html === undefined) {
      set.status = 422;
      return { error: "text or html is required" };
    }
    const delivery = await submit(token, {
      to: asArray(body.to),
      cc: asArray(body.cc),
      bcc: asArray(body.bcc),
      subject: body.subject,
      body: body.text ?? "",
      html: body.html ?? null,
    }, set);
    if ("error" in delivery) return delivery;
    set.status = 200;
    return { id: delivery.delivery.messageId };
  }

  async function status({ params, request, set }: {
    params: { messageId: string };
    request: Request;
    set: RouteSet;
  }) {
    const token = await identity(request, "status", set);
    if ("error" in token) return token;
    const delivery = await dependencies.delivery.find(params.messageId);
    if (!delivery || delivery.accountId !== token.accountId || delivery.senderId !== token.senderId) {
      set.status = 404;
      return { error: "Email not found" };
    }
    return publicStatus(delivery);
  }

  return new Elysia({ name: "sendplug-delivery" })
    .post("/api/v1/send", sendNative, { body: nativeBody })
    .post("/send-email", sendNative, { body: nativeBody, detail: { hide: true } })
    .post("/emails", sendResend, { body: resendBody })
    .get("/api/v1/emails/:messageId", status)
    .get("/emails/:messageId", status, { detail: { hide: true } });
}
