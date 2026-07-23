import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadEnvironment } from "../src/env";

const healthyDatabase = { $queryRawUnsafe: async () => [{ ok: 1 }] };
const healthyRedis = { ping: async () => "PONG" };

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
    });
  });
});
