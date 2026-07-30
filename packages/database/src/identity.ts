import { randomUUID } from "node:crypto";
import type { Database } from "./index";

export type WorkOSIdentity = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export async function getOrCreateWorkOSIdentity(database: Database, profile: WorkOSIdentity) {
  const email = profile.email.trim().toLowerCase();
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || email;

  return database.$transaction(async (tx) => {
    let user = await tx.user.findUnique({
      where: { provider_providerSubject: { provider: "workos", providerSubject: profile.id } },
    });
    if (user) {
      user = await tx.user.update({
        where: { id: user.id },
        data: { email, name, lastLoginAt: new Date() },
      });
      const membership = await tx.membership.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      });
      if (membership) return { accountId: membership.accountId, user };
    }

    const suffix = randomUUID().replaceAll("-", "");
    const account = await tx.account.create({
      data: { id: `account_${suffix}`, name: name === email ? "My SendPlug account" : `${name}'s SendPlug` },
    });
    if (!user) {
      user = await tx.user.create({
        data: {
          id: `user_${suffix}`,
          provider: "workos",
          providerSubject: profile.id,
          email,
          name,
          lastLoginAt: new Date(),
        },
      });
    }
    await tx.membership.create({
      data: { accountId: account.id, userId: user.id, role: "OWNER" },
    });
    return { accountId: account.id, user };
  });
}
