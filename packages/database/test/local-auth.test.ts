import { describe, expect, test } from "bun:test";
import { hashLocalPassword, sessionTokenDigest, verifyLocalPassword } from "../src/local-auth";

describe("local password security", () => {
  test("stores salted scrypt hashes and verifies without plaintext", async () => {
    const first = await hashLocalPassword("correct horse battery staple");
    const second = await hashLocalPassword("correct horse battery staple");

    expect(first).toStartWith("scrypt$16384$8$1$");
    expect(first).not.toContain("correct horse battery staple");
    expect(second).not.toBe(first);
    expect(await verifyLocalPassword("correct horse battery staple", first)).toBe(true);
    expect(await verifyLocalPassword("wrong password", first)).toBe(false);
  });

  test("rejects malformed hashes and short passwords", async () => {
    await expect(hashLocalPassword("short")).rejects.toThrow("at least 8");
    expect(await verifyLocalPassword("anything", "not-a-password-hash")).toBe(false);
  });

  test("uses stable opaque session digests", () => {
    expect(sessionTokenDigest("session_fixture")).toBe(
      "72b492e05670be38e3e53393d5ee296c6c8c66dfe0e005740c6683c4bda95d70",
    );
  });
});
