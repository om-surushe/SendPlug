import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export type Database = PrismaClient;

export function createDatabase(connectionString: string): Database {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export * from "./generated/prisma/client";
export * from "./identity";
export * from "./provider-crypto";
export * from "./quota";
export * from "./tokens";
