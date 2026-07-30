import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createLocalAuthPlugin,
  type LocalAuthDependencies,
  type LocalAuthIdentity,
  type LocalAuthRedis,
  type LocalAuthStore,
} from "../src/local-auth";

const localIdentity: LocalAuthIdentity = {
  accountId: "account_local",
  user: { id: "user_local", email: "owner@example.com", name: "Owner" },
  role: "owner",
};
const recoveryIdentity: LocalAuthIdentity = {
  accountId: "account_legacy_admin",
  user: { id: "user_legacy_admin", email: "admin@example.com", name: "Administrator" },
  role: "owner",
  recovery: true,
};
const workosIdentity: LocalAuthIdentity = {
  accountId: "account_workos",
  user: { id: "user_workos", email: "workos@example.com", name: "WorkOS User" },
};

class FakeRedis implements LocalAuthRedis {
  values = new Map<string, string>();

  async set(key: string, value: string, _mode: "EX", _seconds: number, condition?: "NX") {
    if (condition === "NX" && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    return Number(this.values.delete(key));
  }

  async incr(key: string) {
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    return next;
  }
}

class FakeStore implements LocalAuthStore {
  credentials = new Map<string, { identity: LocalAuthIdentity; passwordHash: string }>();
  creates: Array<{ email: string; name: string; passwordHash: string }> = [];

  async findLocalCredential(email: string) {
    return this.credentials.get(email) ?? null;
  }

  async createLocalIdentity(input: { email: string; name: string; passwordHash: string }) {
    this.creates.push(input);
    if (this.credentials.has(input.email)) return null;
    const identity = {
      ...localIdentity,
      user: { ...localIdentity.user, email: input.email, name: input.name },
    };
    this.credentials.set(input.email, { identity, passwordHash: input.passwordHash });
    return identity;
  }
}

function setup(overrides: Partial<LocalAuthDependencies> = {}) {
  const redis = new FakeRedis();
  const store = new FakeStore();
  const dependencies: LocalAuthDependencies = {
    store,
    redis,
    signupsEnabled: true,
    googleEnabled: false,
    secureCookies: true,
    clientIp: (request) => request.headers.get("x-test-ip") ?? "127.0.0.1",
    ...overrides,
  };
  return { app: new Elysia().use(createLocalAuthPlugin(dependencies)), redis, store, dependencies };
}

function post(path: string, body: unknown, ip = "127.0.0.1") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-ip": ip },
    body: JSON.stringify(body),
  });
}

