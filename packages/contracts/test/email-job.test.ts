import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { EMAIL_JOB_VERSION, EmailJobSchema, parseEmailJob } from "../src";

const valid = {
  version: EMAIL_JOB_VERSION,
  messageId: "message-1",
  accountId: "account-1",
  senderId: "sender-1",
  to: ["recipient@example.com"],
  subject: "Hello",
  body: "Body",
};

describe("EmailJob", () => {
  test("accepts the existing SendPlug queue contract", () => {
    expect(Value.Check(EmailJobSchema, valid)).toBe(true);
  });

  test("normalizes legacy jobs and rejects unknown explicit versions", () => {
    const { version: _version, ...legacy } = valid;
    expect(parseEmailJob(legacy).version).toBe(1);
    expect(() => parseEmailJob({ ...valid, version: 2 })).toThrow("Invalid email job");
  });

  test("rejects multiple primary recipients", () => {
    expect(Value.Check(EmailJobSchema, { ...valid, to: ["one@example.com", "two@example.com"] })).toBe(false);
  });
});
