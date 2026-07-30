import { describe, expect, test } from "bun:test";
import { decryptProviderToken, encryptProviderToken } from "../src/provider-crypto";

const key = Buffer.alloc(32, 7);

describe("provider token encryption", () => {
  test("round-trips only with the bound account context", () => {
    const encrypted = encryptProviderToken("refresh-token", key, "account-1:provider-1");
    expect(decryptProviderToken(encrypted, key, "account-1:provider-1")).toBe("refresh-token");
    expect(() => decryptProviderToken(encrypted, key, "account-2:provider-1")).toThrow();
  });

  test("rejects tampered ciphertext", () => {
    const encrypted = encryptProviderToken("refresh-token", key, "account-1:provider-1");
    encrypted[encrypted.length - 1]! ^= 1;
    expect(() => decryptProviderToken(encrypted, key, "account-1:provider-1")).toThrow();
  });
});
