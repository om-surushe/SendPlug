import { expect, test } from "bun:test";
import { tokenDigest } from "../src/tokens";

test("matches the Python HMAC-SHA256 token digest", () => {
  expect(tokenDigest("smtp_deadbeef_fixture-token", Buffer.from("test-pepper"))).toBe(
    "ecefa6d03ff11f2f2aabafead32ccb6192694b77034d420c2d90c3b078b17bfb",
  );
});
