import { expect, test } from "bun:test";
import { decryptLegacyFernet } from "../src/senders";

test("decrypts legacy Python Fernet sender secrets without rewriting them", () => {
  const key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
  const token =
    "gAAAAABlU_EAS-B-lnjOo2sXmrDZ93sSyayYERMfVic2NoVCYPuq4OB67mEHKmGhyxtfSx8wi0ao6zIHpcWKu2BljsENQx01Io3yxA-om3p6CCRTd2diWZw=";
  expect(decryptLegacyFernet(token, key)).toBe("abcd efgh ijkl mnop");
  expect(() => decryptLegacyFernet(`${token.slice(0, -2)}aa`, key)).toThrow("Invalid legacy Fernet secret");
});
