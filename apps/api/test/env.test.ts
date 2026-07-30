import { describe, expect, test } from "bun:test";
import { loadEnvironment } from "../src/env";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://sendplug:secret@postgres/sendplug",
  REDIS_URL: "redis://redis:6379/0",
  PUBLIC_ORIGIN: "https://sendplug.example",
  SESSION_SECRET: "s".repeat(32),
  RECOVERY_ADMIN_EMAIL: "admin@example.com",
  RECOVERY_ADMIN_PASSWORD: "a-strong-recovery-password",
};

describe("MVP environment", () => {
  test("loads production controls and defaults", () => {
    const env = loadEnvironment(base);
    expect(env.signupsEnabled).toBe(true);
    expect(env.sendBurstLimit).toBe(10);
    expect(env.publicOrigin).toBe("https://sendplug.example");
    expect(env.workos).toBeNull();
  });

  test("rejects insecure origins, placeholders, and partial WorkOS config", () => {
    expect(() => loadEnvironment({ ...base, PUBLIC_ORIGIN: "http://sendplug.example" })).toThrow();
    expect(() => loadEnvironment({ ...base, RECOVERY_ADMIN_PASSWORD: "changeme" })).toThrow();
    expect(() => loadEnvironment({ ...base, WORKOS_API_KEY: "key" })).toThrow();
  });

  test("keeps the unfinished WorkOS flow disabled in production", () => {
    expect(() => loadEnvironment({
      ...base,
      WORKOS_API_KEY: "key",
      WORKOS_CLIENT_ID: "client",
      WORKOS_COOKIE_PASSWORD: "c".repeat(32),
      WORKOS_REDIRECT_URI: "https://sendplug.example/workos/callback",
    })).toThrow("WorkOS login is disabled in production");
  });

  test("validates booleans and positive limits", () => {
    expect(() => loadEnvironment({ ...base, AUTH_SIGNUPS_ENABLED: "yes" })).toThrow();
    expect(() => loadEnvironment({ ...base, SEND_BURST_LIMIT: "0" })).toThrow();
  });
});
