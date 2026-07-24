import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadEnvironment } from "../src/env";

const healthyDatabase = { $queryRawUnsafe: async () => [{ ok: 1 }] };
const healthyRedis = { ping: async () => "PONG" };

function authDependencies() {
  const states = new Map<string, string>();
  let authenticateCalls = 0;
  const transaction = async (callback: (tx: unknown) => unknown) =>
    callback({
      user: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => data,
      },
      account: {
        create: async ({ data }: { data: Record<string, unknown> }) => data,
      },
      membership: { create: async () => ({}) },
    });
  return {
    dependencies: {
      client: {
        getAuthorizationUrlWithPKCE: async () => ({
          url: "https://auth.example.com/authorize",
          state: "workos-state",
          codeVerifier: "workos-verifier",
        }),
        authenticateWithCode: async () => {
          authenticateCalls += 1;
          return {
            user: { id: "workos-user", email: "founder@example.com", firstName: "Founder" },
            sealedSession: "sealed-session",
          };
        },
        loadSealedSession: () => ({
          authenticate: async () => ({
            authenticated: true as const,
            user: { id: "workos-user", email: "founder@example.com", firstName: "Founder" },
          }),
        }),
      },
      database: { $transaction: transaction } as never,
      state: {
        async put(state: string, verifier: string) { states.set(state, verifier); },
        async take(state: string) {
          const verifier = states.get(state) ?? null;
          states.delete(state);
          return verifier;
        },
      },
      clientId: "client_test",
      cookiePassword: "a".repeat(32),
      redirectUri: "https://app.example.com/workos/callback",
      secureCookies: true,
    },
    states,
    authenticateCalls: () => authenticateCalls,
  };
}

describe("health", () => {
  test("reports PostgreSQL and Redis readiness", async () => {
    const app = createApp({ database: healthyDatabase as never, redis: healthyRedis as never, nodeEnv: "test" });
    const response = await app.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "healthy",
      checks: { database: "up", redis: "up" },
    });
  });

  test("fails readiness when PostgreSQL is unavailable", async () => {
    const database = { $queryRawUnsafe: async () => { throw new Error("offline"); } };
    const app = createApp({ database: database as never, redis: healthyRedis as never, nodeEnv: "test" });
    const response = await app.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "degraded",
      checks: { database: "down", redis: "up" },
    });
  });

  test("does not expose internal documentation in production", async () => {
    const app = createApp({ database: healthyDatabase as never, redis: healthyRedis as never, nodeEnv: "production" });
    expect((await app.handle(new Request("http://localhost/internal/docs"))).status).toBe(404);
  });
});

describe("WorkOS authentication", () => {
  test("stores one-time PKCE state before redirecting", async () => {
    const auth = authDependencies();
    const app = createApp({
      database: healthyDatabase as never,
      redis: healthyRedis as never,
      nodeEnv: "test",
      auth: auth.dependencies,
    });
    const response = await app.handle(new Request("http://localhost/workos/login"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://auth.example.com/authorize");
    expect(auth.states.get("workos-state")).toBe("workos-verifier");
  });

  test("rejects replayed callback state", async () => {
    const auth = authDependencies();
    const app = createApp({
      database: healthyDatabase as never,
      redis: healthyRedis as never,
      nodeEnv: "test",
      auth: auth.dependencies,
    });
    const request = () => new Request("http://localhost/workos/callback?code=code&state=missing");
    expect((await app.handle(request())).status).toBe(400);
    expect(auth.authenticateCalls()).toBe(0);
  });

  test("rejects requests without a sealed session", async () => {
    const auth = authDependencies();
    const app = createApp({
      database: healthyDatabase as never,
      redis: healthyRedis as never,
      nodeEnv: "test",
      auth: { ...auth.dependencies, secureCookies: false },
    });
    expect((await app.handle(new Request("http://localhost/workos/me"))).status).toBe(401);
  });

  test("clears the sealed session on logout", async () => {
    const auth = authDependencies();
    const app = createApp({
      database: healthyDatabase as never,
      redis: healthyRedis as never,
      nodeEnv: "production",
      auth: auth.dependencies,
    });
    const response = await app.handle(new Request("http://localhost/workos/logout", { method: "POST" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("creates a secure sealed-session cookie", async () => {
    const auth = authDependencies();
    auth.states.set("workos-state", "workos-verifier");
    const app = createApp({
      database: healthyDatabase as never,
      redis: healthyRedis as never,
      nodeEnv: "production",
      auth: auth.dependencies,
    });
    const response = await app.handle(
      new Request("http://localhost/workos/callback?code=code&state=workos-state"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("__Host-sendplug_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(auth.authenticateCalls()).toBe(1);
    expect(auth.states.has("workos-state")).toBe(false);
  });
});

describe("environment", () => {
  test("requires database and Redis URLs", () => {
    expect(() => loadEnvironment({ NODE_ENV: "test" })).toThrow("DATABASE_URL is required");
  });

  test("parses a complete environment", () => {
    expect(loadEnvironment({
      NODE_ENV: "test",
      API_PORT: "3100",
      DATABASE_URL: "postgresql://localhost/sendplug",
      REDIS_URL: "redis://localhost:6379/0",
    })).toEqual({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3100,
      databaseUrl: "postgresql://localhost/sendplug",
      redisUrl: "redis://localhost:6379/0",
      workos: null,
    });
  });

  test("rejects incomplete WorkOS configuration", () => {
    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/sendplug",
      REDIS_URL: "redis://localhost:6379/0",
      WORKOS_CLIENT_ID: "client_test",
    })).toThrow("WORKOS_REDIRECT_URI is required");
  });

  test("parses complete WorkOS configuration", () => {
    expect(loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/sendplug",
      REDIS_URL: "redis://localhost:6379/0",
      WORKOS_CLIENT_ID: "client_test",
      WORKOS_API_KEY: "test-key",
      WORKOS_COOKIE_PASSWORD: "a".repeat(32),
      WORKOS_REDIRECT_URI: "https://app.example.com/workos/callback",
    }).workos).toEqual({
      clientId: "client_test",
      apiKey: "test-key",
      cookiePassword: "a".repeat(32),
      redirectUri: "https://app.example.com/workos/callback",
    });
  });
});
