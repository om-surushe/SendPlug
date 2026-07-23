import { Queue } from "bullmq";
import Redis from "ioredis";
import { EMAIL_QUEUE, type EmailJob } from "@sendplug/contracts";

export function createEmailQueue(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<EmailJob>(EMAIL_QUEUE, { connection });
  return {
    queue,
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
