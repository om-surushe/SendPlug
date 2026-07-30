import { Prisma } from "./generated/prisma/client";
import type { Database } from "./index";

export class SenderNotFoundError extends Error {}
export class MessageOwnershipError extends Error {}
export class DailyQuotaExceededError extends Error {
  constructor(public readonly usage: number, public readonly limit: number) {
    super(`Daily Gmail safety limit reached (${usage}/${limit})`);
  }
}

function utcDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function usage(tx: Prisma.TransactionClient, senderId: string, quotaDate: Date): Promise<number> {
  const result = await tx.quotaReservation.aggregate({
    where: { senderId, quotaDate },
    _sum: { recipientCount: true },
  });
  return result._sum.recipientCount ?? 0;
}

export async function reserveQuota(
  database: Database,
  senderId: string,
  messageId: string,
  recipientCount: number,
  now = new Date(),
): Promise<number> {
  if (!Number.isInteger(recipientCount) || recipientCount < 1) {
    throw new RangeError("recipientCount must be a positive integer");
  }
  const quotaDate = utcDate(now);

  return database.$transaction(async (tx) => {
    // Locks make the read/sum/insert sequence atomic across Bun API and worker processes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`message:${messageId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sender:${senderId}`}, 0))`;

    const existing = await tx.quotaReservation.findUnique({ where: { messageId } });
    if (existing) {
      if (existing.senderId !== senderId) throw new MessageOwnershipError("Message ID already belongs to another sender");
      return usage(tx, senderId, quotaDate);
    }

    const sender = await tx.sender.findFirst({
      where: { id: senderId, active: true },
      select: { dailyLimit: true },
    });
    if (!sender) throw new SenderNotFoundError("Sender not found");

    const currentUsage = await usage(tx, senderId, quotaDate);
    if (currentUsage + recipientCount > sender.dailyLimit) {
      throw new DailyQuotaExceededError(currentUsage, sender.dailyLimit);
    }

    await tx.quotaReservation.create({
      data: { messageId, senderId, recipientCount, quotaDate, createdAt: now },
    });
    return currentUsage + recipientCount;
  });
}
