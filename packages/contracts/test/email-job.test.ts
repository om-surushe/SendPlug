import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { EmailJobSchema } from "../src";

const valid = {
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

  test("rejects multiple primary recipients", () => {
    expect(Value.Check(EmailJobSchema, { ...valid, to: ["one@example.com", "two@example.com"] })).toBe(false);
  });
});
