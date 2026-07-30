import { describe, expect, test } from "bun:test";
import { EMAIL_JOB_VERSION } from "@sendplug/contracts";
import { enqueueEmail, startHeartbeat, WORKER_HEARTBEAT_KEY } from "../src";
import { PermanentDeliveryError, RetryableDeliveryError, createEmailProcessor, type DeliveryRecord, type SenderRecord, type WorkerStore } from "../src/processor";
import { SmtpResponseError, type SmtpRequest, type SmtpTransport } from "../src/smtp";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const encrypted = "gAAAAABlU_EAbhuoaE7J8yFq8yPtu8dMwtm5oBhjNAvt-YQ2Yymqqg7An2upO99p33nxYzNLUawUDEw3QVypmvj3FzIyrSn0OE7lwcOtJfmXwc1EZX818Vk=";
const job = {
  version: EMAIL_JOB_VERSION,
  messageId: "message-1", accountId: "account-1", senderId: "sender-1",
  to: ["to@example.com"], cc: ["cc@example.com"], bcc: ["hidden@example.com"],
  subject: "Hello", body: "plain", html: "<b>html</b>",
};
const sender: SenderRecord = {
  id: job.senderId, accountId: job.accountId, name: "Sender", email: "sender@gmail.com",
  encryptedAppPassword: encrypted, smtpHost: "smtp.gmail.com", smtpPort: 587, useStartTls: true, active: true,
};

class FakeStore implements WorkerStore {
  delivery: DeliveryRecord = { messageId: job.messageId, accountId: job.accountId, senderId: job.senderId, recipients: [...job.to, ...job.cc, ...job.bcc], subject: job.subject, status: "queued" };
  quota = 0;
  failure?: { code: string; retryable: boolean };
  async load() { return { sender, delivery: this.delivery }; }
  async startDelivery() {
    if (this.delivery.status === "sent") return "sent" as const;
    if (this.delivery.status === "sending") return "busy" as const;
    this.delivery.status = "sending"; return "started" as const;
  }
  async reserveQuota(_sender: string, _message: string, count: number) { this.quota = count; }
  async markSent() { this.delivery.status = "sent"; }
  async markFailed(_id: string, code: string, retryable: boolean) { this.delivery.status = "failed"; this.failure = { code, retryable }; }
}
class FakeSmtp implements SmtpTransport {
  request?: SmtpRequest;
  error?: Error;
  async send(request: SmtpRequest) { this.request = request; if (this.error) throw this.error; }
}

describe("email worker", () => {
  test("reserves quota, decrypts only at SMTP boundary, and sends MIME without a Bcc header", async () => {
    const store = new FakeStore(); const smtp = new FakeSmtp();
    expect(await createEmailProcessor({ store, smtp, credentialKey: key })(job)).toEqual({ status: "sent" });
    expect(store.quota).toBe(3);
    expect(smtp.request?.password).toBe("app password 1234");
    expect(smtp.request?.host).toBe("smtp.gmail.com");
    expect(smtp.request?.port).toBe(587);
    expect(smtp.request?.recipients).toEqual(["to@example.com", "cc@example.com", "hidden@example.com"]);
    expect(smtp.request?.mime).toContain("multipart/alternative");
    expect(smtp.request?.mime).not.toContain("Bcc:");
    expect(store.delivery.status).toBe("sent");
  });

  test("classifies SMTP 4xx for retry and 5xx as permanent", async () => {
    for (const [code, retryable] of [[421, true], [535, false]] as const) {
      const store = new FakeStore(); const smtp = new FakeSmtp(); smtp.error = new SmtpResponseError(code);
      const processing = createEmailProcessor({ store, smtp, credentialKey: key })(job);
      await expect(processing).rejects.toBeInstanceOf(retryable ? RetryableDeliveryError : PermanentDeliveryError);
      expect(store.failure).toEqual({ code: retryable ? "smtp_transient" : "smtp_rejected", retryable });
    }
  });

  test("rejects non-Gmail SMTP configuration before credentials leave the worker", async () => {
    const store = new FakeStore(); const smtp = new FakeSmtp();
    store.load = async () => ({ delivery: store.delivery, sender: { ...sender, smtpHost: "example.com" } });
    await expect(createEmailProcessor({ store, smtp, credentialKey: key })(job)).rejects.toBeInstanceOf(PermanentDeliveryError);
    expect(smtp.request).toBeUndefined();
    expect(store.failure?.code).toBe("gmail_starttls_required");
  });

  test("does not resend sent or ambiguous in-progress deliveries", async () => {
    const sentStore = new FakeStore(); const sentSmtp = new FakeSmtp(); sentStore.delivery.status = "sent";
    expect(await createEmailProcessor({ store: sentStore, smtp: sentSmtp, credentialKey: key })(job)).toEqual({ status: "already-sent" });
    expect(sentSmtp.request).toBeUndefined();

    const sendingStore = new FakeStore(); const sendingSmtp = new FakeSmtp(); sendingStore.delivery.status = "sending";
    await expect(createEmailProcessor({ store: sendingStore, smtp: sendingSmtp, credentialKey: key })(job, 1)).rejects.toBeInstanceOf(RetryableDeliveryError);
    expect(sendingSmtp.request).toBeUndefined();
  });

  test("does not retry when Gmail accepted but the durable sent update failed", async () => {
    const store = new FakeStore();
    store.markSent = async () => { throw new Error("database unavailable"); };
    const smtp = new FakeSmtp();
    await expect(createEmailProcessor({ store, smtp, credentialKey: key })(job)).rejects.toBeInstanceOf(PermanentDeliveryError);
    expect(smtp.request).toBeDefined();
    expect(store.failure).toEqual({ code: "smtp_accepted_status_unknown", retryable: false });
  });

  test("enqueues normalized jobs with messageId as BullMQ jobId", async () => {
    let captured: unknown[] = [];
    const queue = { add: async (...args: unknown[]) => { captured = args; return {}; } };
    const { version: _version, ...legacy } = job;
    await enqueueEmail(queue as never, legacy);
    expect(captured[1]).toMatchObject({ version: 1, messageId: job.messageId });
    expect(captured[2]).toMatchObject({ jobId: job.messageId });
  });

  test("heartbeat reports dependency state without secrets", async () => {
    let value = ""; let keyName = "";
    const heartbeat = startHeartbeat({
      intervalMs: 60_000,
      checkDatabase: async () => { throw new Error("password=secret"); },
      redis: { ping: async () => "PONG", set: async (key: string, data: string) => { keyName = key; value = data; return "OK"; } } as never,
    });
    expect((await heartbeat.beat()).status).toBe("degraded"); heartbeat.stop();
    expect(keyName).toBe(WORKER_HEARTBEAT_KEY);
    expect(value).not.toContain("secret");
  });
});
