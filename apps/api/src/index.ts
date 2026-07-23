import Redis from "ioredis";
import { createDatabase } from "@sendplug/database";
import { createApp } from "./app";
import { loadEnvironment } from "./env";

const env = loadEnvironment();
const database = createDatabase(env.databaseUrl);
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1 });
const app = createApp({ database, redis, nodeEnv: env.nodeEnv });

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
