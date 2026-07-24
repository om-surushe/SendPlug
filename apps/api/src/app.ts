import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Database } from "@sendplug/database";
import type Redis from "ioredis";
import { createAuthRoutes, type AuthDependencies } from "./auth";

export type AppDependencies = {
  database: Pick<Database, "$queryRawUnsafe">;
  redis: Pick<Redis, "ping">;
  nodeEnv: "development" | "test" | "production";
  auth?: AuthDependencies;
};

const checkSchema = t.Object({
  database: t.Union([t.Literal("up"), t.Literal("down")]),
  redis: t.Union([t.Literal("up"), t.Literal("down")]),
});

export function createApp(dependencies: AppDependencies) {
  const app = new Elysia({ name: "sendplug-api" });

  if (dependencies.auth) app.use(createAuthRoutes(dependencies.auth));

  if (dependencies.nodeEnv !== "production") {
    app.use(
      openapi({
        path: "/internal/docs",
        documentation: {
          info: {
            title: "SendPlug Bun API",
            version: "0.1.0",
            description: "Side-by-side replacement API. Not production traffic yet.",
          },
        },
      }),
    );
  }

  return app
    .get("/", () => ({ name: "SendPlug", runtime: "bun", framework: "elysia" } as const), {
      response: t.Object({ name: t.Literal("SendPlug"), runtime: t.Literal("bun"), framework: t.Literal("elysia") }),
      detail: { hide: true },
    })
    .get(
      "/health",
      async ({ set }) => {
        const [database, redis] = await Promise.all([
          dependencies.database.$queryRawUnsafe("SELECT 1").then(() => "up" as const).catch(() => "down" as const),
          dependencies.redis.ping().then(() => "up" as const).catch(() => "down" as const),
        ]);
        const healthy = database === "up" && redis === "up";
        if (!healthy) set.status = 503;
        return { status: healthy ? ("healthy" as const) : ("degraded" as const), checks: { database, redis } };
      },
      {
        response: {
          200: t.Object({ status: t.Literal("healthy"), checks: checkSchema }),
          503: t.Object({ status: t.Literal("degraded"), checks: checkSchema }),
        },
      },
    );
}