function cookiePair(response: Response): string {
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

describe("local authentication config and registration", () => {
  test("reports password, OAuth, and signup availability", async () => {
    const { app } = setup({ googleEnabled: true, signupsEnabled: false });
    const response = await app.handle(new Request("http://localhost/auth/config"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ google: true, password: true, signups: false });
  });

  test("registers a normalized identity and creates a secure server-side session", async () => {
    const { app, store, redis } = setup();
    const response = await app.handle(post("/auth/register", {
      name: "  Example Owner  ",
      email: "OWNER@Example.com",
      password: "correct horse battery staple",
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ...localIdentity,
      user: { ...localIdentity.user, email: "owner@example.com", name: "Example Owner" },
    });
    expect(store.creates[0]?.email).toBe("owner@example.com");
    expect(store.creates[0]?.name).toBe("Example Owner");
    expect(await Bun.password.verify("correct horse battery staple", store.creates[0]!.passwordHash)).toBe(true);
    expect(response.headers.get("set-cookie")).toContain("__Host-sendplug_local_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect([...redis.values.keys()].some((key) => key.includes(":session:"))).toBe(true);
  });

  test("rejects short passwords before touching the store", async () => {
    const { app, store } = setup();
    const response = await app.handle(post("/auth/register", {
      email: "owner@example.com",
      password: "too-short",
    }));
    expect(response.status).toBe(422);
    expect(store.creates).toHaveLength(0);
  });

  test("enforces the signup gate", async () => {
    const { app, store } = setup({ signupsEnabled: false });
    const response = await app.handle(post("/auth/register", {
      email: "owner@example.com",
      password: "long-enough-password",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "New account signups are disabled" });
    expect(store.creates).toHaveLength(0);
  });

  test("limits registration to three attempts per IP per hour", async () => {
    const { app } = setup();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await app.handle(post("/auth/register", {
        email: `owner${attempt}@example.com`,
        password: "long-enough-password",
      }, "203.0.113.1"));
      expect(response.status).toBe(201);
    }
    const limited = await app.handle(post("/auth/register", {
      email: "owner4@example.com",
      password: "long-enough-password",
    }, "203.0.113.1"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
  });
});

describe("local authentication login and sessions", () => {
  test("logs in a local credential with a generic cookie session", async () => {
    const { app, store } = setup();
    store.credentials.set("owner@example.com", {
      identity: localIdentity,
      passwordHash: await Bun.password.hash("correct horse battery staple", { algorithm: "argon2id" }),
    });
    const response = await app.handle(post("/auth/login", {
      email: "OWNER@example.com",
      password: "correct horse battery staple",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(localIdentity);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("falls back to the injected recovery administrator", async () => {
    let received: [string, string] | undefined;
    const { app } = setup({
      authenticateRecovery: async (email, password) => {
        received = [email, password];
        return email === "admin@example.com" && password === "recovery-password" ? recoveryIdentity : null;
      },
    });
    const response = await app.handle(post("/auth/login", {
      email: "ADMIN@example.com",
      password: "recovery-password",
    }));
    expect(response.status).toBe(200);
    expect(received).toEqual(["admin@example.com", "recovery-password"]);
    expect(await response.json()).toEqual(recoveryIdentity);
  });

  test("uses a generic error for unknown users and bad passwords", async () => {
    const { app } = setup({ authenticateRecovery: async () => null });
    const response = await app.handle(post("/auth/login", {
      email: "unknown@example.com",
      password: "not-the-password",
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid email or password" });
  });

  test("limits login to five attempts per IP per five minutes", async () => {
    const { app } = setup();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await app.handle(post("/auth/login", {
        email: "unknown@example.com",
        password: "not-the-password",
      }, "203.0.113.2"));
      expect(response.status).toBe(401);
    }
    const limited = await app.handle(post("/auth/login", {
      email: "unknown@example.com",
      password: "not-the-password",
    }, "203.0.113.2"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("300");
  });

  test("resolves the local Redis session before optional WorkOS", async () => {
    let workosCalls = 0;
    const { app, store } = setup({
      resolveWorkOSSession: async () => {
        workosCalls += 1;
        return workosIdentity;
      },
    });
    store.credentials.set("owner@example.com", {
      identity: localIdentity,
      passwordHash: await Bun.password.hash("correct horse battery staple", { algorithm: "argon2id" }),
    });
    const login = await app.handle(post("/auth/login", {
      email: "owner@example.com",
      password: "correct horse battery staple",
    }));
    const response = await app.handle(new Request("http://localhost/auth/me", {
      headers: { cookie: cookiePair(login) },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(localIdentity);
    expect(workosCalls).toBe(0);
  });

  test("falls back to optional WorkOS and otherwise requires authentication", async () => {
    const withWorkOS = setup({ resolveWorkOSSession: async () => workosIdentity }).app;
    const workos = await withWorkOS.handle(new Request("http://localhost/auth/me"));
    expect(workos.status).toBe(200);
    expect(await workos.json()).toEqual(workosIdentity);

    const anonymous = await setup().app.handle(new Request("http://localhost/auth/me"));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Not authenticated" });
  });

  test("deletes the Redis session and clears the cookie on logout", async () => {
    const { app, store, redis } = setup();
    store.credentials.set("owner@example.com", {
      identity: localIdentity,
      passwordHash: await Bun.password.hash("correct horse battery staple", { algorithm: "argon2id" }),
    });
    const login = await app.handle(post("/auth/login", {
      email: "owner@example.com",
      password: "correct horse battery staple",
    }));
    const cookie = cookiePair(login);
    const sessionKey = [...redis.values.keys()].find((key) => key.includes(":session:"))!;

    const logout = await app.handle(new Request("http://localhost/auth/logout", {
      method: "POST",
      headers: { cookie },
    }));
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("set-cookie")).toContain("sendplug_session=");
    expect(redis.values.has(sessionKey)).toBe(false);
    const me = await app.handle(new Request("http://localhost/auth/me", { headers: { cookie } }));
    expect(me.status).toBe(401);
  });
});
