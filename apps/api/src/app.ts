import { openapi } from "@elysiajs/openapi";
import { Elysia, t } from "elysia";
import type { Database } from "@sendplug/database";
import type Redis from "ioredis";
import { createAccountApi, type AccountApiDependencies } from "./account-api";
import { createAuthRoutes, type AuthDependencies } from "./auth";
import { createDeliveryRoutes, type DeliveryRouteDependencies } from "./delivery";
import { createLocalAuthPlugin, type LocalAuthDependencies } from "./local-auth";
import { createStaticPlugin } from "./static";

export type AppDependencies = {
  database: Pick<Database, "$queryRawUnsafe">;
  redis: Pick<Redis, "ping">;
  nodeEnv: "development" | "test" | "production";
  auth?: AuthDependencies;
  localAuth?: LocalAuthDependencies;
  accountApi?: AccountApiDependencies;
  delivery?: DeliveryRouteDependencies;
  staticDir?: string;
};

const checkSchema = t.Object({
  database: t.Union([t.Literal("up"), t.Literal("down")]),
  redis: t.Union([t.Literal("up"), t.Literal("down")]),
});

export function createApp(dependencies: AppDependencies) {
  const app = new Elysia({ name: "sendplug-api" });

  if (dependencies.auth) app.use(createAuthRoutes(dependencies.auth));
  if (dependencies.localAuth) app.use(createLocalAuthPlugin(dependencies.localAuth));
  if (dependencies.accountApi) app.use(createAccountApi(dependencies.accountApi));
  if (dependencies.delivery) app.use(createDeliveryRoutes(dependencies.delivery));

  if (dependencies.nodeEnv !== "production") {
    app.use(openapi({
      path: "/internal/docs",
      documentation: { info: { title: "SendPlug Bun API", version: "0.1.0", description: "Bun/Elysia MVP API." } },
    }));
  }

  app.get(
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
    { response: {
      200: t.Object({ status: t.Literal("healthy"), checks: checkSchema }),
      503: t.Object({ status: t.Literal("degraded"), checks: checkSchema }),
    } },
  );

  if (dependencies.staticDir) app.use(createStaticPlugin(dependencies.staticDir));
  else app.get("/", () => ({ name: "SendPlug", runtime: "bun", framework: "elysia" } as const), { detail: { hide: true } });
  return app;
}
