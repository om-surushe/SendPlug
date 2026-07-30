import { createHash, createHmac, randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";

export type LocalAuthIdentity = {
  accountId: string;
  user: { id: string; email: string; name: string };
  role?: string;
  recovery?: boolean;
};

export type LocalCredential = {
  identity: LocalAuthIdentity;
  passwordHash: string;
};

export type LocalAuthStore = {
  findLocalCredential(email: string): Promise<LocalCredential | null>;
  createLocalIdentity(input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<LocalAuthIdentity | null>;
};

export type LocalAuthRedis = {
  set(key: string, value: string, expiryMode: "EX", seconds: number, condition?: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
};

export type LocalAuthDependencies = {
  store: LocalAuthStore;
  redis: LocalAuthRedis;
  signupsEnabled: boolean;
  googleEnabled: boolean;
  secureCookies: boolean;
  clientIp(request: Request): string;
  authenticateRecovery?: (email: string, password: string) => Promise<LocalAuthIdentity | null>;
  resolveWorkOSSession?: (request: Request) => Promise<LocalAuthIdentity | null>;
  sessionTtlSeconds?: number;
  sessionSecret?: string;
};

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$3O2PApx+THaMr0LHUfM6HkeL/9i3tsDMvMXSkX1sN0c$I5EmzXFXGaPg8y8RQYfhrRNbkRWLPZ8EkFLqUGznHSo";

function cookieName(secure: boolean): string {
  return secure ? "__Host-sendplug_local_session" : "sendplug_local_session";
}

function sessionCookie(value: string, secure: boolean, ttl: number, clear = false): string {
  return [
    `${cookieName(secure)}=${clear ? "" : encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    clear ? "Max-Age=0" : `Max-Age=${ttl}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function readSessionCookie(request: Request, secure: boolean): string | null {
  const name = cookieName(secure);
  const entry = request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
}

function sessionKey(token: string, secret?: string): string {
  const digest = secret
    ? createHmac("sha256", secret).update(token).digest("hex")
    : createHash("sha256").update(token).digest("hex");
  return `sendplug:local-auth:session:${digest}`;
}

function isIdentity(value: unknown): value is LocalAuthIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<LocalAuthIdentity>;
  return Boolean(
    typeof identity.accountId === "string" &&
      identity.user &&
      typeof identity.user.id === "string" &&
      typeof identity.user.email === "string" &&
      typeof identity.user.name === "string",
  );
}

function error(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

async function allowRequest(
  redis: LocalAuthRedis,
  kind: "register" | "login",
  ip: string,
  maximum: number,
  windowSeconds: number,
): Promise<boolean> {
  const ipHash = createHash("sha256").update(ip).digest("hex");
  const key = `sendplug:local-auth:limit:${kind}:${ipHash}`;
  const first = await redis.set(key, "1", "EX", windowSeconds, "NX");
  if (first === "OK") return true;
  return (await redis.incr(key)) <= maximum;
}

export function createLocalAuthPlugin(dependencies: LocalAuthDependencies) {
  const ttl = dependencies.sessionTtlSeconds ?? SESSION_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1) throw new Error("sessionTtlSeconds must be a positive integer");

  async function createSession(identity: LocalAuthIdentity): Promise<{ token: string; cookie: string }> {
    const token = randomBytes(32).toString("base64url");
    const stored = await dependencies.redis.set(sessionKey(token, dependencies.sessionSecret), JSON.stringify(identity), "EX", ttl, "NX");
    if (stored !== "OK") throw new Error("Unable to create local authentication session");
    return { token, cookie: sessionCookie(token, dependencies.secureCookies, ttl) };
  }

  async function resolveLocalSession(request: Request): Promise<LocalAuthIdentity | null> {
    const token = readSessionCookie(request, dependencies.secureCookies);
    if (!token) return null;
    const serialized = await dependencies.redis.get(sessionKey(token, dependencies.sessionSecret));
    if (!serialized) return null;
    try {
      const identity: unknown = JSON.parse(serialized);
      return isIdentity(identity) ? identity : null;
    } catch {
      return null;
    }
  }

  return new Elysia({ name: "sendplug-local-auth", prefix: "/auth" })
    .get("/config", () => ({
      google: dependencies.googleEnabled,
      password: true as const,
      signups: dependencies.signupsEnabled,
    }))
    .post(
      "/register",
      async ({ body, request }) => {
        if (!dependencies.signupsEnabled) return error("New account signups are disabled", 403);
        if (!(await allowRequest(dependencies.redis, "register", dependencies.clientIp(request), 3, 3600))) {
          return error("Too many registration attempts; retry later", 429, { "retry-after": "3600" });
        }

        const email = body.email.trim().toLowerCase();
        const name = body.name?.trim() || email;
        const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id" });
        const identity = await dependencies.store.createLocalIdentity({ email, name, passwordHash });
        if (!identity) return error("Email is already registered", 409);

        const session = await createSession(identity);
        return Response.json(identity, { status: 201, headers: { "set-cookie": session.cookie } });
      },
      {
        body: t.Object({
          name: t.Optional(t.String({ maxLength: 200 })),
          email: t.String({ format: "email", maxLength: 254 }),
          password: t.String({ minLength: 12, maxLength: 1024 }),
        }),
      },
    )
    .post(
      "/login",
      async ({ body, request }) => {
        if (!(await allowRequest(dependencies.redis, "login", dependencies.clientIp(request), 5, 300))) {
          return error("Too many login attempts; retry in five minutes", 429, { "retry-after": "300" });
        }

        const email = body.email.trim().toLowerCase();
        const credential = await dependencies.store.findLocalCredential(email);
        const localValid = await Bun.password.verify(body.password, credential?.passwordHash ?? DUMMY_PASSWORD_HASH);
        let identity = localValid && credential ? credential.identity : null;
        if (!identity && dependencies.authenticateRecovery) {
          identity = await dependencies.authenticateRecovery(email, body.password);
        }
        if (!identity) return error("Invalid email or password", 401);

        const session = await createSession(identity);
        return Response.json(identity, { headers: { "set-cookie": session.cookie } });
      },
      {
        body: t.Object({
          email: t.String({ format: "email", maxLength: 254 }),
          password: t.String({ minLength: 1, maxLength: 1024 }),
        }),
      },
    )
    .get("/me", async ({ request }) => {
      const local = await resolveLocalSession(request);
      if (local) return local;
      const workos = await dependencies.resolveWorkOSSession?.(request);
      return workos ?? error("Not authenticated", 401);
    })
    .post("/logout", async ({ request }) => {
      const token = readSessionCookie(request, dependencies.secureCookies);
      if (token) await dependencies.redis.del(sessionKey(token, dependencies.sessionSecret));
      const headers = new Headers();
      headers.append("set-cookie", sessionCookie("", dependencies.secureCookies, ttl, true));
      headers.append("set-cookie", [
        `${dependencies.secureCookies ? "__Host-sendplug_session" : "sendplug_session"}=`,
        "Path=/", "HttpOnly", "SameSite=Lax",
        dependencies.secureCookies ? "Secure" : "", "Max-Age=0",
      ].filter(Boolean).join("; "));
      return new Response(null, { status: 204, headers });
    });
}
