import Redis from "ioredis";
import { WORKER_HEARTBEAT_KEY } from "./index";

const redisUrl = Bun.env.REDIS_URL?.trim();
if (!redisUrl) throw new Error("REDIS_URL is required");
const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
try {
  await redis.connect();
  const raw = await redis.get(WORKER_HEARTBEAT_KEY);
  const heartbeat: { status?: string } | null = raw ? JSON.parse(raw) : null;
  if (heartbeat?.status !== "healthy") process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
