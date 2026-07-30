import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DailyQuotaExceededError,
  MessageOwnershipError,
  createApiToken,
  createDatabase,
  getOrCreateWorkOSIdentity,
  reserveQuota,
  verifyApiToken,
} from "../src";

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

  test("reuses WorkOS users and their account membership", async () => {
    const suffix = randomUUID();
    const providerSubject = `workos-${suffix}`;
    const first = await getOrCreateWorkOSIdentity(database, {
      id: providerSubject,
      email: `${suffix}@example.com`,
      firstName: "First",
    });

    try {
      const second = await getOrCreateWorkOSIdentity(database, {
        id: providerSubject,
        email: `${suffix}@example.com`,
        firstName: "Updated",
      });
      expect(second.accountId).toBe(first.accountId);
      expect(second.user.id).toBe(first.user.id);
      expect(second.user.name).toBe("Updated");
      expect(await database.membership.count({ where: { userId: first.user.id } })).toBe(1);
    } finally {
      await database.membership.deleteMany({ where: { userId: first.user.id } });
      await database.account.delete({ where: { id: first.accountId } });
      await database.user.delete({ where: { id: first.user.id } });
    }
  });

  test("creates and verifies sender-scoped API tokens", async () => {
    const suffix = randomUUID();
    const accountId = `token-account-${suffix}`;
    const senderId = `token-sender-${suffix}`;
    const pepper = Buffer.from("integration-pepper");
    await database.account.create({ data: { id: accountId, name: "Token account" } });
    await database.sender.create({
      data: {
        id: senderId,
        accountId,
        name: "Token sender",
        email: `token-${suffix}@example.com`,
      },
    });

    try {
      const created = await createApiToken(
        database,
        accountId,
        { name: "Integration token", scopes: ["status", "send", "send"], senderId },
        pepper,
      );
      expect(created.raw.startsWith(`${created.token.prefix}_`)).toBe(true);
      expect(created.token.scopes).toEqual(["send", "status"]);
      expect(await verifyApiToken(database, `${created.raw}wrong`, pepper)).toBeNull();
      expect(await verifyApiToken(database, created.raw, pepper)).toMatchObject({
        purpose: "api_token",
        accountId,
        senderId,
        scopes: ["send", "status"],
      });
      await database.apiToken.update({ where: { id: created.token.id }, data: { revokedAt: new Date() } });
      expect(await verifyApiToken(database, created.raw, pepper)).toBeNull();
    } finally {
      await database.apiToken.deleteMany({ where: { sender: { accountId } } });
      await database.sender.deleteMany({ where: { accountId } });
      await database.account.delete({ where: { id: accountId } });
    }
  });

  test("serializes concurrent quota reservations", async () => {
    const suffix = randomUUID();
    const accountId = `quota-account-${suffix}`;
    const senderId = `quota-sender-${suffix}`;
    await database.account.create({ data: { id: accountId, name: "Quota account" } });
    await database.sender.create({
      data: {
        id: senderId,
        accountId,
        name: "Quota sender",
        email: `quota-${suffix}@example.com`,
        dailyLimit: 1,
      },
    });

    try {
      const attempts = await Promise.allSettled([
        reserveQuota(database, senderId, `message-a-${suffix}`, 1),
        reserveQuota(database, senderId, `message-b-${suffix}`, 1),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DailyQuotaExceededError);

      const reserved = await database.quotaReservation.findFirstOrThrow({ where: { senderId } });
      expect(await reserveQuota(database, senderId, reserved.messageId, 1)).toBe(1);

      const other = await database.sender.create({
        data: {
          id: `other-sender-${suffix}`,
          accountId,
          name: "Other sender",
          email: `other-${suffix}@example.com`,
        },
      });
      await expect(reserveQuota(database, other.id, reserved.messageId, 1)).rejects.toBeInstanceOf(
        MessageOwnershipError,
      );
    } finally {
      await database.quotaReservation.deleteMany({ where: { sender: { accountId } } });
      await database.sender.deleteMany({ where: { accountId } });
      await database.account.delete({ where: { id: accountId } });
    }
  });
});
