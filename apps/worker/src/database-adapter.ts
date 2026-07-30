import { reserveQuota, type Database } from "@sendplug/database";
import type { WorkerStore } from "./processor";

export class PrismaWorkerStore implements WorkerStore {
  constructor(private readonly database: Database) {}

  async load(messageId: string) {
    const delivery = await this.database.delivery.findUnique({ where: { messageId } });
    if (!delivery) return { delivery: null, sender: null };
    const sender = await this.database.sender.findFirst({ where: { id: delivery.senderId, accountId: delivery.accountId } });
    return {
      delivery: {
        messageId: delivery.messageId,
        accountId: delivery.accountId,
        senderId: delivery.senderId,
        recipients: delivery.recipients,
        subject: delivery.subject,
        status: delivery.status.toLowerCase() as "queued" | "sending" | "sent" | "failed",
      },
      sender: sender && {
        id: sender.id,
        accountId: sender.accountId,
        name: sender.name,
        email: sender.email,
        encryptedAppPassword: sender.encryptedAppPassword
          ? `gcm:${Buffer.from(sender.encryptedAppPassword).toString("base64url")}`
          : sender.legacyEncryptedSecret,
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        useStartTls: sender.useTls,
        active: sender.active,
      },
    };
  }

  async startDelivery(messageId: string, _resumeInterrupted: boolean): Promise<"started" | "sent" | "busy"> {
    return this.database.$transaction(async (tx) => {
      const claimed = await tx.delivery.updateMany({
        where: { messageId, status: { in: ["QUEUED", "FAILED"] } },
        data: { status: "SENDING", error: null, details: { retryable: false } },
      });
      if (claimed.count === 1) return "started";
      const delivery = await tx.delivery.findUnique({ where: { messageId }, select: { status: true } });
      if (delivery?.status === "SENT") return "sent";
      // A previous worker may have reached Gmail before losing its DB update.
      // Never reclaim SENDING automatically: retrying could duplicate email.
      return "busy";
    });
  }

  async reserveQuota(senderId: string, messageId: string, recipientCount: number): Promise<void> {
    await reserveQuota(this.database, senderId, messageId, recipientCount);
  }

  async markSent(messageId: string): Promise<void> {
    await this.database.delivery.update({ where: { messageId }, data: { status: "SENT", error: null, details: { code: "sent" } } });
  }

  async markFailed(messageId: string, code: string, retryable: boolean): Promise<void> {
    await this.database.delivery.update({
      where: { messageId },
      data: { status: "FAILED", error: code, details: { code, retryable } },
    });
  }

  async ping(): Promise<void> { await this.database.$queryRawUnsafe("SELECT 1"); }
}
