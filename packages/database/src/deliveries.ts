import { randomUUID } from "node:crypto";
import { Prisma, type DeliveryStatus } from "./generated/prisma/client";
import type { Database } from "./index";

export class DeliveryConflictError extends Error {}
export class DeliveryNotFoundError extends Error {}

function normalizedRecipients(recipients: string[]): string[] {
  const result = [...new Set(recipients.map((email) => email.trim().toLowerCase()))];
  if (!result.length || result.some((email) => !/^\S+@\S+\.\S+$/.test(email))) {
    throw new Error("At least one valid recipient is required");
  }
  return result;
}

export type CreateDeliveryInput = {
  messageId?: string;
  senderId: string;
  recipients: string[];
  subject: string;
  details?: Prisma.InputJsonValue;
};

export async function createDelivery(database: Database, accountId: string, input: CreateDeliveryInput) {
  const messageId = input.messageId?.trim() || `message_${randomUUID().replaceAll("-", "")}`;
  const recipients = normalizedRecipients(input.recipients);
  if (!input.subject.trim()) throw new Error("Delivery subject is required");

  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery:${messageId}`}, 0))`;
    const existing = await tx.delivery.findUnique({ where: { messageId } });
    if (existing) {
      if (existing.accountId !== accountId || existing.senderId !== input.senderId) {
        throw new DeliveryConflictError("Message ID already belongs to another sender");
      }
      return existing;
    }

    const sender = await tx.sender.findFirst({
      where: { id: input.senderId, accountId, active: true },
      select: { id: true },
    });
    if (!sender) throw new DeliveryNotFoundError("Sender not found");
    return tx.delivery.create({
      data: {
        messageId,
        accountId,
        senderId: sender.id,
        recipients,
        subject: input.subject.trim(),
        ...(input.details === undefined ? {} : { details: input.details }),
      },
    });
  });
}

export function getAccountDelivery(database: Database, accountId: string, messageId: string, senderId?: string) {
  return database.delivery.findFirst({
    where: { messageId, accountId, ...(senderId ? { senderId } : {}) },
  });
}

export async function updateDeliveryStatus(
  database: Database,
  accountId: string,
  messageId: string,
  status: DeliveryStatus,
  input: { senderId?: string; error?: string | null; details?: Prisma.InputJsonValue } = {},
) {
  if (status === "FAILED" && !input.error?.trim()) throw new Error("Failed deliveries require an error");
  const existing = await database.delivery.findFirst({
    where: { messageId, accountId, ...(input.senderId ? { senderId: input.senderId } : {}) },
    select: { messageId: true },
  });
  if (!existing) throw new DeliveryNotFoundError("Delivery not found");

  return database.delivery.update({
    where: { messageId: existing.messageId },
    data: {
      status,
      ...(status === "SENT" ? { error: null } : input.error === undefined ? {} : { error: input.error }),
      ...(input.details === undefined ? {} : { details: input.details }),
    },
  });
}

export function markDeliveryFailed(
  database: Database,
  accountId: string,
  messageId: string,
  error: string,
  input: { senderId?: string; details?: Prisma.InputJsonValue } = {},
) {
  return updateDeliveryStatus(database, accountId, messageId, "FAILED", { ...input, error });
}
