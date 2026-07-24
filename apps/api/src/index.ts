import Redis from "ioredis";
import { WorkOS } from "@workos-inc/node";
import { createDatabase } from "@sendplug/database";
import { createApp } from "./app";
import { loadEnvironment } from "./env";

const env = loadEnvironment();
const database = createDatabase(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1 });
const auth = env.workos
  ? {
      client: new WorkOS({ apiKey: env.workos.apiKey, clientId: env.workos.clientId }).userManagement,
      database,
      state: {
        async put(state: string, verifier: string) {
          const stored = await redis.set(`sendplug:workos:${state}`, verifier, "EX", 600, "NX");
          if (stored !== "OK") throw new Error("Unable to store WorkOS login state");
        },
        take(state: string) {
          return redis.getdel(`sendplug:workos:${state}`);
        },
      },
      clientId: env.workos.clientId,
      cookiePassword: env.workos.cookiePassword,
      redirectUri: env.workos.redirectUri,
      secureCookies: env.nodeEnv === "production",
    }
  : undefined;
const app = createApp({ database, redis, nodeEnv: env.nodeEnv, ...(auth ? { auth } : {}) });

app.listen({ hostname: env.host, port: env.port });
console.log(`SendPlug Bun API listening on http://${env.host}:${env.port}`);

async function shutdown() {
  await app.stop();
  await database.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
