import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Prisma integration tests");
const database = createDatabase(databaseUrl);

afterAll(() => database.$disconnect());

describe("Prisma account ownership", () => {
  test("persists account, user, and membership relations transactionally", async () => {
    const suffix = randomUUID();
    const accountId = `account_${suffix}`;
    const userId = `user_${suffix}`;
    const rollback = new Error("rollback-test-data");

    await expect(
      database.$transaction(async (tx) => {
        await tx.account.create({ data: { id: accountId, name: "Integration account" } });
        await tx.user.create({
          data: {
            id: userId,
            provider: "workos",
            providerSubject: `workos_${suffix}`,
            email: `${suffix}@example.com`,
            name: "Integration user",
            lastLoginAt: new Date(),
          },
        });
        await tx.membership.create({
          data: { accountId, userId, role: "OWNER" },
        });
        const account = await tx.account.findUniqueOrThrow({
          where: { id: accountId },
          include: { memberships: { include: { user: true } } },
        });
        expect(account.memberships[0]?.user.email).toBe(`${suffix}@example.com`);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await database.account.findUnique({ where: { id: accountId } })).toBeNull();
  });

  test("rejects cross-account delivery ownership", async () => {
    const suffix = randomUUID();
    await expect(
      database.$transaction(async (tx) => {
        await tx.account.createMany({
          data: [
            { id: `account-a-${suffix}`, name: "A" },
            { id: `account-b-${suffix}`, name: "B" },
          ],
        });
        await tx.sender.create({
          data: {
            id: `sender-${suffix}`,
            accountId: `account-a-${suffix}`,
            name: "Sender",
            email: `sender-${suffix}@example.com`,
          },
        });
        await tx.delivery.create({
          data: {
            messageId: `message-${suffix}`,
            accountId: `account-b-${suffix}`,
            senderId: `sender-${suffix}`,
            recipients: ["recipient@example.com"],
            subject: "Ownership check",
          },
        });
      }),
    ).rejects.toThrow();
  });

  test("rejects cross-account Gmail connections", async () => {
    const suffix = randomUUID();
    await expect(
      database.$transaction(async (tx) => {
        await tx.account.createMany({
          data: [
            { id: `account-a-${suffix}`, name: "A" },
            { id: `account-b-${suffix}`, name: "B" },
          ],
        });
        await tx.gmailConnection.create({
          data: {
            id: `gmail-${suffix}`,
            accountId: `account-a-${suffix}`,
            googleSubject: `google-${suffix}`,
            email: `gmail-${suffix}@example.com`,
            encryptedRefreshToken: new Uint8Array([1]),
            scopes: ["https://www.googleapis.com/auth/gmail.send"],
          },
        });
        await tx.sender.create({
          data: {
            id: `sender-${suffix}`,
            accountId: `account-b-${suffix}`,
            gmailConnectionId: `gmail-${suffix}`,
            name: "Sender",
            email: `sender-${suffix}@example.com`,
          },
        });
      }),
    ).rejects.toThrow();
  });
});
