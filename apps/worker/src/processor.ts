import { parseEmailJob, type NormalizedEmailJob } from "@sendplug/contracts";
import { decryptProviderToken } from "@sendplug/database";
import { decryptLegacyAppPassword } from "./fernet";
import { buildMime } from "./mime";
import { SmtpResponseError, type SmtpTransport } from "./smtp";

export type SenderRecord = {
  id: string;
  accountId: string;
  name: string;
  email: string;
  encryptedAppPassword: string | null;
  smtpHost: string;
  smtpPort: number;
  useStartTls: boolean;
  active: boolean;
};
export type DeliveryRecord = {
  messageId: string;
  accountId: string;
  senderId: string;
  recipients: string[];
  subject: string;
  status: "queued" | "sending" | "sent" | "failed";
};
export interface WorkerStore {
  load(messageId: string): Promise<{ sender: SenderRecord | null; delivery: DeliveryRecord | null }>;
  startDelivery(messageId: string, resumeInterrupted: boolean): Promise<"started" | "sent" | "busy">;
  reserveQuota(senderId: string, messageId: string, recipientCount: number): Promise<void>;
  markSent(messageId: string): Promise<void>;
  markFailed(messageId: string, code: string, retryable: boolean): Promise<void>;
}

export class PermanentDeliveryError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export class RetryableDeliveryError extends Error {
  constructor(public readonly code: string, options?: ErrorOptions) { super(code, options); }
}

function recipients(job: NormalizedEmailJob): string[] {
  return [...new Map([...job.to, ...(job.cc ?? []), ...(job.bcc ?? [])].map((address) => [address.toLowerCase(), address])).values()];
}

function sameRecipients(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].map((x) => x.toLowerCase()).sort().join("\0") === [...right].map((x) => x.toLowerCase()).sort().join("\0");
}

function failure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof PermanentDeliveryError) return { code: error.code, retryable: false };
  if (error instanceof SmtpResponseError) return { code: error.retryable ? "smtp_transient" : "smtp_rejected", retryable: error.retryable };
  if (error instanceof TypeError) return { code: "invalid_job", retryable: false };
  const name = error instanceof Error ? error.constructor.name : "";
  if (/DailyQuotaExceeded|SenderNotFound|MessageOwnership/.test(name)) return { code: name === "DailyQuotaExceededError" ? "quota_exceeded" : "invalid_sender", retryable: false };
  return { code: "temporary_failure", retryable: true };
}

export function createEmailProcessor(dependencies: {
  store: WorkerStore;
  smtp: SmtpTransport;
  credentialKey: string;
}) {
  return async (raw: unknown, attemptsMade = 0): Promise<{ status: "sent" | "already-sent" }> => {
    let job: NormalizedEmailJob;
    try { job = parseEmailJob(raw); }
    catch { throw new PermanentDeliveryError("invalid_job"); }
    const envelopeRecipients = recipients(job);
    const loaded = await dependencies.store.load(job.messageId);
    if (loaded.delivery?.status === "sent") return { status: "already-sent" };
    if (!loaded.delivery) throw new PermanentDeliveryError("delivery_missing");

    const started = await dependencies.store.startDelivery(job.messageId, attemptsMade > 0);
    if (started === "sent") return { status: "already-sent" };
    if (started === "busy") throw new RetryableDeliveryError("delivery_busy");

    let smtpAccepted = false;
    try {
      const { delivery, sender } = loaded;
      if (!sender) throw new PermanentDeliveryError("invalid_sender");
      if (!sender.active || sender.id !== job.senderId || sender.accountId !== job.accountId ||
          delivery.senderId !== job.senderId || delivery.accountId !== job.accountId ||
          delivery.subject !== job.subject || !sameRecipients(delivery.recipients, envelopeRecipients)) {
        throw new PermanentDeliveryError("delivery_mismatch");
      }
      if (sender.smtpHost !== "smtp.gmail.com" || sender.smtpPort !== 587 || !sender.useStartTls) {
        throw new PermanentDeliveryError("gmail_starttls_required");
      }
      if (!sender.encryptedAppPassword) throw new PermanentDeliveryError("credential_missing");

      await dependencies.store.reserveQuota(sender.id, job.messageId, envelopeRecipients.length);
      let password: string;
      try {
        password = sender.encryptedAppPassword.startsWith("gcm:")
          ? decryptProviderToken(
              Buffer.from(sender.encryptedAppPassword.slice(4), "base64url"),
              Buffer.from(dependencies.credentialKey, "base64url"),
              `sender:${sender.id}:app-password`,
            )
          : decryptLegacyAppPassword(sender.encryptedAppPassword, dependencies.credentialKey);
      }
      catch { throw new PermanentDeliveryError("credential_invalid"); }
      await dependencies.smtp.send({
        host: "smtp.gmail.com",
        port: 587,
        username: sender.email,
        password,
        from: sender.email,
        recipients: envelopeRecipients,
        mime: buildMime(job, sender),
      });
      smtpAccepted = true;
      await dependencies.store.markSent(job.messageId);
      return { status: "sent" };
    } catch (error) {
      // Gmail may already have accepted the message even if the following DB
      // update failed. Prefer an explicit ambiguous failure over a duplicate.
      const classified = smtpAccepted
        ? { code: "smtp_accepted_status_unknown", retryable: false }
        : failure(error);
      await dependencies.store.markFailed(job.messageId, classified.code, classified.retryable);
      if (classified.retryable) throw new RetryableDeliveryError(classified.code, { cause: error });
      throw new PermanentDeliveryError(classified.code);
    }
  };
}
