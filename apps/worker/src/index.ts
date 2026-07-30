import { readFile } from "node:fs/promises";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import Redis from "ioredis";
import { EMAIL_QUEUE, parseEmailJob, type EmailJob, type NormalizedEmailJob } from "@sendplug/contracts";
import { createDatabase } from "@sendplug/database";
import { PrismaWorkerStore } from "./database-adapter";
import { PermanentDeliveryError, RetryableDeliveryError, createEmailProcessor } from "./processor";
import { GmailSmtpTransport } from "./smtp";

export const WORKER_HEARTBEAT_KEY = "sendplug:worker:heartbeat";

export function createEmailQueue(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<EmailJob>(EMAIL_QUEUE, { connection });
  return {
    queue,
    async close() { await queue.close(); connection.disconnect(); },
  };
}

export async function enqueueEmail(queue: Pick<Queue<EmailJob>, "add">, value: unknown) {
  const job = parseEmailJob(value);
  return queue.add("send-email", job, {
    jobId: job.messageId,
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  });
}

export function startHeartbeat(dependencies: {
  checkDatabase: () => Promise<void>;
  redis: Pick<Redis, "ping" | "set">;
  intervalMs?: number;
}) {
  const intervalMs = dependencies.intervalMs ?? 15_000;
  const beat = async () => {
    const checks = { database: "up", redis: "up" } as { database: "up" | "down"; redis: "up" | "down" };
    await dependencies.checkDatabase().catch(() => { checks.database = "down"; });
    await dependencies.redis.ping().catch(() => { checks.redis = "down"; });
    const heartbeat = { status: checks.database === "up" && checks.redis === "up" ? "healthy" : "degraded", checks, timestamp: new Date().toISOString() };
    if (checks.redis === "up") {
      await dependencies.redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat), "PX", intervalMs * 3).catch(() => {
        checks.redis = "down"; heartbeat.status = "degraded";
      });
    }
    return heartbeat;
  };
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}

export async function runWorker(source: NodeJS.ProcessEnv = Bun.env) {
  const databaseUrl = source.DATABASE_URL?.trim();
  const redisUrl = source.REDIS_URL?.trim();
  if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required");
  const keyPath = source.CREDENTIAL_KEY_FILE?.trim() || "/run/secrets/credential_key";
  const credentialKey = (await readFile(keyPath, "utf8")).trim();
  if (!credentialKey) throw new Error("Credential key is empty");

  const database = createDatabase(databaseUrl);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const store = new PrismaWorkerStore(database);
  const processEmail = createEmailProcessor({ store, smtp: new GmailSmtpTransport(), credentialKey });
  const concurrency = Number(source.WORKER_CONCURRENCY || 5);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("WORKER_CONCURRENCY must be a positive integer");
  const worker = new Worker<NormalizedEmailJob>(EMAIL_QUEUE, async (job) => {
    try { return await processEmail(job.data, job.attemptsMade); }
    catch (error) {
      if (error instanceof PermanentDeliveryError) throw new UnrecoverableError(error.code);
      throw error;
    }
  }, { connection: redis, concurrency });
  worker.on("failed", (job, error) => console.error(JSON.stringify({
    event: "delivery_failed",
    messageId: job?.data.messageId,
    code: error instanceof PermanentDeliveryError || error instanceof RetryableDeliveryError ? error.code : "delivery_failed",
  })));
  worker.on("error", () => console.error(JSON.stringify({ event: "worker_error" })));
  const heartbeat = startHeartbeat({ checkDatabase: () => store.ping(), redis });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    heartbeat.stop();
    await worker.close();
    redis.disconnect();
    await database.$disconnect();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  return { worker, heartbeat, close };
}

if (import.meta.main) await runWorker();
